import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { UI_MESSAGE_TYPES, createUiController, normalizeState, sendUiMessage } from '../../extension/sidepanel.js';
import { createApprovalStore, PROVENANCE, sha256Hex } from '../../extension/approval-store.js';

const manifest = JSON.parse(await readFile(new URL('../../extension/manifest.json', import.meta.url), 'utf8'));
const html = await readFile(new URL('../../extension/sidepanel.html', import.meta.url), 'utf8');
const js = await readFile(new URL('../../extension/sidepanel.js', import.meta.url), 'utf8');

function memoryStorage() {
  const data = {};
  return {
    data,
    async get(key) { return { [key]: data[key] }; },
    async set(value) { Object.assign(data, value); },
    async remove(key) { delete data[key]; },
  };
}

function fakeCrypto() {
  let sequence = 0;
  return {
    randomUUID: () => `nonce-${String(++sequence).padStart(28, '0')}`,
    subtle: globalThis.crypto.subtle,
    getRandomValues(bytes) { bytes.fill(0x42); return bytes; },
  };
}

const trustedClick = { isTrusted: true };
const syntheticClick = { isTrusted: false };

test('side panel permission surface is explicit and points to its default document', () => {
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(new Set(manifest.permissions), new Set(['activeTab', 'scripting', 'storage', 'sidePanel']));
  assert.deepEqual(manifest.side_panel, { default_path: 'sidepanel.html' });
  assert.equal('host_permissions' in manifest, false);
  assert.equal('externally_connectable' in manifest, false);
});

test('side panel has extension CSP, no inline script, and renders through safe DOM APIs', () => {
  assert.match(html, /Content-Security-Policy/);
  assert.match(html, /script-src 'self'; style-src 'self'; object-src 'none'/);
  assert.match(html, /<script type="module" src="sidepanel\.js"><\/script>/);
  assert.doesNotMatch(html, /<script>[^<]+/i);
  assert.doesNotMatch(js, /\.innerHTML\s*=/);
  assert.match(js, /textContent/);
  assert.match(js, /isTrusted\s*===\s*true/);
  assert.match(html, /id="evidence-list"/);
  assert.match(html, /id="receipts-list"/);
  assert.match(html, /id="audit-list"/);
  assert.match(html, /id="missions-list"/);
  assert.match(html, /id="handoffs-list"/);
  assert.doesNotMatch(js, /Execute approved action|Action executed\./);
  assert.match(js, /Dispatch approved action/);
  assert.match(js, /postcondition unverified/i);
});

test('normalizes multimodal evidence, execution receipts, and verified audit proof as untrusted display data', () => {
  const state = normalizeState({
    connection: 'ready',
    tab: { id: 2, url: 'https://example.test/' },
    multimodal: {
      stats: { total: 1, completed: 1, degraded: 0, blocked: 0 },
      results: [{ assetId: 'asset-1', kind: 'image', status: 'completed', text: '<img onerror=attack()>', provider: { id: 'vision-local' }, confidence: 0.8 }],
    },
    capture: { warnings: ['SCREENSHOT_UNAVAILABLE'] },
    receipts: [{ actionId: 'action-1', mode: 'mutation', receipt: { operation: 'submit', ref: 'form-1', events: ['input', 'submit'] }, approvalClaim: { fingerprint: 'f'.repeat(64) } }],
    audit: { verified: true, count: 1, head: 'a'.repeat(64), entries: [{ sequence: 1, event: 'action.executed', hash: 'a'.repeat(64) }] },
    quarantined: [{ name: 'hostile' }],
  });
  assert.equal(state.evidence.items[0].summary, '<img onerror=attack()>');
  assert.deepEqual(state.evidence.warnings, ['SCREENSHOT_UNAVAILABLE']);
  assert.equal(state.receipts[0].operation, 'submit');
  assert.equal(state.receipts[0].status, 'dispatched');
  assert.equal(state.receipts[0].outcome, 'postcondition-unverified');
  assert.equal(state.audit.verified, true);
  assert.equal(state.audit.entries[0].event, 'action.dispatched');
  assert.equal(state.quarantinedCount, 1);
});

