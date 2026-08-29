import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_APPROVAL_TTL_MS,
  PROVENANCE,
  createApprovalStore,
  fingerprintAction,
} from '../../extension/approval-store.js';

function memoryStorage() {
  const data = {};
  return {
    data,
    async get(key) { return { [key]: data[key] }; },
    async set(value) { Object.assign(data, value); },
    async remove(key) { delete data[key]; },
  };
}

function callbackStorage() {
  const data = {};
  return {
    data,
    get(key, callback) { callback({ [key]: data[key] }); },
    set(value, callback) { Object.assign(data, value); callback(); },
    remove(key, callback) { delete data[key]; callback(); },
  };
}

function fakeCrypto() {
  let sequence = 0;
  return {
    randomUUID: () => `nonce-${String(++sequence).padStart(28, '0')}`,
    subtle: globalThis.crypto.subtle,
    getRandomValues(bytes) { bytes.fill(0x24); return bytes; },
  };
}

const trusted = { isTrusted: true };
const synthetic = { isTrusted: false };
const action = {
  tabId: 12,
  frameId: 0,
  sessionId: 'tab-12-session-checkout',
  origin: 'https://shop.example.test',
  pageFingerprint: 'a'.repeat(64),
  target: { ref: 'form-checkout', targetFingerprint: 'b'.repeat(64) },
  actionId: 'action-1',
  tool: { name: 'checkout.submit' },
  arguments: { email: 'operator@example.test' },
  effect: { classification: 'mutate', summary: 'Submit order.' },
  risk: 'high',
};

test('approval store requires a trusted activation and persists exact approval scope', async () => {
  const storage = memoryStorage();
  const store = createApprovalStore({ storageArea: storage, cryptoRef: fakeCrypto(), now: () => 1000 });
  await assert.rejects(
    () => store.createApproval({ event: synthetic, action }),
    (error) => error.code === 'TRUSTED_ACTIVATION_REQUIRED',
  );
  assert.deepEqual(storage.data, {});

  const record = await store.createApproval({ event: trusted, action });
  assert.equal(record.provenance, PROVENANCE);
  assert.equal(record.state, 'approved');
  assert.match(record.nonce, /^nonce-/);
  assert.equal(record.expiresAt - record.createdAt, DEFAULT_APPROVAL_TTL_MS);
  assert.equal(record.scope.pageFingerprint, action.pageFingerprint);
  assert.equal((await store.get(record.id)).fingerprint, record.fingerprint);
  assert.equal((await store.list()).length, 1);
});

test('approval fingerprint changes when exact authority, arguments, target, or effect changes', async () => {
  const first = await fingerprintAction(action);
  const changedTab = await fingerprintAction({ ...action, tabId: 13 });
  const changedFrame = await fingerprintAction({ ...action, frameId: 2 });
  const changedSession = await fingerprintAction({ ...action, sessionId: 'tab-12-session-replaced' });
  const changedOrigin = await fingerprintAction({ ...action, origin: 'https://other.example.test' });
  const changedArguments = await fingerprintAction({ ...action, arguments: { email: 'other@example.test' } });
  const changedTarget = await fingerprintAction({ ...action, target: { ref: 'different', targetFingerprint: 'c'.repeat(64) } });
  const changedEffect = await fingerprintAction({ ...action, effect: { classification: 'mutate', summary: 'Delete order.' } });
  assert.notEqual(first, changedTab);
  assert.notEqual(first, changedFrame);
  assert.notEqual(first, changedSession);
  assert.notEqual(first, changedOrigin);
  assert.notEqual(first, changedArguments);
  assert.notEqual(first, changedTarget);
  assert.notEqual(first, changedEffect);
});

test('approval store rejects prepared actions without an exact authority binding', async () => {
  const store = createApprovalStore({ storageArea: memoryStorage(), cryptoRef: fakeCrypto() });
  const { sessionId: _sessionId, ...unbound } = action;
  await assert.rejects(
    () => store.createApproval({ event: trusted, action: unbound }),
    (error) => error.code === 'ACTION_BINDING_REQUIRED',
  );
});

test('expired approvals disappear and cannot be executed or denied', async () => {
  const storage = memoryStorage();
  let now = 1000;
  const store = createApprovalStore({ storageArea: storage, cryptoRef: fakeCrypto(), now: () => now });
  const record = await store.createApproval({ event: trusted, action, ttlMs: 100 });
  now = 1100;
  assert.equal(await store.get(record.id), null);
  assert.deepEqual(await store.list(), []);
  await assert.rejects(() => store.prepareExecution(record.id, trusted), (error) => error.code === 'APPROVAL_NOT_FOUND');
  await assert.rejects(() => store.deny(record.id, trusted), (error) => error.code === 'APPROVAL_NOT_FOUND');
});

test('approval transitions still require trusted events and execute only after explicit success', async () => {
  const store = createApprovalStore({ storageArea: memoryStorage(), cryptoRef: fakeCrypto() });
  const record = await store.createApproval({ event: trusted, action });
  await assert.rejects(() => store.prepareExecution(record.id, synthetic), (error) => error.code === 'TRUSTED_ACTIVATION_REQUIRED');
  const prepared = await store.prepareExecution(record.id, trusted);
  assert.equal(prepared.state, 'approved');
  const executed = await store.markExecuted(record.id, trusted);
  assert.equal(executed.state, 'executed');
  await assert.rejects(() => store.prepareExecution(record.id, trusted), (error) => error.code === 'APPROVAL_STATE_INVALID');
});

test('approval store supports callback-style chrome.storage.local mocks', async () => {
  const store = createApprovalStore({ storageArea: callbackStorage(), cryptoRef: fakeCrypto() });
  const record = await store.approve({ event: trusted, action });
  assert.equal((await store.get(record.id)).id, record.id);
  await store.clear();
  assert.deepEqual(await store.list(), []);
});
