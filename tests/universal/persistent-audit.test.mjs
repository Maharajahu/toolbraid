import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PersistentAuditError,
  createChromeStorageAdapter,
  createMemoryKeyValueStore,
  createPersistentAuditTrail,
} from '../../src/persistence/index.js';

test('persists and resumes a verified audit chain across runtime instances', async () => {
  const store = createMemoryKeyValueStore();
  let tick = 0;
  const options = {
    store,
    key: 'audit:tab-1',
    now: () => new Date(Date.parse('2026-08-29T00:00:00.000Z') + tick++ * 1000),
  };
  const first = await createPersistentAuditTrail(options);
  const one = await first.append('page.observed', { origin: 'https://example.test' });
  const second = await createPersistentAuditTrail(options);
  const two = await second.append('action.prepared', { action: 'submit_form' });

  assert.equal(two.sequence, 2);
  assert.equal(two.previousHash, one.hash);
  assert.equal(await second.verify(), true);
  assert.equal((await second.entries()).length, 2);
});

test('serializes concurrent appends and persists a final seal', async () => {
  const store = createMemoryKeyValueStore();
  const trail = await createPersistentAuditTrail({
    store,
    key: 'audit:concurrent',
    now: () => new Date('2026-08-29T00:00:00.000Z'),
  });
  await Promise.all(Array.from({ length: 20 }, (_, index) => trail.append('event', { index })));
  const entries = await trail.entries();
  assert.deepEqual(entries.map((entry) => entry.sequence), Array.from({ length: 20 }, (_, index) => index + 1));
  const seal = await trail.seal();
  assert.equal(seal.entries, 20);
  assert.deepEqual(await trail.status(), { sealed: true, entries: 20, head: seal.head });
  await assert.rejects(trail.append('late'), (error) => error instanceof PersistentAuditError && error.code === 'AUDIT_ALREADY_SEALED');

  const resumed = await createPersistentAuditTrail({ store, key: 'audit:concurrent' });
  assert.deepEqual(await resumed.seal(), seal);
});

test('fails closed when persisted entries or the seal are modified', async () => {
  const store = createMemoryKeyValueStore();
  const trail = await createPersistentAuditTrail({ store, key: 'audit:tamper' });
  await trail.append('action.dispatched', { target: 'checkout', postcondition: 'unverified' });
  const record = await store.get('audit:tamper');
  record.entries[0].details.target = 'attacker';
  await store.set('audit:tamper', record);

  await assert.rejects(
    createPersistentAuditTrail({ store, key: 'audit:tamper' }),
    (error) => error instanceof PersistentAuditError && error.code === 'AUDIT_CHAIN_TAMPERED',
  );
});

test('wraps chrome.storage areas without leaking mutable references', async () => {
  const state = {};
  const area = {
    async get(key) { return { [key]: state[key] }; },
    async set(values) { Object.assign(state, values); },
    async remove(key) { delete state[key]; },
  };
  const store = createChromeStorageAdapter(area);
  const input = { nested: { value: 1 } };
  await store.set('session', input);
  input.nested.value = 2;
  const loaded = await store.get('session');
  assert.equal(loaded.nested.value, 1);
  loaded.nested.value = 3;
  assert.equal((await store.get('session')).nested.value, 1);
});
