import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CapabilityCatalog,
  CoreError,
  DeterministicPlanner,
  ExecutionBroker,
  WorkflowStore,
  canonicalHash,
  stableStringify,
  validatePlan,
} from '../../src/core/index.js';

const alice = { tenantId: 'tenant-a', subjectId: 'user-a' };
const bob = { tenantId: 'tenant-b', subjectId: 'user-b' };

function readCapability(overrides = {}) {
  return {
    id: 'orders.list',
    version: '1',
    name: 'List orders',
    description: 'Read orders from the account',
    readOnly: true,
    adapters: [{ id: 'api' }],
    origins: ['https://shop.example'],
    tags: ['orders', 'read'],
    ...overrides,
  };
}

function writeCapability(overrides = {}) {
  return {
    id: 'orders.update',
    version: '1',
    name: 'Update an order',
    description: 'Change an order status',
    readOnly: false,
    adapters: [{ id: 'api' }],
    origins: ['https://shop.example'],
    tags: ['orders', 'write'],
    ...overrides,
  };
}

function makeCatalog() {
  return new CapabilityCatalog({ capabilities: [readCapability(), writeCapability()] });
}

function makePlan({ withMutation = false } = {}) {
  const planner = new DeterministicPlanner({ catalog: makeCatalog() });
  return planner.propose({
    identity: alice,
    workflowId: withMutation ? 'order-update' : 'order-read',
    revision: 1,
    nodes: withMutation ? [
      { id: 'update', capabilityId: 'orders.update', args: { status: 'paid', orderId: 'o-1' } },
      { id: 'list', capabilityId: 'orders.list', args: {}, dependsOn: ['update'] },
    ] : [
      { id: 'z-list', capabilityId: 'orders.list', args: { page: 1 } },
      { id: 'a-list', capabilityId: 'orders.list', args: { page: 2 } },
    ],
  });
}

function assertCoreError(action, code) {
  assert.throws(action, (error) => {
    assert.ok(error instanceof CoreError);
    assert.equal(error.code, code);
    assert.equal(typeof error.message, 'string');
    assert.equal(typeof error.retryable, 'boolean');
    return true;
  });
}

async function assertCoreErrorAsync(action, code) {
  await assert.rejects(action, (error) => {
    assert.ok(error instanceof CoreError);
    assert.equal(error.code, code);
    assert.equal(typeof error.message, 'string');
    assert.equal(typeof error.retryable, 'boolean');
    return true;
  });
}

test('canonical serialization sorts object keys and hashes deterministically', () => {
  assert.equal(stableStringify({ z: 1, a: { y: 2, x: 3 } }), '{"a":{"x":3,"y":2},"z":1}');
  assert.equal(canonicalHash({ a: 1, b: 2 }), canonicalHash({ b: 2, a: 1 }));
  assert.throws(() => stableStringify({ value: undefined }), /Undefined value/);
  assert.throws(() => stableStringify({ value: NaN }), /Non-finite number/);
});

test('catalog requires explicit identity and isolates tenant registrations', () => {
  const catalog = makeCatalog();
  assertCoreError(() => catalog.search({ query: 'orders' }), 'IDENTITY_REQUIRED');
  catalog.register({ identity: alice, capability: readCapability({ id: 'private.lookup' }) });
  assert.equal(catalog.search({ identity: alice, query: 'private' }).capabilities.length, 1);
  assert.equal(catalog.search({ identity: bob, query: 'private' }).capabilities.length, 0);
  assertCoreError(() => catalog.describe({ identity: bob, capabilityId: 'private.lookup', version: '1' }), 'CAPABILITY_NOT_FOUND');
});

test('catalog search is deterministic, filtered, and describe returns full schema', () => {
  const catalog = makeCatalog();
  const first = catalog.search({ identity: alice, query: 'orders', tags: ['read'], adapter: 'api', origin: 'https://shop.example' });
  const second = catalog.search({ identity: alice, query: 'orders', tags: ['read'], adapter: 'api', origin: 'https://shop.example' });
  assert.deepEqual(first, second);
  assert.deepEqual(first.capabilities.map((entry) => entry.id), ['orders.list']);
  assert.equal(catalog.describe({ identity: alice, capabilityId: 'orders.list', version: '1' }).inputSchema.constructor, Object);
  assert.equal(catalog.has({ identity: bob, capabilityId: 'orders.list', version: '1' }), true);
  assert.equal(catalog.search({ identity: alice, readOnly: false }).capabilities[0].id, 'orders.update');
});

