import assert from 'node:assert/strict';
import test from 'node:test';

import { createCompositionRoot } from '../../src/runtime/composition-root.js';

const ORIGIN = 'https://shop.example.test';
const IDENTITY = Object.freeze({
  tenantId: 'tenant-approval-retention',
  subject: 'user-approval-retention',
  origin: ORIGIN,
});
const CAPABILITY = Object.freeze({
  id: 'orders.write',
  version: '1',
  readOnly: false,
  mutates: true,
  operation: 'write',
  mode: 'mutation',
  kind: 'mutation',
  adapters: [{ id: 'orders.adapter' }],
  origins: [ORIGIN],
  inputSchema: { type: 'object', additionalProperties: true },
  outputSchema: { type: 'object', additionalProperties: true },
});

function createApprovalRuntime(clock) {
  const calls = { count: 0 };
  const adapter = {
    id: 'orders.adapter',
    origins: [ORIGIN],
    capabilities: [{ id: CAPABILITY.id }],
    execute() {
      calls.count += 1;
      return { ok: true, output: { committed: true, call: calls.count } };
    },
  };
  const runtime = createCompositionRoot({
    identity: IDENTITY,
    now: clock,
    allowReadOnly: true,
    policyRules: [{
      effect: 'allow',
      capabilities: [CAPABILITY.id],
      adapters: [adapter.id],
      origins: [ORIGIN],
    }],
    capabilities: [CAPABILITY],
    adapters: { [adapter.id]: adapter },
  });
  return { runtime, calls };
}

async function proposePending(runtime) {
  const plan = await runtime.callTool('plan.propose', {
    ...IDENTITY,
    nodes: [{ id: 'write', capabilityId: CAPABILITY.id, args: { orderId: 'order-1' } }],
  });
  const pending = await runtime.callTool('workflow.execute', {
    ...IDENTITY,
    workflowId: plan.workflowId,
    revision: plan.revision,
  });
  assert.equal(pending.status, 'awaiting_approval');
  return { plan, pending };
}

test('an expired earlier approval is pruned and cannot shadow a newer valid approval', async () => {
  let time = 0;
  const { runtime, calls } = createApprovalRuntime(() => new Date(time));
  const { plan, pending } = await proposePending(runtime);

  const first = await runtime.injectTrustedApproval(pending.approvalRequest);
  time = first.expiresAt + 1;
  const second = await runtime.injectTrustedApproval(pending.approvalRequest);

  assert.notEqual(first.approvalId, second.approvalId);
  assert.deepEqual([...runtime.trustedApprovals.keys()], [second.approvalId]);

  const completed = await runtime.callTool('workflow.execute', {
    ...IDENTITY,
    workflowId: plan.workflowId,
    revision: plan.revision,
  });
  assert.equal(completed.status, 'completed');
  assert.equal(calls.count, 1);
  assert.equal(runtime.services.approvals.status(first.approvalId).usedAt, null);
  assert.equal(runtime.services.approvals.status(second.approvalId).usedAt, time);
});

test('a consumed approval is not reused; execution waits for a fresh credential', async () => {
  let time = 0;
  const { runtime, calls } = createApprovalRuntime(() => new Date(time));
  const { plan, pending } = await proposePending(runtime);
  const first = await runtime.injectTrustedApproval(pending.approvalRequest);
  const workflow = runtime.services.workflow.get({
    identity: { tenantId: IDENTITY.tenantId, subjectId: IDENTITY.subject },
    workflowId: plan.workflowId,
    revision: plan.revision,
  });
  const node = workflow.plan.nodes[0];
  const firstCredential = runtime.trustedApprovals.get(first.approvalId).credential;
  const consumed = runtime.services.approvals.consume({
    tenantId: IDENTITY.tenantId,
    subjectId: IDENTITY.subject,
    workflowId: plan.workflowId,
    revision: plan.revision,
    nodeId: node.id,
    origin: node.origin,
    adapter: node.adapter,
    capabilityId: node.capabilityId,
    capabilityVersion: node.capabilityVersion,
    args: node.args,
  }, firstCredential);
  assert.equal(consumed.consumed, true);

  const blocked = await runtime.callTool('workflow.execute', {
    ...IDENTITY,
    workflowId: plan.workflowId,
    revision: plan.revision,
  });
  assert.equal(blocked.status, 'awaiting_approval');
  assert.equal(calls.count, 0);
  assert.equal(runtime.trustedApprovals.size, 0);

  const second = await runtime.injectTrustedApproval(pending.approvalRequest);
  assert.notEqual(first.approvalId, second.approvalId);
  const completed = await runtime.callTool('workflow.execute', {
    ...IDENTITY,
    workflowId: plan.workflowId,
    revision: plan.revision,
  });
  assert.equal(completed.status, 'completed');
  assert.equal(calls.count, 1);
});

