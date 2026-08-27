import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CapabilityCatalog,
  CoreError,
  DeterministicPlanner,
  ExecutionBroker,
  WorkflowStore,
  approvalBinding,
  canonicalHash,
  validatePlan,
} from '../../src/core/index.js';
import { ApprovalAuthority } from '../../src/security/index.js';

const ALICE = Object.freeze({ tenantId: 'tenant-a', subjectId: 'subject-a' });
const ALICE_OTHER_SUBJECT = Object.freeze({ tenantId: 'tenant-a', subjectId: 'subject-b' });
const BOB = Object.freeze({ tenantId: 'tenant-b', subjectId: 'subject-a' });
const ORIGIN = 'https://shop.example';

function makeCatalog() {
  return new CapabilityCatalog({
    capabilities: [
      {
        id: 'orders.read',
        version: '1',
        name: 'Read orders',
        description: 'Read order data',
        readOnly: true,
        adapters: [{ id: 'api' }],
        origins: [ORIGIN],
      },
      {
        id: 'orders.update',
        version: '1',
        name: 'Update orders',
        description: 'Change an order',
        readOnly: false,
        adapters: [{ id: 'api' }],
        origins: [ORIGIN],
      },
    ],
  });
}

function makePlan({
  identity = ALICE,
  workflowId = 'workflow-a',
  revision = 1,
  nodes = [{ id: 'read', capabilityId: 'orders.read', args: { orderId: 'o-1' } }],
  catalog = makeCatalog(),
} = {}) {
  return new DeterministicPlanner({ catalog }).propose({
    identity,
    workflowId,
    revision,
    nodes,
  });
}

function seed({
  identity = ALICE,
  workflowId = 'workflow-a',
  revision = 1,
  nodes,
  catalog = makeCatalog(),
  clock = () => '2026-01-01T00:00:00.000Z',
} = {}) {
  const plan = makePlan({ identity, workflowId, revision, nodes, catalog });
  const store = new WorkflowStore({ clock });
  store.create({ identity, workflowId, revision, plan });
  return { catalog, plan, store };
}

function expectCoreError(action, code) {
  assert.throws(action, (error) => {
    assert.ok(error instanceof CoreError);
    if (code !== undefined) assert.equal(error.code, code);
    return true;
  });
}

async function expectCoreErrorAsync(action, code) {
  await assert.rejects(action, (error) => {
    assert.ok(error instanceof CoreError);
    if (code !== undefined) assert.equal(error.code, code);
    return true;
  });
}

function workflowInput(identity, workflowId, revision = 1) {
  return { identity, workflowId, revision };
}

test('workflow identity is scoped by both tenant and subject, even when ids collide', () => {
  const store = new WorkflowStore({ clock: () => '2026-01-01T00:00:00.000Z' });
  const planAlice = makePlan({ identity: ALICE, workflowId: 'same-id' });
  const planOtherSubject = makePlan({ identity: ALICE_OTHER_SUBJECT, workflowId: 'same-id' });
  const planBob = makePlan({ identity: BOB, workflowId: 'same-id' });

  store.create({ ...workflowInput(ALICE, 'same-id'), plan: planAlice });
  store.create({ ...workflowInput(ALICE_OTHER_SUBJECT, 'same-id'), plan: planOtherSubject });
  store.create({ ...workflowInput(BOB, 'same-id'), plan: planBob });
  const aliceOnlyPlan = makePlan({ identity: ALICE, workflowId: 'alice-only' });
  store.create({ ...workflowInput(ALICE, 'alice-only'), plan: aliceOnlyPlan });

  assert.equal(store.list({ identity: ALICE }).workflows.length, 2);
  assert.ok(store.list({ identity: ALICE }).workflows.every((workflow) => workflow.subjectId === ALICE.subjectId));
  assert.equal(store.list({ identity: ALICE_OTHER_SUBJECT }).workflows.length, 1);
  assert.equal(store.list({ identity: BOB }).workflows.length, 1);
  assert.equal(store.get(workflowInput(ALICE, 'same-id')).subjectId, ALICE.subjectId);
  assert.equal(store.get(workflowInput(ALICE_OTHER_SUBJECT, 'same-id')).subjectId, ALICE_OTHER_SUBJECT.subjectId);
  assert.equal(store.get(workflowInput(BOB, 'same-id')).tenantId, BOB.tenantId);
  expectCoreError(() => store.get(workflowInput(ALICE_OTHER_SUBJECT, 'alice-only')), 'WORKFLOW_NOT_FOUND');
  expectCoreError(() => store.get(workflowInput(BOB, 'alice-only')), 'WORKFLOW_NOT_FOUND');
  expectCoreError(() => validatePlan({ identity: BOB, plan: planAlice }), 'WORKFLOW_FORBIDDEN');
});