test('catalog rejects executable/raw capability primitives and conflicting mutability', () => {
  const catalog = new CapabilityCatalog();
  assertCoreError(() => catalog.register({ identity: alice, capability: { id: 'raw.click', readOnly: true } }), 'UNSAFE_CAPABILITY');
  assertCoreError(() => catalog.register({ identity: alice, capability: { id: 'safe.read', readOnly: true, script: 'x' } }), 'UNSAFE_CAPABILITY');
  assertCoreError(() => catalog.register({ identity: alice, capability: { id: 'safe.read', readOnly: true, mutates: true } }), 'INVALID_CAPABILITY');
  assertCoreError(() => catalog.register({ identity: alice, capability: { id: 'safe.read' } }), 'INVALID_CAPABILITY');
});

test('planner validates graph and uses lexical Kahn ordering for ties', () => {
  const planner = new DeterministicPlanner({ catalog: makeCatalog() });
  const plan = planner.propose({
    identity: alice,
    workflowId: 'deterministic',
    nodes: [
      { id: 'z', capabilityId: 'orders.list', args: { x: 1 } },
      { id: 'b', capabilityId: 'orders.list', args: { x: 2 }, dependsOn: ['z'] },
      { id: 'a', capabilityId: 'orders.list', args: { x: 3 } },
    ],
  });
  assert.deepEqual(plan.order, ['a', 'z', 'b']);
  assert.deepEqual(plan.edges, [{ from: 'z', to: 'b' }]);
  assert.equal(plan.readOnly, true);
  assert.deepEqual(plan.requiresApproval, []);
  assert.equal(plan.nodes.find((node) => node.id === 'a').adapter, 'api');
  assert.equal(plan.nodes.find((node) => node.id === 'a').origin, 'https://shop.example');
  assert.equal(plan.planHash, planner.propose({
    identity: alice,
    workflowId: 'deterministic',
    nodes: [
      { id: 'a', capabilityId: 'orders.list', args: { x: 3 } },
      { id: 'b', capabilityId: 'orders.list', args: { x: 2 }, dependsOn: ['z'] },
      { id: 'z', capabilityId: 'orders.list', args: { x: 1 } },
    ],
  }).planHash);
});

test('planner rejects duplicate, unknown, cyclic, unsafe, and mutability-mismatched nodes', () => {
  const planner = new DeterministicPlanner({ catalog: makeCatalog() });
  const base = { identity: alice, workflowId: 'invalid-plan' };
  assertCoreError(() => planner.propose({ ...base, nodes: [
    { id: 'a', capabilityId: 'orders.list' }, { id: 'a', capabilityId: 'orders.list' },
  ] }), 'INVALID_PLAN');
  assertCoreError(() => planner.propose({ ...base, nodes: [{ id: 'a', capabilityId: 'missing' }] }), 'CAPABILITY_NOT_FOUND');
  assertCoreError(() => planner.propose({ ...base, nodes: [
    { id: 'a', capabilityId: 'orders.list', dependsOn: ['b'] }, { id: 'b', capabilityId: 'orders.list', dependsOn: ['a'] },
  ] }), 'PLAN_CYCLE');
  assertCoreError(() => planner.propose({ ...base, nodes: [{ id: 'a', capabilityId: 'orders.list', code: 'x' }] }), 'UNSAFE_PLAN');
  assertCoreError(() => planner.propose({ ...base, nodes: [{ id: 'a', capabilityId: 'orders.list', readOnly: false }] }), 'INVALID_PLAN');
});

