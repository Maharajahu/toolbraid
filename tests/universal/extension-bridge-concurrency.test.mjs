import assert from 'node:assert/strict';
import test from 'node:test';

import { createUniversalBridge } from '../../extension/bridge.js';

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
  pending.get(requestIds[1])({ envelope: { requestId: requestIds[1] } });
  pending.get(requestIds[0])({ envelope: { requestId: requestIds[0] } });
  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.equal(firstResult.envelope.requestId, requestIds[0]);
  assert.equal(secondResult.envelope.requestId, requestIds[1]);
});