test('workflow proposals and status snapshots cannot be mutated by callers', () => {
  const { plan, store } = seed({ workflowId: 'snapshot-isolation' });
  const input = workflowInput(ALICE, plan.workflowId);

  plan.nodes[0].args.orderId = 'attacker-order';
  plan.nodes[0].argumentHash = canonicalHash(plan.nodes[0].args);
  const storedAfterPlanMutation = store.get(input);
  assert.equal(storedAfterPlanMutation.plan.nodes[0].args.orderId, 'o-1');

  storedAfterPlanMutation.plan.nodes[0].args.orderId = 'status-attacker';
  storedAfterPlanMutation.nodeStates.read.state = 'completed';
  const storedAfterStatusMutation = store.get(input);
  assert.equal(storedAfterStatusMutation.plan.nodes[0].args.orderId, 'o-1');
  assert.equal(storedAfterStatusMutation.nodeStates.read.state, 'pending');
});

test('broker rejects a stale or identity-swapped stored plan before invoking an adapter', async () => {
  const { catalog, plan, store } = seed({ workflowId: 'tampered-plan' });
  const originalGet = store.get.bind(store);
  const calls = [];
  const broker = new ExecutionBroker({
    catalog,
    store,
    adapters: {
      api: {
        execute: async (request) => {
          calls.push(request);
          return { ok: true };
        },
      },
    },
  });

  store.get = (input) => {
    const snapshot = originalGet(input);
    snapshot.plan.nodes[0].args.orderId = 'tampered-order';
    return snapshot;
  };
  await expectCoreErrorAsync(() => broker.execute(workflowInput(ALICE, plan.workflowId)), 'INVALID_PLAN');
  assert.equal(calls.length, 0);

  store.get = (input) => {
    const snapshot = originalGet(input);
    snapshot.plan.tenantId = BOB.tenantId;
    return snapshot;
  };
  await expectCoreErrorAsync(() => broker.execute(workflowInput(ALICE, plan.workflowId)), 'WORKFLOW_FORBIDDEN');
  assert.equal(calls.length, 0);
});

test('broker requires integrity metadata on a tampered stored plan', async () => {
  const { catalog, plan, store } = seed({ workflowId: 'tampered-without-hash' });
  const originalGet = store.get.bind(store);
  const calls = [];
  const broker = new ExecutionBroker({
    catalog,
    store,
    adapters: {
      api: {
        execute: async (request) => {
          calls.push(request);
          return { ok: true };
        },
      },
    },
  });

  store.get = (input) => {
    const snapshot = originalGet(input);
    delete snapshot.plan.planHash;
    snapshot.plan.nodes[0].args.orderId = 'tampered-with-hash-removed';
    snapshot.plan.nodes[0].argumentHash = canonicalHash(snapshot.plan.nodes[0].args);
    return snapshot;
  };
  await expectCoreErrorAsync(() => broker.execute(workflowInput(ALICE, plan.workflowId)), 'INVALID_PLAN');
  assert.equal(calls.length, 0);
});

