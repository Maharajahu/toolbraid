import assert from 'node:assert/strict';
import test from 'node:test';

import { createMediaHandleStore } from '../../src/multimodal/index.js';

test('media handle store enforces byte/handle limits and expires entries without persistence', () => {
  let now = 1_000;
  const store = createMediaHandleStore({
    maxBytes: 4,
    maxHandles: 1,
    ttlMs: 10,
    now: () => now,
    randomSource: { randomUUID: () => 'store-test' },
  });
  const record = store.put(new Uint8Array([1, 2, 3]), { kind: 'image', sensitive: true });
  assert.equal(store.has(record.handle), true);
  assert.deepEqual([...store.get(record.handle).bytes], [1, 2, 3]);
  assert.throws(() => store.put(new Uint8Array([4, 5])), /limit/i);
  now = 1_010;
  assert.equal(store.get(record.handle), null);
  assert.equal(store.stats().handles, 0);
  assert.equal(store.stats().bytes, 0);
});

test('media handle store rejects oversized entries and copies caller-owned bytes', () => {
  const source = new Uint8Array([1, 2]);
  const store = createMediaHandleStore({
    maxBytes: 2,
    maxHandles: 2,
    ttlMs: 100,
    randomSource: { randomUUID: () => 'copy-test' },
  });
  const record = store.put(source, { kind: 'audio' });
  source[0] = 9;
  assert.deepEqual([...store.get(record.handle).bytes], [1, 2]);
  assert.throws(() => store.put(new Uint8Array([1, 2, 3])), /bytes/i);
  store.clear();
  assert.equal(store.get(record.handle), null);
});
