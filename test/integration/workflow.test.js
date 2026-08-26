import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PUBLIC_TOOL_NAMES,
  createFixtureRuntime,
} from '../../src/runtime/composition-root.js';
import { createServer } from '../../src/server.js';

const identity = {
  tenantId: 'tenant-acme',
  subject: 'user-alice',
  origin: 'https://shop.example.test',
};

test('discovery -> plan -> safe execute -> approval -> mutation -> status -> readonly replay', async () => {
  const runtime = createFixtureRuntime();

  const discovered = await runtime.callTool('capabilities.search', {
    ...identity,
    query: 'cart',
  });
  assert.deepEqual(discovered.capabilities.map(({ id }) => id), ['cart.add', 'cart.read']);
  assert.equal(discovered.capabilities.find(({ id }) => id === 'cart.add').requiresApproval, true);

  const plan = await runtime.callTool('plan.propose', {
    ...identity,
    request: {
      action: 'add_to_cart',
      nodes: [
        { capabilityId: 'catalog.search', args: { query: 'espresso' } },
        { capabilityId: 'cart.add', args: { productId: 'sku-espresso', quantity: 2 } },
      ],
    },
  });
  assert.equal(plan.status, 'proposed');
  assert.equal(plan.nodes.length, 2);
  assert.equal(plan.nodes[0].readOnly, true);
  assert.equal(plan.nodes[1].readOnly, false);

  const waiting = await runtime.callTool('workflow.execute', {
    ...identity,
    workflowId: plan.workflowId,
  });
  assert.equal(waiting.status, 'awaiting_approval');
  assert.equal(waiting.approvalRequired, true);
  assert.equal(waiting.error.code, 'APPROVAL_REQUIRED');
  assert.equal(waiting.outputs.length, 1);
  assert.equal(waiting.outputs[0].readOnly, true);
  assert.deepEqual(runtime.adapters[0].snapshot().cart, []);

  // This is a server-side host hook, not a public MCP tool.  Passing an
  // approval-shaped value to workflow.execute cannot create a trusted record.
  assert.equal(runtime.publicToolNames.includes('approval.grant'), false);
  const approval = await runtime.injectTrustedApproval(waiting.approvalRequest);
  assert.equal(approval.accepted, true);
  assert.equal(approval.trusted, true);

  const completed = await runtime.callTool('workflow.execute', {
    ...identity,
    workflowId: plan.workflowId,
  });
  assert.equal(completed.status, 'completed');
  assert.equal(completed.outputs.length, 2);
  assert.deepEqual(runtime.adapters[0].snapshot().cart, [{ productId: 'sku-espresso', quantity: 2 }]);

  const status = await runtime.callTool('workflow.status', {
    ...identity,
    workflowId: plan.workflowId,
  });
  assert.equal(status.status, 'completed');
  assert.equal(status.cursor, 2);

  const callsBeforeReplay = runtime.adapters[0].snapshot().calls;
  const replay = await runtime.callTool('workflow.replay_readonly', {
    ...identity,
    workflowId: plan.workflowId,
  });
  assert.equal(replay.status, 'completed');
  assert.equal(replay.readOnly, true);
  assert.ok(replay.replayedNodes.length > 0);
  assert.ok(replay.replayedNodes.every((node) => node.readOnly === true));
  const callsAfterReplay = runtime.adapters[0].snapshot().calls;
  assert.equal(callsAfterReplay.filter(({ capabilityId }) => capabilityId === 'cart.add').length, 1);
  assert.equal(callsAfterReplay.length, callsBeforeReplay.length + replay.replayedNodes.length);
  assert.deepEqual(runtime.adapters[0].snapshot().cart, [{ productId: 'sku-espresso', quantity: 2 }]);
});

test('JSON-RPC tools/list exposes exactly the six public tools', async () => {
  const app = createServer({ fixture: true });
  const response = await app.handleRequest({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/list',
    params: {},
  });
  assert.deepEqual(response.result.tools.map(({ name }) => name), PUBLIC_TOOL_NAMES);

  const hidden = await app.handleRequest({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 'approval.grant', arguments: {} },
  });
  assert.equal(hidden.error.code, -32601);
});