test('workflow and node lifecycle transitions fail closed, including approval-node mismatches', () => {
  const draftStore = new WorkflowStore({ clock: () => '2026-01-01T00:00:00.000Z' });
  draftStore.create({ identity: ALICE, workflowId: 'draft-only' });
  expectCoreError(() => draftStore.start(workflowInput(ALICE, 'draft-only')), 'WORKFLOW_STATE');
  expectCoreError(() => draftStore.transition({ ...workflowInput(ALICE, 'draft-only'), to: 'completed' }), 'WORKFLOW_STATE');
  expectCoreError(() => draftStore.transition({ ...workflowInput(ALICE, 'draft-only'), to: 'unknown' }), 'INVALID_WORKFLOW_STATE');

  const mutationNodes = [
    { id: 'update', capabilityId: 'orders.update', args: { orderId: 'o-1', status: 'paid' } },
    { id: 'read', capabilityId: 'orders.read', args: {}, dependsOn: ['update'] },
  ];
  const { plan, store } = seed({ workflowId: 'lifecycle', nodes: mutationNodes });
  const input = workflowInput(ALICE, plan.workflowId);
  expectCoreError(() => store.complete(input), 'WORKFLOW_STATE');
  store.start(input);
  expectCoreError(() => store.markNode({ ...input, nodeId: 'update', state: 'completed', output: null }), 'NODE_STATE');
  expectCoreError(() => store.awaitApproval({ ...input, nodeId: 'read' }), 'APPROVAL_NOT_REQUIRED');
  store.awaitApproval({ ...input, nodeId: 'update' });
  const waiting = store.get(input);
  assert.equal(waiting.state, 'awaiting_approval');
  assert.equal(waiting.awaitingApproval.nodeId, 'update');
  expectCoreError(() => store.resume({ ...input, nodeId: 'read' }));
  assert.equal(store.get(input).state, 'awaiting_approval');
  assert.equal(store.get(input).awaitingApproval.nodeId, 'update');
  store.resume({ ...input, nodeId: 'update' });

  store.markNode({ ...input, nodeId: 'update', state: 'running' });
  store.markNode({ ...input, nodeId: 'update', state: 'completed', output: { ok: true } });
  expectCoreError(() => store.markNode({ ...input, nodeId: 'update', state: 'running' }), 'NODE_STATE');
  expectCoreError(() => store.complete(input), 'WORKFLOW_INCOMPLETE');
  store.cancel(input);
  expectCoreError(() => store.start(input), 'WORKFLOW_STATE');
  expectCoreError(() => store.fail({ ...input, error: new Error('late failure') }), 'WORKFLOW_STATE');
});

test('duplicate execute is idempotent after completion, while replay remains read-only', async () => {
  const { catalog, plan, store } = seed({
    workflowId: 'duplicate-read',
    nodes: [
      { id: 'a-read', capabilityId: 'orders.read', args: { orderId: 'o-1' } },
      { id: 'b-read', capabilityId: 'orders.read', args: { orderId: 'o-2' }, dependsOn: ['a-read'] },
    ],
  });
  const calls = [];
  const broker = new ExecutionBroker({
    catalog,
    store,
    adapters: {
      api: {
        execute: async (request) => {
          calls.push({ nodeId: request.nodeId, replay: request.replay });
          return { nodeId: request.nodeId };
        },
      },
    },
  });
  const input = workflowInput(ALICE, plan.workflowId);

  const first = await broker.execute(input);
  const second = await broker.execute(input);
  assert.equal(first.state, 'completed');
  assert.equal(second.state, 'completed');
  assert.equal(calls.filter((call) => !call.replay).length, 2);
  assert.equal(store.get(input).nodeStates['a-read'].attempts, 1);
  assert.equal(store.get(input).nodeStates['b-read'].attempts, 1);

  const replay = await broker.replayReadonly({ ...input, nodeIds: ['a-read', 'b-read'] });
  assert.deepEqual(replay.nodes.map((node) => node.nodeId), ['a-read', 'b-read']);
  assert.equal(calls.filter((call) => call.replay).length, 2);
  assert.equal(store.get(input).nodeStates['a-read'].attempts, 1);
});

