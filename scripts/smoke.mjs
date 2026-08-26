import assert from 'node:assert/strict';

import { createServer } from '../src/server.js';

const identity = {
  tenantId: 'tenant-acme',
  subject: 'user-alice',
  origin: 'https://shop.example.test',
};

const app = createServer({ fixture: true });
const call = (name, arguments_) => app.callTool(name, { ...identity, ...arguments_ });

const discovered = await call('capabilities.search', { query: 'cart' });
assert.ok(discovered.capabilities.some(({ id }) => id === 'cart.add'));

const plan = await call('plan.propose', {
  request: {
    action: 'add_to_cart',
    nodes: [
      { capabilityId: 'catalog.search', args: { query: 'espresso' } },
      { capabilityId: 'cart.add', args: { productId: 'sku-espresso', quantity: 1 } },
    ],
  },
});
const waiting = await call('workflow.execute', { workflowId: plan.workflowId });
assert.equal(waiting.status, 'awaiting_approval');
assert.equal(waiting.error.code, 'APPROVAL_REQUIRED');

await app.injectTrustedApproval(waiting.approvalRequest);
const completed = await call('workflow.execute', { workflowId: plan.workflowId });
assert.equal(completed.status, 'completed');

const replay = await call('workflow.replay_readonly', { workflowId: plan.workflowId });
assert.equal(replay.readOnly, true);
assert.ok(replay.replayedNodes.every(({ readOnly }) => readOnly));

process.stdout.write(JSON.stringify({
  ok: true,
  workflowId: plan.workflowId,
  statuses: [plan.status, waiting.status, completed.status],
  replayedNodes: replay.replayedNodes.length,
}) + '\n');