test('normalizes mission and handoff state without exposing credentials, proofs, or raw URLs', () => {
  const state = normalizeState({
    connection: 'ready',
    missions: [{
      missionId: 'mission-1',
      phase: 'running',
      revision: 2,
      members: [{ memberId: 'member-1', tabId: 4, frameId: 0, origin: 'https://example.test', status: 'attached' }],
      credentials: { password: 'secret-password' },
    }],
    handoffs: [{
      handoffId: 'handoff-1',
      type: 'login',
      state: 'awaiting-ui-gesture',
      missionId: 'mission-1',
      memberId: 'member-1',
      purpose: '<img onerror=attack()>',
      safeOrigin: 'https://example.test/login?token=secret#fragment',
      credentials: { password: 'secret-password' },
      uiIntent: { token: 'secret-token' },
      completionProof: { token: 'secret-proof' },
      surface: { url: 'https://example.test/login?token=secret' },
    }],
  });
  assert.equal(state.missions[0].members[0].origin, 'https://example.test');
  assert.equal(state.handoffs[0].safeOrigin, 'https://example.test');
  assert.equal(state.handoffs[0].purpose, '<img onerror=attack()>');
  const serialized = JSON.stringify({ missions: state.missions, handoffs: state.handoffs });
  for (const secret of ['secret-password', 'secret-token', 'secret-proof', '/login', '?token=', '#fragment']) {
    assert.equal(serialized.includes(secret), false);
  }
});

test('UI client allows only declared messages and fails closed without the worker', async () => {
  const unknown = await sendUiMessage('UI_DELETE_EVERYTHING', {});
  assert.equal(unknown.ok, false);
  assert.equal(unknown.error.code, 'UI_MESSAGE_TYPE_INVALID');
  const missing = await sendUiMessage(UI_MESSAGE_TYPES.UI_GET_STATE, {}, null);
  assert.equal(missing.ok, false);
  assert.equal(missing.error.code, 'BRIDGE_UNAVAILABLE');

  const calls = [];
  const response = await sendUiMessage(UI_MESSAGE_TYPES.UI_GET_STATE, { ignored: '<page text>' }, {
    sendMessage(message) {
      calls.push(message);
      return Promise.resolve({ ok: false, error: { code: 'NOT_INTEGRATED', message: 'Worker integration pending.' } });
    },
  });
  assert.equal(response.ok, false);
  assert.equal(response.error.code, 'NOT_INTEGRATED');
  assert.deepEqual(calls, [{ type: UI_MESSAGE_TYPES.UI_GET_STATE, payload: { ignored: '<page text>' } }]);
});

test('controller keeps generated/native state distinguishable and rejects synthetic approval', async () => {
  const storage = memoryStorage();
  const store = createApprovalStore({ storageArea: storage, cryptoRef: fakeCrypto() });
  const calls = [];
  const runtime = {
    sendMessage(message) {
      calls.push(message);
      if (message.type === UI_MESSAGE_TYPES.UI_GET_STATE) {
        return Promise.resolve({
          ok: true,
          state: {
            connection: 'ready',
            tab: { id: 4, url: 'https://example.test/checkout', title: 'Checkout' },
            tools: [
              { name: 'native.lookup', description: 'Native tool' },
              { name: 'generated.submit', description: '<script>page text</script>', provenance: PROVENANCE },
            ],
            actions: [{ id: 'generated.submit', title: 'Submit order', classification: 'mutate', inputSchema: { type: 'object', properties: {} } }],
            snapshot: { pageFingerprint: 'a'.repeat(64) },
          },
        });
      }
      if (message.type === UI_MESSAGE_TYPES.UI_PREPARE_ACTION) {
        return Promise.resolve({
          ok: true,
          preparedAction: {
            ...message.payload,
            tabId: 4,
            frameId: 0,
            sessionId: 'tab-4-session-checkout',
            origin: 'https://example.test',
            effect: { summary: 'Submit order.' },
          },
        });
      }
      return Promise.resolve({ ok: false, error: { code: 'NOT_INTEGRATED', message: 'Worker integration pending.' } });
    },
  };
  const controller = createUiController({ runtime, store });
  const state = await controller.refresh();
  assert.equal(state.connection, 'ready');
  assert.deepEqual(state.tools.map((tool) => tool.kind), ['native', 'generated']);
  assert.equal(state.tools[1].description, '<script>page text</script>');
  const prepared = await controller.prepareAction('generated.submit', {});
  assert.equal(prepared.ok, true);
  const blocked = await controller.approveAction(prepared.preparedAction, syntheticClick);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.error.code, 'TRUSTED_ACTIVATION_REQUIRED');
  const pending = await controller.approveAction(prepared.preparedAction, trustedClick);
  assert.equal(pending.ok, false);
  assert.equal(pending.error.code, 'NOT_INTEGRATED');
  assert.ok(pending.approval);
  assert.equal((await store.list()).length, 1);
  assert.equal(calls.at(-1).type, UI_MESSAGE_TYPES.UI_APPROVE_ACTION);
});