test('workflow store enforces ownership and lifecycle transitions', () => {
  const store = new WorkflowStore({ clock: () => '2026-01-01T00:00:00.000Z' });
  const plan = makePlan();
  const created = store.create({ identity: alice, workflowId: plan.workflowId, revision: 1 });
  assert.equal(created.state, 'draft');
  const proposed = store.propose({ identity: alice, workflowId: plan.workflowId, revision: 1, plan });
  assert.equal(proposed.state, 'proposed');
  assertCoreError(() => store.status({ identity: bob, workflowId: plan.workflowId, revision: 1 }), 'WORKFLOW_NOT_FOUND');
  assertCoreError(() => store.transition({ identity: alice, workflowId: plan.workflowId, revision: 1, to: 'completed' }), 'WORKFLOW_STATE');
  const running = store.start({ identity: alice, workflowId: plan.workflowId, revision: 1 });
  assert.equal(running.state, 'running');
  for (const nodeId of plan.order) {
    store.markNode({ identity: alice, workflowId: plan.workflowId, revision: 1, nodeId, state: 'running' });
    store.markNode({ identity: alice, workflowId: plan.workflowId, revision: 1, nodeId, state: 'completed', output: { nodeId } });
  }
  const completed = store.complete({ identity: alice, workflowId: plan.workflowId, revision: 1 });
  assert.equal(completed.state, 'completed');
  assertCoreError(() => store.cancel({ identity: alice, workflowId: plan.workflowId, revision: 1 }), 'WORKFLOW_STATE');
});

test('workflow state machine exposes awaiting approval and forbids invalid node transitions', () => {
  const store = new WorkflowStore({ clock: () => '2026-01-01T00:00:00.000Z' });
  const plan = makePlan({ withMutation: true });
  store.create({ identity: alice, workflowId: plan.workflowId, revision: 1 });
  store.propose({ identity: alice, workflowId: plan.workflowId, revision: 1, plan });
  store.start({ identity: alice, workflowId: plan.workflowId, revision: 1 });
  assertCoreError(() => store.markNode({ identity: alice, workflowId: plan.workflowId, revision: 1, nodeId: 'update', state: 'completed', output: null }), 'NODE_STATE');
  const awaiting = store.awaitApproval({ identity: alice, workflowId: plan.workflowId, revision: 1, nodeId: 'update', request: { argumentHash: plan.nodes[0].argumentHash } });
  assert.equal(awaiting.state, 'awaiting_approval');
  assert.equal(awaiting.nodeStates.update.state, 'awaiting_approval');
  const resumed = store.resume({ identity: alice, workflowId: plan.workflowId, revision: 1, nodeId: 'update' });
  assert.equal(resumed.state, 'running');
});

test('broker executes read-only DAG sequentially and records outputs', async () => {
  const catalog = makeCatalog();
  const planner = new DeterministicPlanner({ catalog });
  const plan = planner.propose({ identity: alice, workflowId: 'read-run', nodes: [
    { id: 'first', capabilityId: 'orders.list', args: { n: 1 } },
    { id: 'second', capabilityId: 'orders.list', args: { n: 2 }, dependsOn: ['first'] },
  ] });
  const store = new WorkflowStore({ clock: () => '2026-01-01T00:00:00.000Z' });
  store.create({ identity: alice, workflowId: plan.workflowId, revision: 1 });
  store.propose({ identity: alice, workflowId: plan.workflowId, revision: 1, plan });
  const calls = [];
  const broker = new ExecutionBroker({
    catalog,
    store,
    adapters: { api: { execute: async (request) => { calls.push(request); return { got: request.args.n }; } } },
  });
  const result = await broker.execute({ identity: alice, workflowId: plan.workflowId, revision: 1 });
  assert.equal(result.state, 'completed');
  assert.deepEqual(calls.map((call) => call.nodeId), ['first', 'second']);
  assert.deepEqual(result.results, [{ nodeId: 'first', output: { got: 1 } }, { nodeId: 'second', output: { got: 2 } }]);
  const status = broker.status({ identity: alice, workflowId: plan.workflowId, revision: 1 });
  assert.equal(status.nodeStates.first.attempts, 1);
});

