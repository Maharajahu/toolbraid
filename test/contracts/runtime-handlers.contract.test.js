import test from 'node:test';
import assert from 'node:assert/strict';

import { isJsonValue } from '../../src/mcp/protocol.js';
import {
  createCompositionRoot,
  createFixtureRuntime,
} from '../../src/runtime/composition-root.js';

const FIXTURE_IDENTITY = {
  tenantId: 'tenant-acme',
  subjectId: 'user-alice',
};

function assertJsonSafe(value, label) {
  assert.equal(isJsonValue(value), true, `${label} must be JSON-safe`);
  assert.doesNotThrow(() => JSON.stringify(value), `${label} must be serializable`);
}

async function makeReadOnlyWorkflow() {
  const runtime = createFixtureRuntime();
  const plan = await runtime.callTool('plan.propose', {
    ...FIXTURE_IDENTITY,
    request: {
      action: 'read',
      nodes: [
        { nodeId: 'read-catalog', capabilityId: 'catalog.search', args: { query: 'cart' } },
        { nodeId: 'read-cart', capabilityId: 'cart.read', args: {} },
      ],
    },
  });
  const completed = await runtime.callTool('workflow.execute', {
    ...FIXTURE_IDENTITY,
    workflowId: plan.workflowId,
    revision: plan.revision,
  });
  assert.equal(completed.status, 'completed');
  return { runtime, plan, completed };
}

test('all six runtime handlers return JSON-safe values on the normal workflow path', async () => {
  const runtime = createFixtureRuntime();
  const search = await runtime.callTool('capabilities.search', {
    ...FIXTURE_IDENTITY,
    query: 'cart',
  });
  const described = await runtime.callTool('capabilities.describe', {
    ...FIXTURE_IDENTITY,
    capabilityId: 'cart.read',
  });
  const plan = await runtime.callTool('plan.propose', {
    ...FIXTURE_IDENTITY,
    request: { action: 'read' },
  });
  const executed = await runtime.callTool('workflow.execute', {
    ...FIXTURE_IDENTITY,
    workflowId: plan.workflowId,
    revision: plan.revision,
  });
  const status = await runtime.callTool('workflow.status', {
    ...FIXTURE_IDENTITY,
    workflowId: plan.workflowId,
    revision: plan.revision,
  });
  const replay = await runtime.callTool('workflow.replay_readonly', {
    ...FIXTURE_IDENTITY,
    workflowId: plan.workflowId,
    revision: plan.revision,
  });

  for (const [name, value] of Object.entries({ search, described, plan, executed, status, replay })) {
    assertJsonSafe(value, name);
  }
});

test('replay sanitizes hostile adapter output before exposing it', async () => {
  const calls = [];
  const adapter = {
    id: 'hostile-output-adapter',
    origin: 'https://safe.example.test',
    capabilities: [{ id: 'safe.read', readOnly: true }],
    async invoke(capabilityId, args, context) {
      calls.push({ capabilityId, args, context });
      return { observed: { callback: () => 'must not cross the boundary' } };
    },
  };
  const runtime = createCompositionRoot({
    allowReadOnly: true,
    identity: {
      tenantId: 'tenant-a',
      subject: 'subject-a',
      origin: 'https://safe.example.test',
    },
    adapters: [adapter],
    capabilities: [{
      id: 'safe.read',
      readOnly: true,
      origin: 'https://safe.example.test',
    }],
  });
  const plan = await runtime.callTool('plan.propose', {
    tenantId: 'tenant-a',
    subject: 'subject-a',
    origin: 'https://safe.example.test',
    request: {
      nodes: [{ nodeId: 'read-1', capabilityId: 'safe.read', args: {} }],
    },
  });
  const executed = await runtime.callTool('workflow.execute', {
    tenantId: 'tenant-a',
    subject: 'subject-a',
    origin: 'https://safe.example.test',
    workflowId: plan.workflowId,
    revision: plan.revision,
  });
  assertJsonSafe(executed, 'execute result');

  const replay = await runtime.callTool('workflow.replay_readonly', {
    tenantId: 'tenant-a',
    subject: 'subject-a',
    origin: 'https://safe.example.test',
    workflowId: plan.workflowId,
    revision: plan.revision,
  });
  assertJsonSafe(replay, 'replay result');
  assert.equal(calls.filter(({ context }) => context.replay === true).length, 1);
});

