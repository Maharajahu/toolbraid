import assert from 'node:assert/strict';
import test from 'node:test';

import { runPlanUntilBlocked } from '../../src/engine/executor.js';
import { NODE_STATUS, approveNodes, createPlan } from '../../src/engine/graph.js';
import { RISK_LEVELS } from '../../src/engine/risk.js';

function tool(origin, name) {
  return { origin, name };
}

function readNode(id, candidates, dependencies = []) {
  return {
    id,
    type: 'tool',
    label: id,
    capabilityId: `read.${id}`,
    dependencies,
    risk: RISK_LEVELS.READ_ONLY,
    approvalRequired: false,
    candidates,
  };
}

function mutationNode(candidates) {
  return {
    id: 'apply',
    type: 'tool',
    label: 'Apply recovery',
    capabilityId: 'recovery.option.apply',
    dependencies: ['prepare'],
    risk: RISK_LEVELS.TRANSACTIONAL,
    approvalRequired: true,
    candidates,
  };
}

test('executes independent safe reads concurrently', async () => {
  const events = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const plan = createPlan({
    id: 'p1',
    objective: 'recover',
    nodes: [
      readNode('health', [{ tool: tool('https://health.test', 'probe'), arguments: {} }]),
      readNode('release', [{ tool: tool('https://release.test', 'trace'), arguments: {} }]),
    ],
  });
  const running = runPlanUntilBlocked(plan, {
    runtime: {
      async execute(current) {
        events.push(`start:${current.name}`);
        await gate;
        events.push(`end:${current.name}`);
        return { ok: true };
      },
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ['start:probe', 'start:trace']);
  release();
  await running;
});

test('fails over only between read-only provider candidates', async () => {
  const primary = tool('https://one.test', 'probe');
  const backup = tool('https://two.test', 'inspect');
  const plan = createPlan({
    id: 'p1',
    objective: 'recover',
    nodes: [readNode('health', [
      { tool: primary, arguments: { service: 'checkout' } },
      { tool: backup, arguments: { target: 'checkout' } },
    ])],
  });
  const calls = [];
  await runPlanUntilBlocked(plan, {
    runtime: {
      async execute(current, args) {
        calls.push([current.origin, args]);
        if (current.origin === primary.origin) throw new Error('provider unavailable');
        return { healthy: true };
      },
    },
  });
  assert.deepEqual(calls, [
    ['https://one.test', { service: 'checkout' }],
    ['https://two.test', { target: 'checkout' }],
  ]);
});

test('runs an approved mutation with its precomputed exact arguments and no provider failover', async () => {
  const first = tool('https://deploy.test', 'apply');
  const second = tool('https://backup.test', 'apply');
  const exactArguments = {
    deploymentId: 'dep-42',
    quoteRevision: 'q-9',
    idempotencyKey: 'once-123',
  };
  const plan = createPlan({
    id: 'p1',
    objective: 'recover',
    nodes: [
      { id: 'prepare', type: 'local', label: 'prepare', operation: 'prepare', dependencies: [], approvalRequired: false },
      mutationNode([
        { tool: first, arguments: exactArguments },
        { tool: second, arguments: { deploymentId: 'other' } },
      ]),
    ],
  });
  await runPlanUntilBlocked(plan, {
    runtime: { async execute() { return { prepared: true }; } },
    localOperations: { prepare: () => ({ prepared: true }) },
  });
  approveNodes(plan, ['apply']);

  const calls = [];
  await runPlanUntilBlocked(plan, {
    runtime: {
      async execute(current, args) {
        calls.push([current.origin, args]);
        return { applied: true };
      },
    },
    authorizeMutation({ arguments: args }) {
      assert.deepEqual(args, exactArguments);
      return { nonce: 'claimed' };
    },
  }, { includeApprovedMutations: true });

  assert.deepEqual(calls, [['https://deploy.test', exactArguments]]);
  assert.equal(plan.nodes.find((node) => node.id === 'apply').status, NODE_STATUS.COMPLETED);
});

test('blocks an approved mutation when no approval verifier is supplied', async () => {
  const mutation = mutationNode([{ tool: tool('https://deploy.test', 'apply'), arguments: { id: 'dep-1' } }]);
  mutation.dependencies = [];
  const plan = createPlan({
    id: 'p1',
    objective: 'recover',
    nodes: [mutation],
  });
  approveNodes(plan, ['apply']);

  await assert.rejects(
    () => runPlanUntilBlocked(plan, { runtime: { async execute() { return {}; } } }, { includeApprovedMutations: true }),
    (error) => error.code === 'APPROVAL_REQUIRED',
  );
});

test('resolves canonical arguments from prior results before adapting provider-native input', async () => {
  const nativeTool = tool('https://health.test', 'probe_service');
  const plan = createPlan({
    id: 'p-resolve-input',
    objective: 'resolve provider-independent input',
    nodes: [
      {
        id: 'context',
        type: 'local',
        label: 'context',
        operation: 'build-context',
        dependencies: [],
        approvalRequired: false,
      },
      {
        id: 'health',
        type: 'tool',
        label: 'health',
        capabilityId: 'service.health.read',
        dependencies: ['context'],
        risk: RISK_LEVELS.READ_ONLY,
        approvalRequired: false,
        arguments: { serviceId: 'checkout' },
        candidates: [{ tool: nativeTool }],
      },
    ],
  });
  const hookCalls = [];
  const runtimeCalls = [];

  await runPlanUntilBlocked(plan, {
    localOperations: {
      'build-context': () => ({ windowMinutes: 45 }),
    },
    resolveArguments(capabilityId, planned, { node, tool: selectedTool, results }) {
      hookCalls.push(`resolve:${node.id}`);
      assert.equal(capabilityId, 'service.health.read');
      assert.equal(selectedTool, nativeTool);
      assert.deepEqual(planned, { serviceId: 'checkout' });
      return { ...planned, windowMinutes: results.get('context').windowMinutes };
    },
    adaptInput(capabilityId, canonical, { candidate, results }) {
      hookCalls.push('adapt:health');
      assert.equal(capabilityId, 'service.health.read');
      assert.equal(candidate.tool, nativeTool);
      assert.equal(results.get('context').windowMinutes, 45);
      return { service: canonical.serviceId, lookback_minutes: canonical.windowMinutes };
    },
    runtime: {
      async execute(current, nativeArguments) {
        runtimeCalls.push([current, nativeArguments]);
        return { status: 'degraded' };
      },
    },
  });

  assert.deepEqual(hookCalls, ['resolve:health', 'adapt:health']);
  assert.deepEqual(runtimeCalls, [[nativeTool, { service: 'checkout', lookback_minutes: 45 }]]);
});

test('legacy execution uses node arguments when a mapped candidate has no argument override', async () => {
  const mappedTool = tool('https://health.test', 'probe');
  const plan = createPlan({
    id: 'p-node-arguments',
    objective: 'preserve planned arguments',
    nodes: [{
      id: 'health',
      type: 'tool',
      label: 'health',
      capabilityId: 'service.health.read',
      dependencies: [],
      risk: RISK_LEVELS.READ_ONLY,
      approvalRequired: false,
      arguments: { serviceId: 'checkout' },
      mapping: { tool: mappedTool },
    }],
  });
  const calls = [];

  await runPlanUntilBlocked(plan, {
    runtime: {
      async execute(current, args) {
        calls.push([current, args]);
        return { status: 'healthy' };
      },
    },
  });

  assert.deepEqual(calls, [[mappedTool, { serviceId: 'checkout' }]]);
});

test('authorizes canonical arguments and provider-native arguments as separate values', async () => {
  const nativeTool = tool('https://deploy.test', 'execute_rollback');
  const canonical = {
    recoveryOptionId: 'recovery-option-7',
    quoteRevision: 'quote-r3',
    idempotencyKey: 'apply-p-native-r1',
  };
  const native = {
    option_id: 'recovery-option-7',
    etag: 'quote-r3',
    request_id: 'apply-p-native-r1',
  };
  const plan = createPlan({
    id: 'p-native',
    objective: 'apply exact recovery',
    nodes: [{
      id: 'apply',
      type: 'tool',
      label: 'Apply recovery',
      capabilityId: 'recovery.option.apply',
      dependencies: [],
      risk: RISK_LEVELS.TRANSACTIONAL,
      approvalRequired: true,
      arguments: canonical,
      candidates: [{ tool: nativeTool }],
    }],
  });
  approveNodes(plan, ['apply']);
  let authorized = false;
  const runtimeCalls = [];

  await runPlanUntilBlocked(plan, {
    adaptInput(capabilityId, canonicalArguments) {
      assert.equal(capabilityId, 'recovery.option.apply');
      assert.deepEqual(canonicalArguments, canonical);
      return native;
    },
    authorizeMutation(payload) {
      authorized = true;
      assert.equal(payload.arguments, payload.canonicalArguments);
      assert.deepEqual(payload.canonicalArguments, canonical);
      assert.deepEqual(payload.nativeArguments, native);
      assert.notEqual(payload.canonicalArguments, payload.nativeArguments);
    },
    runtime: {
      async execute(current, nativeArguments) {
        runtimeCalls.push([current, nativeArguments]);
        return { status: 'applied' };
      },
    },
  }, { includeApprovedMutations: true });

  assert.equal(authorized, true);
  assert.deepEqual(runtimeCalls, [[nativeTool, native]]);
});

test('reasserts the live execution context after async authorization and immediately before runtime dispatch', async () => {
  const mutation = mutationNode([{ tool: tool('https://deploy.test', 'apply'), arguments: { id: 'dep-1' } }]);
  mutation.dependencies = [];
  const plan = createPlan({ id: 'p-final-assert', objective: 'close authorization TOCTOU', nodes: [mutation] });
  approveNodes(plan, ['apply']);
  let current = true;
  let executionCalls = 0;

  await assert.rejects(
    () => runPlanUntilBlocked(plan, {
      async authorizeMutation() {
        await Promise.resolve();
        current = false;
      },
      assertExecutionCurrent() {
        if (!current) {
          const error = new Error('registry changed during authorization');
          error.code = 'PLAN_INVALIDATED';
          throw error;
        }
      },
      runtime: { async execute() { executionCalls += 1; return {}; } },
    }, { includeApprovedMutations: true }),
    (error) => error.code === 'PLAN_INVALIDATED',
  );
  assert.equal(executionCalls, 0);
});

test('fails closed if an approved mutation still has deferred arguments', async () => {
  const plan = createPlan({
    id: 'p-deferred',
    objective: 'never execute empty mutation arguments',
    nodes: [{
      id: 'apply',
      type: 'tool',
      label: 'Apply recovery',
      capabilityId: 'recovery.option.apply',
      dependencies: [],
      risk: RISK_LEVELS.TRANSACTIONAL,
      approvalRequired: true,
      arguments: {},
      argumentsDeferred: true,
      candidates: [{ tool: tool('https://deploy.test', 'apply') }],
    }],
  });
  approveNodes(plan, ['apply']);
  let authorizationCalls = 0;
  let executionCalls = 0;

  await assert.rejects(
    () => runPlanUntilBlocked(plan, {
      authorizeMutation() { authorizationCalls += 1; },
      runtime: { async execute() { executionCalls += 1; return {}; } },
    }, { includeApprovedMutations: true }),
    (error) => error.code === 'MUTATION_ARGUMENTS_DEFERRED'
      && error.details.nodeId === 'apply',
  );
  assert.equal(authorizationCalls, 0);
  assert.equal(executionCalls, 0);
});

test('rejects a non-object provider adaptation before runtime execution', async () => {
  const plan = createPlan({
    id: 'p-invalid-adaptation',
    objective: 'reject malformed native input',
    nodes: [readNode('health', [{ tool: tool('https://health.test', 'probe'), arguments: {} }])],
  });
  let executionCalls = 0;

  await assert.rejects(
    () => runPlanUntilBlocked(plan, {
      adaptInput() { return null; },
      runtime: { async execute() { executionCalls += 1; return {}; } },
    }),
    (error) => error.code === 'CAPABILITY_EXECUTION_FAILED'
      && error.details.attempts[0].code === 'INPUT_ADAPTATION_INVALID',
  );
  assert.equal(executionCalls, 0);
});
