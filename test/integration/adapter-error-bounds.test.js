import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ADAPTER_ERROR_LIMITS,
  createAdapterError,
  normalizeAdapterError,
} from '../../src/adapters/index.js';
import { createCoreServices } from '../../src/runtime/services.js';

const ORIGIN = 'https://shop.example.test';

function request(adapter) {
  return {
    adapter: adapter.id,
    capabilityId: 'orders.read',
    args: {},
    origin: ORIGIN,
    tenantId: 'tenant-acme',
    subjectId: 'user-alice',
    workflowId: 'error-bounds',
    revision: 1,
    nodeId: 'error-node',
    readOnly: true,
    replay: false,
  };
}

function assertBoundedProviderError(error) {
  assert.equal(error instanceof Error, true);
  assert.equal(error.code, 'ADAPTER_EXECUTION_FAILED');
  assert.equal(error.message, 'Adapter execution failed.');
  assert.equal(error.message.length <= ADAPTER_ERROR_LIMITS.maxMessageLength, true);
  assert.equal(error.details, undefined);
  return true;
}

test('legacy provider 5MiB error envelopes are replaced before the broker', async () => {
  const message = 'x'.repeat(5 * 1024 * 1024);
  const adapter = {
    id: 'legacy-orders',
    origin: ORIGIN,
    invoke() {
      return { ok: false, error: { message } };
    },
  };
  const services = createCoreServices({ adapters: [adapter] });

  await assert.rejects(
    services.adapterIndex.get(adapter.id).execute(request(adapter)),
    assertBoundedProviderError,
  );
});

test('typed provider 5MiB error envelopes are replaced before the broker', async () => {
  const message = 'x'.repeat(5 * 1024 * 1024);
  const adapter = {
    id: 'typed-orders',
    origin: ORIGIN,
    execute() {
      return { ok: false, error: { message } };
    },
  };
  const services = createCoreServices({ adapters: [adapter] });

  await assert.rejects(
    services.adapterIndex.get(adapter.id).execute(request(adapter)),
    assertBoundedProviderError,
  );
});

test('adapter error normalization bounds identifiers and redacts message secrets', () => {
  const normalized = normalizeAdapterError({
    error: {
      code: `${'x'.repeat(ADAPTER_ERROR_LIMITS.maxCodeLength + 1)}`,
      message: 'token=top-secret\u0000 Bearer bearer-secret',
      retryable: true,
      details: { safe: 'value' },
    },
  });
  assert.equal(normalized.code, 'ADAPTER_EXECUTION_FAILED');
  assert.equal(normalized.message.includes('top-secret'), false);
  assert.equal(normalized.message.includes('bearer-secret'), false);
  assert.equal(/[\u0000-\u001f\u007f-\u009f]/u.test(normalized.message), false);
  assert.equal(normalized.retryable, true);
  assert.deepEqual(normalized.details, { safe: 'value' });
  assert.equal(createAdapterError({ message: 'x'.repeat(5 * 1024 * 1024) }).message.length <= ADAPTER_ERROR_LIMITS.maxMessageLength, true);
});