test('controller never marks a local approval executed after a fail-closed worker response', async () => {
  const store = createApprovalStore({ storageArea: memoryStorage(), cryptoRef: fakeCrypto() });
  const action = {
    id: 'read.current',
    name: 'Read current page',
    tabId: 4,
    frameId: 0,
    sessionId: 'tab-4-session-current',
    origin: 'https://example.test',
    arguments: {},
    effect: { summary: 'No external change.' },
  };
  const approval = await store.createApproval({ event: trustedClick, action });
  const controller = createUiController({
    store,
    runtime: { sendMessage: () => Promise.resolve({ ok: false, error: { code: 'EXECUTOR_UNAVAILABLE', message: 'No worker executor.' } }) },
  });
  const response = await controller.executeApproval(approval.id, trustedClick);
  assert.equal(response.ok, false);
  assert.equal(response.error.code, 'EXECUTOR_UNAVAILABLE');
  assert.equal((await store.get(approval.id)).state, 'approved');
});

test('trusted handoff opens the exact-origin window in the sidepanel and sends only its tab id to the worker', async () => {
  const calls = { permissions: [], windows: [], worker: [], removed: [] };
  const runtime = {
    sendMessage(message) {
      calls.worker.push(structuredClone(message));
      if (message.type === UI_MESSAGE_TYPES.UI_GET_STATE) {
        return Promise.resolve({
          ok: true,
          state: {
            connection: 'ready',
            tab: { id: 4, url: 'https://example.test/page' },
            handoffs: [{
              handoffId: 'handoff-sidepanel',
              type: 'login',
              state: 'awaiting-ui-gesture',
              missionId: 'mission-sidepanel',
              memberId: 'member-sidepanel',
              purpose: 'Sign in.',
              safeOrigin: 'https://example.test',
            }],
          },
        });
      }
      return Promise.resolve({ ok: true, result: { state: 'human-active' } });
    },
  };
  const browser = {
    runtime: {},
    permissions: {
      async request(value) { calls.permissions.push(structuredClone(value)); return true; },
    },
    windows: {
      async create(value) { calls.windows.push(structuredClone(value)); return { id: 8, tabs: [{ id: 101 }] }; },
      async remove(windowId) { calls.removed.push(windowId); },
    },
    tabs: { async query() { return [{ id: 101 }]; } },
  };
  const controller = createUiController({
    runtime,
    browser,
    store: createApprovalStore({ storageArea: memoryStorage(), cryptoRef: fakeCrypto() }),
  });
  await controller.refresh();

  const blocked = await controller.openHandoff('handoff-sidepanel', syntheticClick);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.error.code, 'TRUSTED_ACTIVATION_REQUIRED');
  assert.equal(calls.windows.length, 0);

  const opened = await controller.openHandoff('handoff-sidepanel', trustedClick);
  assert.equal(opened.ok, true);
  assert.deepEqual(calls.permissions, [{ origins: ['https://example.test/*'] }]);
  assert.deepEqual(calls.windows, [{
    url: 'https://example.test',
    type: 'popup',
    focused: true,
    width: 520,
    height: 720,
  }]);
  assert.deepEqual(calls.worker.at(-1), {
    type: UI_MESSAGE_TYPES.UI_HANDOFF_OPEN_SURFACE,
    payload: { handoffId: 'handoff-sidepanel', surfaceTabId: 101 },
  });
  assert.deepEqual(calls.removed, []);

  const completed = await controller.completeHandoff('handoff-sidepanel', trustedClick);
  assert.equal(completed.ok, true);
  assert.deepEqual(calls.worker.at(-1), {
    type: UI_MESSAGE_TYPES.UI_HANDOFF_COMPLETE,
    payload: { handoffId: 'handoff-sidepanel' },
  });
});

test('SHA-256 helper returns the standard digest used for approval bindings', async () => {
  assert.equal(await sha256Hex('abc', fakeCrypto()), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});