test('duplicate execute while approval is pending returns the same pending decision', async () => {
  const { catalog, plan, store } = seed({
    workflowId: 'duplicate-pending-approval',
    nodes: [{ id: 'update', capabilityId: 'orders.update', args: { orderId: 'o-1', status: 'paid' } }],
  });
  const calls = [];
  const broker = new ExecutionBroker({
    catalog,
    store,
    approvalVerifier: async () => false,
    adapters: {
      api: {
        execute: async (request) => {
          calls.push(request.nodeId);
          return { ok: true };
        },
      },
    },
  });
  const input = workflowInput(ALICE, plan.workflowId);

  const first = await broker.execute(input);
  const second = await broker.execute(input);
  assert.equal(first.state, 'awaiting_approval');
  assert.equal(second.state, 'awaiting_approval');
  assert.deepEqual(second.approvalRequired, first.approvalRequired);
  assert.equal(store.get(input).history.filter((event) => event.type === 'approval_required').length, 1);
  assert.deepEqual(calls, []);
});

test('readonly replay rejects a mutation before invoking any requested node', async () => {
  const { catalog, plan, store } = seed({
    workflowId: 'replay-exclusion',
    nodes: [
      { id: 'read', capabilityId: 'orders.read', args: {} },
      { id: 'update', capabilityId: 'orders.update', args: { orderId: 'o-1', status: 'paid' }, dependsOn: ['read'] },
    ],
  });
  const calls = [];
  const broker = new ExecutionBroker({
    catalog,
    store,
    approvalVerifier: async () => true,
    adapters: {
      api: {
        execute: async (request) => {
          calls.push({ nodeId: request.nodeId, replay: request.replay });
          return { nodeId: request.nodeId };
        },
      },
    },
  });
  const input = workflowInput(ALICE, plan.workflowId);
  await broker.execute(input);
  assert.deepEqual(calls.map((call) => call.nodeId), ['read', 'update']);

  await expectCoreErrorAsync(() => broker.replayReadonly({ ...input, nodeIds: ['read', 'update'] }), 'REPLAY_MUTATION_FORBIDDEN');
  await expectCoreErrorAsync(() => broker.replayReadonly({ ...input, nodeIds: ['update'] }), 'REPLAY_MUTATION_FORBIDDEN');
  assert.deepEqual(calls.map((call) => call.nodeId), ['read', 'update']);
  const readReplay = await broker.replayReadonly({ ...input, nodeIds: ['read'] });
  assert.deepEqual(readReplay.nodes.map((node) => node.nodeId), ['read']);
  assert.deepEqual(calls.map((call) => call.nodeId), ['read', 'update', 'read']);
  assert.equal(calls.at(-1).replay, true);
});

test('trusted approval is single-use and cannot cross workflow boundaries', async () => {
  const catalog = makeCatalog();
  const nodes = [{ id: 'update', capabilityId: 'orders.update', args: { orderId: 'o-1', status: 'paid' } }];
  const first = seed({ catalog, workflowId: 'approval-a', nodes });
  const second = seed({ catalog, workflowId: 'approval-b', nodes });
  const authority = new ApprovalAuthority({
    clock: () => 1_000,
    idFactory: () => 'approval-0001',
    nonceFactory: () => 'nonce-abcdefghijklmnop',
  });
  const issuer = authority.createIssuer('qa');
  const firstWorkflow = first.store.get(workflowInput(ALICE, first.plan.workflowId));
  const token = issuer.issue(approvalBinding({
    identity: ALICE,
    workflow: firstWorkflow,
    node: firstWorkflow.plan.nodes[0],
  }));
  const calls = [];
  const broker = new ExecutionBroker({
    catalog,
    store: first.store,
    approvalStore: authority,
    approvalCredential: token,
    adapters: {
      api: {
        execute: async (request) => {
          calls.push(request.workflowId);
          return { ok: true };
        },
      },
    },
  });

  await broker.execute(workflowInput(ALICE, first.plan.workflowId));
  assert.equal(calls.length, 1);
  assert.equal(authority.status(token.approvalId).usedAt, 1_000);
  assert.equal(authority.consume(approvalBinding({
    identity: ALICE,
    workflow: firstWorkflow,
    node: firstWorkflow.plan.nodes[0],
  }), token).code, 'APPROVAL_REPLAY');

  const swappedBroker = new ExecutionBroker({
    catalog,
    store: second.store,
    approvalStore: authority,
    approvalCredential: token,
    adapters: {
      api: {
        execute: async (request) => {
          calls.push(request.workflowId);
          return { ok: true };
        },
      },
    },
  });
  const swapped = await swappedBroker.execute(workflowInput(ALICE, second.plan.workflowId));
  assert.equal(swapped.state, 'awaiting_approval');
  assert.deepEqual(calls, ['approval-a']);
});