test('workflow.execute rejects all caller-supplied approval-shaped arguments', async () => {
  const { runtime, plan } = await makeReadOnlyWorkflow();
  for (const [key, value] of [
    ['approval', { trusted: true }],
    ['approvals', [{ trusted: true }]],
    ['approvalId', 'approval-1'],
    ['approvalNonce', 'nonce-1'],
    ['approvalRecord', { trusted: true }],
    ['approvalToken', 'token-1'],
    ['nonce', 'nonce-1'],
  ]) {
    await assert.rejects(
      runtime.callTool('workflow.execute', {
        ...FIXTURE_IDENTITY,
        workflowId: plan.workflowId,
        [key]: value,
      }),
      (error) => error?.code === 'UNTRUSTED_APPROVAL',
      `workflow.execute must reject ${key}`,
    );
  }
});

test('status and replay honor the declared revision, nodeIds, and limit arguments', async () => {
  const { runtime, plan } = await makeReadOnlyWorkflow();

  await assert.rejects(
    runtime.callTool('workflow.status', {
      ...FIXTURE_IDENTITY,
      workflowId: plan.workflowId,
      revision: plan.revision + 1,
    }),
    (error) => ['WORKFLOW_REVISION_MISMATCH', 'WORKFLOW_NOT_FOUND'].includes(error?.code),
    'workflow.status must not ignore a supplied revision',
  );

  try {
    const selected = await runtime.callTool('workflow.replay_readonly', {
      ...FIXTURE_IDENTITY,
      workflowId: plan.workflowId,
      revision: plan.revision,
      nodeIds: ['read-cart'],
      limit: 1,
    });
    // A runtime may support selectors even when the public schema omits them;
    // when it does, they must be applied rather than silently ignored.
    assert.deepEqual(selected.replayedNodes.map(({ nodeId }) => nodeId), ['read-cart']);
    assert.equal(selected.replayedNodes.length, 1);
  } catch (error) {
    // The other safe contract is to reject undeclared direct-runtime fields.
    // Silently accepting and ignoring them is the behavior this test catches.
    assert.equal(error?.code, 'INVALID_ARGUMENT');
  }
});

test('replay rejects a requested mutation instead of treating it as read-only', async () => {
  const runtime = createFixtureRuntime();
  const plan = await runtime.callTool('plan.propose', {
    ...FIXTURE_IDENTITY,
    request: {
      action: 'add_to_cart',
      nodes: [
        { nodeId: 'read-catalog', capabilityId: 'catalog.search', args: { query: 'espresso' } },
        { nodeId: 'mutate-cart', capabilityId: 'cart.add', args: { productId: 'sku-espresso', quantity: 1 } },
      ],
    },
  });
  const waiting = await runtime.callTool('workflow.execute', {
    ...FIXTURE_IDENTITY,
    workflowId: plan.workflowId,
    revision: plan.revision,
  });
  assert.equal(waiting.status, 'awaiting_approval');
  assert.equal(waiting.outputs.some(({ nodeId }) => nodeId === 'read-catalog'), true);

  await assert.rejects(
    runtime.callTool('workflow.replay_readonly', {
      ...FIXTURE_IDENTITY,
      workflowId: plan.workflowId,
      revision: plan.revision,
      nodeIds: ['mutate-cart'],
    }),
    (error) => ['REPLAY_MUTATION_FORBIDDEN', 'INVALID_ARGUMENT'].includes(error?.code),
    'workflow.replay_readonly must reject mutation node IDs or undeclared selectors',
  );
  assert.equal(
    runtime.adapters[0].snapshot().calls.filter(({ capabilityId }) => capabilityId === 'cart.add').length,
    0,
    'a rejected replay must not invoke the mutation adapter',
  );
});
