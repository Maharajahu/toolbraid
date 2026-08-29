import assert from 'node:assert/strict';
import test from 'node:test';

import { createApprovalEnvelope } from '../../src/engine/approval.js';
import {
  PersistentApprovalError,
  createMemoryKeyValueStore,
  createPersistentApprovalLedger,
} from '../../src/persistence/index.js';

let nonceCounter = 0;

function approvalContext(overrides = {}) {
  return {
    planId: 'tab-7:https://example.test',
    planRevision: 3,
    nodeId: 'submit:checkout-form',
    toolOrigin: 'https://example.test',
    toolName: 'execute_approved_page_action',
    toolSchemaFingerprint: 'a'.repeat(64),
    canonicalCapability: 'page.action.submit',
    normalizedArguments: {
      tabId: 7,
      pageFingerprint: 'b'.repeat(64),
      targetFingerprint: 'c'.repeat(64),
      fields: { email: 'user@example.test' },
    },
    effectSummary: 'Submit checkout form on example.test',
    risk: 2,
    ...overrides,
  };
}

function envelope(context, nonce = `persistent-nonce-${++nonceCounter}`, expiresAt = '2026-08-29T01:00:00.000Z') {
  return createApprovalEnvelope(context, {
    nonce,
    now: new Date('2026-08-29T00:00:00.000Z'),
    expiresAt: new Date(expiresAt),
  });
}

test('persists approval consumption across service-worker-style restarts', async () => {
  const store = createMemoryKeyValueStore();
  const now = () => new Date('2026-08-29T00:01:00.000Z');
  const expected = approvalContext();
  const approved = envelope(expected);
  const first = await createPersistentApprovalLedger({ store, now });
  const claim = await first.claim(approved, expected, { now: new Date('2026-08-29T00:01:00.000Z') });
  assert.equal(claim.nonce, approved.nonce);

  const restarted = await createPersistentApprovalLedger({ store, now });
  assert.equal(await restarted.has(approved.nonce), true);
  await assert.rejects(
    restarted.claim(approved, expected, { now: new Date('2026-08-29T00:02:00.000Z') }),
    (error) => error instanceof PersistentApprovalError && error.code === 'APPROVAL_REPLAY_PERSISTED',
  );
});

test('claims an exact set durably or records none when validation fails', async () => {
  const store = createMemoryKeyValueStore();
  const ledger = await createPersistentApprovalLedger({
    store,
    key: 'set-ledger',
    now: () => new Date('2026-08-29T00:02:00.000Z'),
  });
  const firstContext = approvalContext({ nodeId: 'publish-one' });
  const secondContext = approvalContext({ nodeId: 'publish-two' });
  const first = envelope(firstContext);
  const second = envelope(secondContext);

  await assert.rejects(
    ledger.claimSet([
      { envelope: first, expected: firstContext },
      { envelope: second, expected: { ...secondContext, effectSummary: 'tampered' } },
    ], { now: new Date('2026-08-29T00:01:00.000Z') }),
    /effect/i,
  );
  assert.equal((await ledger.claims()).length, 0);

  const receipts = await ledger.claimSet([
    { envelope: first, expected: firstContext },
    { envelope: second, expected: secondContext },
  ], { now: new Date('2026-08-29T00:02:00.000Z') });
  assert.equal(receipts.length, 2);
  assert.equal((await ledger.claims()).length, 2);
});

test('detects modified persistent claim records', async () => {
  const store = createMemoryKeyValueStore();
  const expected = approvalContext();
  const approved = envelope(expected);
  const ledger = await createPersistentApprovalLedger({ store, key: 'tampered-ledger' });
  await ledger.claim(approved, expected, { now: new Date('2026-08-29T00:01:00.000Z') });
  const record = await store.get('tampered-ledger');
  record.claims[approved.nonce].nodeId = 'attacker-node';
  await store.set('tampered-ledger', record);
  assert.equal(await ledger.verify(), false);
  await assert.rejects(
    createPersistentApprovalLedger({ store, key: 'tampered-ledger' }),
    (error) => error instanceof PersistentApprovalError && error.code === 'APPROVAL_LEDGER_TAMPERED',
  );
});

test('persists checksum-bound expiry and prunes only expired claims before capacity checks', async () => {
  const store = createMemoryKeyValueStore();
  const clock = { value: new Date('2026-08-29T00:01:00.000Z') };
  const ledger = await createPersistentApprovalLedger({
    store,
    key: 'bounded-ledger',
    maxClaims: 2,
    now: () => clock.value,
  });
  const firstContext = approvalContext({ nodeId: 'expires-first' });
  const secondContext = approvalContext({ nodeId: 'remains-live' });
  const thirdContext = approvalContext({ nodeId: 'uses-pruned-slot' });
  const first = envelope(firstContext, undefined, '2026-08-29T00:10:00.000Z');
  const second = envelope(secondContext, undefined, '2026-08-29T00:40:00.000Z');
  const third = envelope(thirdContext, undefined, '2026-08-29T00:50:00.000Z');

  await ledger.claim(first, firstContext, { now: new Date('2026-08-29T00:02:00.000Z') });
  await ledger.claim(second, secondContext, { now: new Date('2026-08-29T00:03:00.000Z') });
  const stored = await store.get('bounded-ledger');
  assert.equal(stored.claims[first.nonce].expiresAt, first.expiresAt);
  assert.match(stored.claims[first.nonce].checksum, /^[a-f0-9]{64}$/);
  await assert.rejects(
    ledger.claim(third, thirdContext, { now: new Date('2026-08-29T00:04:00.000Z') }),
    (error) => error instanceof PersistentApprovalError && error.code === 'APPROVAL_LEDGER_CAPACITY_EXCEEDED',
  );

  clock.value = new Date('2026-08-29T00:11:00.000Z');
  const claim = await ledger.claim(third, thirdContext, { now: clock.value });
  assert.equal(claim.expiresAt, third.expiresAt);
  assert.equal(await ledger.has(first.nonce, { now: clock.value }), false);
  assert.equal(await ledger.has(second.nonce, { now: clock.value }), true);
  assert.deepEqual((await ledger.claims({ now: clock.value })).map((entry) => entry.nonce).sort(), [second.nonce, third.nonce].sort());
  await assert.rejects(
    ledger.claim(second, secondContext, { now: new Date('2026-08-29T00:12:00.000Z') }),
    (error) => error instanceof PersistentApprovalError && error.code === 'APPROVAL_REPLAY_PERSISTED',
  );
  const tampered = await store.get('bounded-ledger');
  tampered.claims[second.nonce].expiresAt = '2026-08-29T00:45:00.000Z';
  await store.set('bounded-ledger', tampered);
  assert.equal(await ledger.verify(), false, 'expiresAt is part of the verified claim checksum');
});