test('concurrent-looking duplicate execute calls do not invoke a node twice', async () => {
  const { catalog, plan, store } = seed({ workflowId: 'concurrent-read' });
  const calls = [];
  let release;
  let entered;
  const gate = new Promise((resolve) => { release = resolve; });
  const enteredOnce = new Promise((resolve) => { entered = resolve; });
  const broker = new ExecutionBroker({
    catalog,
    store,
    adapters: {
      api: {
        execute: async (request) => {
          calls.push(request.nodeId);
          entered();
          await gate;
          return { ok: true };
        },
      },
    },
  });
  const input = workflowInput(ALICE, plan.workflowId);
  const first = broker.execute(input);
  await enteredOnce;
  const second = broker.execute(input);
  release();
  const outcomes = await Promise.allSettled([first, second]);

  assert.equal(calls.length, 1);
  assert.equal(store.get(input).state, 'completed');
  assert.equal(store.get(input).nodeStates.read.attempts, 1);
  assert.ok(outcomes.every((outcome) => outcome.status === 'fulfilled'));
  assert.ok(outcomes.every((outcome) => outcome.value.state === 'completed'));
});

test('adapter failure leaves a terminal, non-replayable workflow without retrying side effects', async () => {
  const { catalog, plan, store } = seed({ workflowId: 'failure-recovery' });
  const calls = [];
  const broker = new ExecutionBroker({
    catalog,
    store,
    adapters: {
      api: {
        execute: async (request) => {
          calls.push(request.nodeId);
          const error = new Error('temporary provider outage');
          error.retryable = true;
          throw error;
        },
      },
    },
  });
  const input = workflowInput(ALICE, plan.workflowId);

  await expectCoreErrorAsync(() => broker.execute(input), 'EXECUTION_FAILED');
  const failed = store.get(input);
  assert.equal(failed.state, 'failed');
  assert.equal(failed.nodeStates.read.state, 'failed');
  assert.equal(failed.nodeStates.read.attempts, 1);
  assert.equal(failed.error.code, 'ADAPTER_FAILURE');
  assert.deepEqual(calls, ['read']);

  const second = await broker.execute(input);
  assert.equal(second.state, 'failed');
  assert.deepEqual(calls, ['read']);
  await expectCoreErrorAsync(() => broker.replayReadonly({ ...input, nodeIds: ['read'] }), 'REPLAY_NOT_AVAILABLE');
});

test('post-invocation output serialization failures require reconciliation without retry', async () => {
  const { catalog, plan, store } = seed({
    workflowId: 'invalid-output',
    nodes: [{ id: 'update', capabilityId: 'orders.update', args: { orderId: 'o-1', status: 'paid' } }],
  });
  const calls = [];
  const broker = new ExecutionBroker({
    catalog,
    store,
    approvalVerifier: async () => true,
    adapters: {
      api: {
        execute: async (request) => {
          calls.push(request.nodeId);
          return { unsupported: 1n };
        },
      },
    },
  });
  const input = workflowInput(ALICE, plan.workflowId);

  await assert.rejects(
    () => broker.execute(input),
    (error) => error instanceof CoreError &&
      error.code === 'RECONCILIATION_REQUIRED' &&
      error.retryable === false &&
      error.details?.effectMayHaveCommitted === true &&
      error.details?.outcome === 'unknown',
  );
  assert.equal(store.get(input).state, 'failed');
  // The mutation crossed the adapter boundary, but its outcome is unknown;
  // retain the running node marker for reconciliation instead of relabeling
  // it as a normal retryable failure.
  assert.equal(store.get(input).nodeStates.update.state, 'running');
  assert.equal(store.get(input).error.code, 'RECONCILIATION_REQUIRED');
  assert.deepEqual(calls, ['update']);
  const second = await broker.execute(input);
  assert.equal(second.state, 'failed');
  assert.deepEqual(calls, ['update']);
});

