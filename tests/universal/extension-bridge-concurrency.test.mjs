import assert from 'node:assert/strict';
import test from 'node:test';

import { createUniversalBridge } from '../../extension/bridge.js';
import { MESSAGE_TYPES, PROVENANCE, createEnvelope } from '../../extension/protocol.js';

const SESSION = Object.freeze({
  tabId: 7,
  frameId: 0,
  sessionId: 'tab-7-bridge-concurrency',
  nonce: '12345678-1234-4234-8234-123456789abc',
});

test('uses a unique request id for each concurrent page registration', async () => {
  const pending = new Map();
  const requestIds = [];
  const bridge = createUniversalBridge({
    registry: { get: () => SESSION },
    sendToContentScript: async (_tabId, envelope) => new Promise((resolve) => {
      requestIds.push(envelope.requestId);
      pending.set(envelope.requestId, resolve);
    }),
  });

  const first = bridge.registerGeneratedTools({ ...SESSION, tools: [] });
  const second = bridge.registerGeneratedTools({ ...SESSION, tools: [] });

  assert.equal(new Set(requestIds).size, 2);
  assert.equal(pending.size, 2);
  const response = (requestId, payload = { ok: true, results: [], provenance: PROVENANCE }) => ({
    ok: true,
    envelope: createEnvelope({
      type: MESSAGE_TYPES.REGISTER_RESULT,
      ...SESSION,
      requestId,
      payload,
    }),
  });
  pending.get(requestIds[1])(response(requestIds[1]));
  pending.get(requestIds[0])(response(requestIds[0]));
  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.equal(firstResult.ok, true);
  assert.equal(secondResult.ok, true);
  assert.equal(firstResult.sessionId, SESSION.sessionId);
  assert.equal(secondResult.sessionId, SESSION.sessionId);
});

test('surfaces a bound MAIN-world registration rejection instead of publishing optimistic success', async () => {
  const bridge = createUniversalBridge({
    registry: { get: () => SESSION },
    sendToContentScript: async (_tabId, envelope) => ({
      ok: true,
      envelope: createEnvelope({
        type: MESSAGE_TYPES.REGISTER_RESULT,
        ...SESSION,
        requestId: envelope.requestId,
        payload: {
          ok: false,
          results: [{ name: 'read_x_post', ok: false }],
          error: { code: 'REGISTRATION_FAILED', message: 'Native registration failed.' },
          provenance: PROVENANCE,
        },
      }),
    }),
  });

  const result = await bridge.registerGeneratedTools({ ...SESSION, tools: [] });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'REGISTRATION_FAILED');
  assert.deepEqual(result.error.details.results, [{ name: 'read_x_post', ok: false }]);
});
