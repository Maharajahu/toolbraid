import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CURRENT_PROTOCOL_VERSION,
  createMcpGateway,
} from '../../src/mcp/index.js';

function modernCall(id, name = 'workflow.status') {
  return {
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: {
      _meta: {
        'io.modelcontextprotocol/protocolVersion': CURRENT_PROTOCOL_VERSION,
        'io.modelcontextprotocol/clientCapabilities': {},
      },
      name,
      arguments: {
        tenantId: 'tenant-a',
        subjectId: 'subject-a',
        workflowId: 'workflow-a',
      },
    },
  };
}

test('gateway rejects calls beyond the global active-call bound and releases capacity', async () => {
  let release;
  let started;
  let invocations = 0;
  const startedPromise = new Promise((resolve) => { started = resolve; });
  const blocked = new Promise((resolve) => { release = resolve; });
  const gateway = createMcpGateway({
    maxActiveCalls: 1,
    maxSessionActiveCalls: 8,
    handlers: {
      'workflow.status': async () => {
        invocations += 1;
        started();
        if (invocations === 1) await blocked;
        return { ok: true };
      },
    },
  });
  const firstSession = gateway.createSession();
  const secondSession = gateway.createSession();
  const first = gateway.handleMessage(modernCall(1), { session: firstSession });
  await startedPromise;

  const rejected = await gateway.handleMessage(modernCall(2), { session: secondSession });
  assert.equal(rejected.result.isError, true);
  assert.equal(rejected.result.structuredContent.code, 'ACTIVE_CALL_LIMIT');
  assert.equal(rejected.result.structuredContent.retryable, true);

  release();
  const completed = await first;
  assert.equal(completed.result.isError, false);

  const result = await gateway.handleMessage(modernCall(3), { session: secondSession });
  assert.equal(result.result.isError, false);
});

test('gateway applies the per-session active-call bound independently', async () => {
  let release;
  let started;
  const startedPromise = new Promise((resolve) => { started = resolve; });
  const blocked = new Promise((resolve) => { release = resolve; });
  const gateway = createMcpGateway({
    maxActiveCalls: 8,
    maxSessionActiveCalls: 1,
    handlers: {
      'workflow.status': async () => {
        started();
        await blocked;
        return { ok: true };
      },
    },
  });
  const session = gateway.createSession();
  const first = gateway.handleMessage(modernCall(10), { session });
  await startedPromise;
  const rejected = await gateway.handleMessage(modernCall(11), { session });
  assert.equal(rejected.result.structuredContent.code, 'ACTIVE_CALL_LIMIT');
  release();
  assert.equal((await first).result.isError, false);
});