test('failure-persistence errors require reconciliation and retain a no-reinvoke guard', async () => {
  const { catalog, plan, store } = seed({
    workflowId: 'failure-persistence',
    nodes: [{ id: 'update', capabilityId: 'orders.update', args: { orderId: 'o-1', status: 'paid' } }],
  });
  const failingStore = {
    get: (input) => store.get(input),
    start: (input) => store.start(input),
    markNode: (input) => store.markNode(input),
    fail: () => { throw new CoreError('STORE_QUOTA', 'workflow failure could not be persisted'); },
  };
  let resolverCalls = 0;
  const broker = new ExecutionBroker({
    catalog,
    store: failingStore,
    approvalVerifier: async () => true,
    adapterResolver: async () => {
      resolverCalls += 1;
      throw new CoreError('ADAPTER_LOOKUP', 'adapter lookup failed before invocation');
    },
  });
  const input = workflowInput(ALICE, plan.workflowId);

  await assert.rejects(
    () => broker.execute(input),
    (error) => error instanceof CoreError &&
      error.code === 'RECONCILIATION_REQUIRED' &&
      error.retryable === false &&
      error.details?.effectMayHaveCommitted === false &&
      error.details?.outcome === 'not_started',
  );
  assert.equal(store.get(input).state, 'running');
  assert.equal(resolverCalls, 1);

  await assert.rejects(
    () => broker.execute({ ...input, origin: ORIGIN, adapter: 'api' }),
    (error) => error instanceof CoreError && error.code === 'RECONCILIATION_REQUIRED',
  );
  assert.equal(resolverCalls, 1, 'a persistence failure must not implicitly reinvoke the adapter boundary');
});

test('mutation completion quota failure requires reconciliation without a second approval invocation', async () => {
  const catalog = new CapabilityCatalog({
    capabilities: [{
      id: 'orders.update',
      version: '1',
      readOnly: false,
      adapters: [{ id: 'api' }],
      origins: [ORIGIN],
      inputSchema: { type: 'object', additionalProperties: true },
      outputSchema: {
        type: 'object',
        properties: { receipt: { type: 'string' } },
        additionalProperties: false,
      },
    }],
  });
  const plan = new DeterministicPlanner({ catalog }).propose({
    identity: ALICE,
    workflowId: 'completion-quota',
    nodes: [{
      id: 'update',
      capabilityId: 'orders.update',
      // Keep the proposal below the 2,800-byte record cap while making the
      // successful 1,000-character receipt exceed it at node completion.
      args: { orderId: 'o-1', payload: 'p'.repeat(200) },
    }],
  });
  const store = new WorkflowStore({
    maxRecordBytes: 2_800,
    clock: () => '2026-01-01T00:00:00.000Z',
  });
  store.create({ identity: ALICE, workflowId: plan.workflowId, revision: plan.revision, plan });
  let approvals = 0;
  let sideEffects = 0;
  const broker = new ExecutionBroker({
    catalog,
    store,
    approvalVerifier: async () => {
      approvals += 1;
      return true;
    },
    adapters: {
      api: {
        execute: async () => {
          sideEffects += 1;
          return { receipt: 'r'.repeat(1_000) };
        },
      },
    },
  });
  const input = workflowInput(ALICE, plan.workflowId);

  await assert.rejects(
    () => broker.execute(input),
    (error) => error instanceof CoreError &&
      error.code === 'RECONCILIATION_REQUIRED' &&
      error.retryable === false &&
      error.details?.effectMayHaveCommitted === true &&
      error.details?.outcome === 'unknown',
  );
  const reconciled = store.get(input);
  assert.equal(reconciled.state, 'failed');
  assert.equal(reconciled.error.code, 'RECONCILIATION_REQUIRED');
  assert.equal(reconciled.nodeStates.update.state, 'running');
  assert.equal(sideEffects, 1);
  assert.equal(approvals, 1);

  // A caller presenting a fresh approval (the verifier remains willing) must
  // receive the terminal reconciliation snapshot, never a second invocation.
  const repeated = await broker.execute(input);
  assert.equal(repeated.state, 'failed');
  assert.equal(sideEffects, 1);
  assert.equal(approvals, 1);
});