test('broker fail-closes mutating execution until trusted approval and binds all fields', async () => {
  const catalog = makeCatalog();
  const plan = makePlan({ withMutation: true });
  const store = new WorkflowStore({ clock: () => '2026-01-01T00:00:00.000Z' });
  store.create({ identity: alice, workflowId: plan.workflowId, revision: 1 });
  store.propose({ identity: alice, workflowId: plan.workflowId, revision: 1, plan });
  const calls = [];
  const approvals = [];
  let approved = false;
  const broker = new ExecutionBroker({
    catalog,
    store,
    approvalVerifier: async (binding) => { approvals.push(binding); return approved; },
    adapters: { api: { execute: async (request) => { calls.push(request.nodeId); return { ok: true }; } } },
  });
  const waiting = await broker.execute({ identity: alice, workflowId: plan.workflowId, revision: 1 });
  assert.equal(waiting.state, 'awaiting_approval');
  assert.equal(waiting.approvalRequired.nodeId, 'update');
  assert.deepEqual(calls, []);
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0].tenantId, alice.tenantId);
  assert.equal(approvals[0].subjectId, alice.subjectId);
  assert.equal(approvals[0].workflowId, plan.workflowId);
  assert.equal(approvals[0].revision, 1);
  assert.equal(approvals[0].nodeId, 'update');
  assert.equal(approvals[0].origin, 'https://shop.example');
  assert.equal(approvals[0].adapter, 'api');
  assert.equal(approvals[0].argumentHash, plan.nodes.find((node) => node.id === 'update').argumentHash);
  approved = true;
  const completed = await broker.execute({ identity: alice, workflowId: plan.workflowId, revision: 1 });
  assert.equal(completed.state, 'completed');
  assert.deepEqual(calls, ['update', 'list']);
  assert.equal(approvals.length, 2);
  await assertCoreErrorAsync(() => broker.execute({ identity: alice, workflowId: plan.workflowId, revision: 1, approval: { approved: true } }), 'UNTRUSTED_APPROVAL');
});

test('broker never replays mutating nodes and only re-runs completed read-only recordings', async () => {
  const catalog = makeCatalog();
  const plan = makePlan({ withMutation: true });
  const store = new WorkflowStore({ clock: () => '2026-01-01T00:00:00.000Z' });
  store.create({ identity: alice, workflowId: plan.workflowId, revision: 1 });
  store.propose({ identity: alice, workflowId: plan.workflowId, revision: 1, plan });
  const replayCalls = [];
  const broker = new ExecutionBroker({
    catalog,
    store,
    approvalStore: { consume: async () => true },
    adapters: { api: { execute: async (request) => { replayCalls.push({ nodeId: request.nodeId, replay: request.replay }); return { nodeId: request.nodeId, replay: request.replay }; } } },
  });
  await broker.execute({ identity: alice, workflowId: plan.workflowId, revision: 1 });
  const replay = await broker.replayReadonly({ identity: alice, workflowId: plan.workflowId, revision: 1, nodeIds: ['list'] });
  assert.equal(replay.readOnly, true);
  assert.deepEqual(replay.nodes.map((node) => node.nodeId), ['list']);
  assert.equal(replayCalls.at(-1).replay, true);
  await assertCoreErrorAsync(() => broker.replayReadonly({ identity: alice, workflowId: plan.workflowId, revision: 1, nodeIds: ['update'] }), 'REPLAY_MUTATION_FORBIDDEN');
  await assertCoreErrorAsync(() => broker.replayReadonly({ identity: bob, workflowId: plan.workflowId, revision: 1, nodeIds: ['list'] }), 'WORKFLOW_NOT_FOUND');
});

test('replay rejects mixed mutation requests before invoking any node', async () => {
  const catalog = makeCatalog();
  const plan = makePlan({ withMutation: true });
  const store = new WorkflowStore();
  store.create({ identity: alice, workflowId: plan.workflowId, revision: 1 });
  store.propose({ identity: alice, workflowId: plan.workflowId, revision: 1, plan });
  const broker = new ExecutionBroker({ store, catalog, approvalStore: { consume: async () => true }, executor: () => ({}) });
  await broker.execute({ identity: alice, workflowId: plan.workflowId, revision: 1 });
  await assertCoreErrorAsync(() => broker.replayReadonly({ identity: alice, workflowId: plan.workflowId, revision: 1, nodeIds: ['list', 'update'] }), 'REPLAY_MUTATION_FORBIDDEN');
});

test('stored plans are identity-bound and tampering is detected', () => {
  const plan = makePlan();
  assertCoreError(() => validatePlan({ identity: bob, plan }), 'WORKFLOW_FORBIDDEN');
  const tampered = structuredClone(plan);
  tampered.nodes[0].args.page = 999;
  assertCoreError(() => validatePlan({ identity: alice, plan: tampered }), 'INVALID_PLAN');
});
