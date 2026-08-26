import assert from 'node:assert/strict';
import test from 'node:test';

import {
  RuntimeError,
  createCompositionRoot,
  createFixtureRuntime,
} from '../../src/runtime/composition-root.js';

const fixtureIdentity = Object.freeze({
  tenantId: 'tenant-acme',
  subject: 'user-alice',
  origin: 'https://shop.example.test',
});

test('public runtime requires explicit identity and rejects alias swaps', async () => {
  const runtime = createFixtureRuntime();
  await assert.rejects(
    runtime.callTool('capabilities.search', { query: 'cart' }),
    (error) => error instanceof RuntimeError && error.code === 'IDENTITY_REQUIRED',
  );
  await assert.rejects(
    runtime.callTool('capabilities.search', {
      tenantId: fixtureIdentity.tenantId,
      subject: fixtureIdentity.subject,
      identity: { tenantId: 'tenant-evil', subjectId: fixtureIdentity.subject },
      query: 'cart',
    }),
    (error) => error instanceof RuntimeError && error.code === 'INVALID_IDENTITY',
  );

  const nested = await runtime.callTool('capabilities.search', {
    identity: { tenantId: fixtureIdentity.tenantId, subjectId: fixtureIdentity.subject },
    origin: fixtureIdentity.origin,
    query: 'cart',
  });
  assert.equal(nested.tenantId, fixtureIdentity.tenantId);
  assert.equal(nested.subjectId, fixtureIdentity.subject);
});

test('catalog mutation cannot be relabeled read-only to bypass approval', async () => {
  const runtime = createFixtureRuntime();
  for (const downgrade of [{ readOnly: true }, { mode: 'read' }, { mutates: false }]) {
    await assert.rejects(
      runtime.callTool('plan.propose', {
        ...fixtureIdentity,
        nodes: [{
          capabilityId: 'cart.add',
          args: { productId: 'sku-espresso', quantity: 1 },
          ...downgrade,
        }],
      }),
      (error) => error instanceof RuntimeError && error.code === 'INVALID_PLAN',
    );
  }
  assert.deepEqual(runtime.adapters[0].snapshot().cart, []);
});

function mutationRuntime() {
  const calls = [];
  const adapter = (id) => ({
    id,
    origin: 'https://shop.example.test',
    capabilities: [{ id: 'orders.update' }],
    async invoke(capabilityId) {
      calls.push({ id, capabilityId });
      return { adapter: id };
    },
  });
  const runtime = createCompositionRoot({
    policyRules: [{
      effect: 'allow',
      capabilities: ['orders.update'],
      origins: ['https://shop.example.test'],
      adapters: ['safe-adapter', 'evil-adapter'],
    }],
    capabilities: [{
      id: 'orders.update',
      version: '1',
      mode: 'mutation',
      readOnly: false,
      origin: 'https://shop.example.test',
    }],
    adapters: [adapter('safe-adapter'), adapter('evil-adapter')],
  });
  return { runtime, calls };
}

test('core approval stays bound and public snapshot tamper cannot redirect the adapter', async () => {
  const { runtime, calls } = mutationRuntime();
  const identity = {
    tenantId: 'tenant-a',
    subject: 'subject-a',
    origin: 'https://shop.example.test',
  };
  const plan = await runtime.callTool('plan.propose', {
    ...identity,
    nodes: [{
      capabilityId: 'orders.update',
      adapterId: 'safe-adapter',
      args: { orderId: 'o-1', status: 'paid' },
    }],
  });
  const waiting = await runtime.callTool('workflow.execute', {
    ...identity,
    workflowId: plan.workflowId,
  });
  assert.equal(waiting.status, 'awaiting_approval');
  assert.equal(
    waiting.approvalRequest.adapterId ?? waiting.approvalRequest.adapter,
    'safe-adapter',
  );
  assert.equal(waiting.approvalRequest.capabilityId, 'orders.update');
  await runtime.injectTrustedApproval(waiting.approvalRequest);

  // The public compatibility snapshot is not the production source of truth.
  // Tampering with it must not redirect the core workflow after approval.
  runtime.workflows.get(plan.workflowId).nodes[0].adapterId = 'evil-adapter';
  const retried = await runtime.callTool('workflow.execute', {
    ...identity,
    workflowId: plan.workflowId,
  });
  assert.equal(retried.status, 'completed');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].id, 'safe-adapter');
  assert.equal(
    typeof calls[0].capabilityId === 'object'
      ? calls[0].capabilityId.capabilityId
      : calls[0].capabilityId,
    'orders.update',
  );
});

test('read-only replay requires the plan, catalog, and recording to agree', async () => {
  const runtime = createFixtureRuntime();
  const plan = await runtime.callTool('plan.propose', {
    ...fixtureIdentity,
    nodes: [{
      capabilityId: 'cart.add',
      args: { productId: 'sku-espresso', quantity: 1 },
    }],
  });
  const waiting = await runtime.callTool('workflow.execute', {
    ...fixtureIdentity,
    workflowId: plan.workflowId,
  });
  await runtime.injectTrustedApproval(waiting.approvalRequest);
  await runtime.callTool('workflow.execute', {
    ...fixtureIdentity,
    workflowId: plan.workflowId,
  });
  assert.equal(runtime.adapters[0].snapshot().calls.filter((call) => call.capabilityId === 'cart.add').length, 1);

  const storedNode = runtime.workflows.get(plan.workflowId).nodes[0];
  storedNode.readOnly = true;
  storedNode.mode = 'read';
  storedNode.kind = 'read';
  const replay = await runtime.callTool('workflow.replay_readonly', {
    ...fixtureIdentity,
    workflowId: plan.workflowId,
  });
  assert.deepEqual(replay.replayedNodes, []);
  assert.equal(runtime.adapters[0].snapshot().calls.filter((call) => call.capabilityId === 'cart.add').length, 1);
});

test('concurrent workflow executions cannot invoke the same node twice', async () => {
  let release;
  let started;
  const running = new Promise((resolve) => { started = resolve; });
  const blocked = new Promise((resolve) => { release = resolve; });
  let calls = 0;
  const adapter = {
    id: 'read-adapter',
    origin: 'https://shop.example.test',
    capabilities: [{ id: 'orders.read' }],
    async invoke() {
      calls += 1;
      started();
      await blocked;
      return { ok: true };
    },
  };
  const runtime = createCompositionRoot({
    allowReadOnly: true,
    capabilities: [{
      id: 'orders.read',
      version: '1',
      mode: 'read',
      readOnly: true,
      origin: 'https://shop.example.test',
    }],
    adapters: [adapter],
  });
  const identity = { tenantId: 'tenant-a', subject: 'subject-a', origin: adapter.origin };
  const plan = await runtime.callTool('plan.propose', {
    ...identity,
    nodes: [{ capabilityId: 'orders.read', args: {} }],
  });
  const first = runtime.callTool('workflow.execute', { ...identity, workflowId: plan.workflowId });
  await running;
  const second = runtime.callTool('workflow.execute', { ...identity, workflowId: plan.workflowId });
  release();
  const outcomes = await Promise.allSettled([first, second]);
  assert.equal(outcomes[0].status, 'fulfilled');
  assert.equal(outcomes[0].value.status, 'completed');
  if (outcomes[1].status === 'fulfilled') {
    assert.equal(outcomes[1].value.status, 'completed');
  } else {
    assert.equal(outcomes[1].reason instanceof RuntimeError, true);
    assert.equal(outcomes[1].reason.code, 'WORKFLOW_BUSY');
    assert.equal(outcomes[1].reason.retryable, true);
  }
  assert.equal(calls, 1);
});