test('workflow completion persistence failure is terminalized after mutation receipts', async () => {
  const { catalog, plan, store } = seed({
    workflowId: 'workflow-completion-persistence',
    nodes: [{ id: 'update', capabilityId: 'orders.update', args: { orderId: 'o-1', status: 'paid' } }],
  });
  const failingStore = {
    get: (input) => store.get(input),
    start: (input) => store.start(input),
    markNode: (input) => store.markNode(input),
    fail: (input) => store.fail(input),
    complete: () => { throw new CoreError('STORE_UNAVAILABLE', 'workflow completion could not be persisted'); },
  };
  let sideEffects = 0;
  const broker = new ExecutionBroker({
    catalog,
    store: failingStore,
    approvalVerifier: async () => true,
    adapters: {
      api: {
        execute: async () => {
          sideEffects += 1;
          return { receipt: 'ok' };
        },
      },
    },
  });
  const input = workflowInput(ALICE, plan.workflowId);

  await assert.rejects(
    () => broker.execute(input),
    (error) => error instanceof CoreError &&
      error.code === 'RECONCILIATION_REQUIRED' &&
      error.retryable === false &&
      error.details?.phase === 'workflow_completion_persistence' &&
      error.details?.effectMayHaveCommitted === true &&
      error.details?.outcome === 'unknown',
  );
  assert.equal(store.get(input).state, 'failed');
  assert.equal(store.get(input).error.code, 'RECONCILIATION_REQUIRED');
  assert.equal(sideEffects, 1);

  const repeated = await broker.execute(input);
  assert.equal(repeated.state, 'failed');
  assert.equal(sideEffects, 1);
});

test('trusted approval cannot bypass a deny-write policy action', async () => {
  const { catalog, plan, store } = seed({
    workflowId: 'deny-write-action',
    nodes: [{ id: 'update', capabilityId: 'orders.update', args: { orderId: 'o-1', status: 'paid' } }],
  });
  let approvalAvailable = false;
  let denyWrite = false;
  let approvalChecks = 0;
  let sideEffects = 0;
  const broker = new ExecutionBroker({
    catalog,
    store,
    policy: {
      evaluate(request) {
        assert.equal(request.action, 'write', 'policy action must come from trusted mutability');
        if (denyWrite) return { allowed: false, code: 'POLICY_DENIED' };
        return { allowed: true };
      },
    },
    approvalVerifier: async () => {
      approvalChecks += 1;
      return approvalAvailable;
    },
    adapters: {
      api: {
        execute: async () => {
          sideEffects += 1;
          return { updated: true };
        },
      },
    },
  });
  const input = workflowInput(ALICE, plan.workflowId);

  const waiting = await broker.execute(input);
  assert.equal(waiting.state, 'awaiting_approval');
  approvalAvailable = true;
  denyWrite = true;
  await assert.rejects(
    () => broker.execute(input),
    (error) => error instanceof CoreError && error.code === 'POLICY_DENIED',
  );
  const denied = store.get(input);
  assert.equal(denied.state, 'failed');
  assert.equal(sideEffects, 0);
  assert.equal(approvalChecks, 1, 'deny-write must run before consuming the available approval');
});
