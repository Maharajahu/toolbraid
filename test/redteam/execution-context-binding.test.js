import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CapabilityCatalog,
  CoreError,
  DeterministicPlanner,
  ExecutionBroker,
  WorkflowStore,
} from '../../src/core/index.js';

const IDENTITY = { tenantId: 'tenant-context', subjectId: 'subject-context' };
const GOOD_ORIGIN = 'https://shop.context.test';
const EVIL_ORIGIN = 'https://evil.context.test';

function seed({ readOnly = false, workflowId = 'context-binding', adapterId = 'api' } = {}) {
  const capabilityId = readOnly ? 'orders.read' : 'orders.update';
  const catalog = new CapabilityCatalog({ capabilities: [{
    id: capabilityId,
    version: '1',
    readOnly,
    adapters: [{ id: adapterId, kind: 'structured-api', version: '1' }],
    origins: [GOOD_ORIGIN],
    inputSchema: { type: 'object', additionalProperties: false },
    outputSchema: { type: 'object', additionalProperties: true },
  }] });
  const plan = new DeterministicPlanner({ catalog }).propose({
    identity: IDENTITY,
    workflowId,
    nodes: [{ id: 'node', capabilityId, args: {} }],
  });
  const store = new WorkflowStore({ clock: () => '2026-01-01T00:00:00.000Z' });
  store.create({ identity: IDENTITY, workflowId: plan.workflowId, revision: plan.revision });
  store.propose({ identity: IDENTITY, workflowId: plan.workflowId, revision: plan.revision, plan });
  return { catalog, plan, store, capabilityId, adapterId };
}

function executeInput(plan, overrides = {}) {
  return {
    identity: IDENTITY,
    workflowId: plan.workflowId,
    revision: plan.revision,
    ...overrides,
  };
}

function isContextError(error) {
  return error instanceof CoreError && error.code === 'EXECUTION_CONTEXT';
}

test('wrong execution origin and adapter are rejected before state or approval changes', async () => {
  const { catalog, plan, store, adapterId } = seed({ workflowId: 'wrong-context' });
  let approvalCalls = 0;
  let adapterCalls = 0;
  const broker = new ExecutionBroker({
    catalog,
    store,
    approvalStore: {
      async verifyAndConsume() {
        approvalCalls += 1;
        return true;
      },
    },
    adapters: {
      [adapterId]: {
        execute: async () => {
          adapterCalls += 1;
          return { committed: true };
        },
      },
    },
  });

  await assert.rejects(
    broker.execute(executeInput(plan, { origin: EVIL_ORIGIN, adapter: adapterId })),
    isContextError,
  );
  await assert.rejects(
    broker.execute(executeInput(plan, { origin: GOOD_ORIGIN, adapter: 'other-adapter' })),
    isContextError,
  );

  const snapshot = store.get({ identity: IDENTITY, workflowId: plan.workflowId, revision: plan.revision });
  assert.equal(snapshot.state, 'proposed');
  assert.equal(snapshot.nodeStates.node.state, 'pending');
  assert.equal(approvalCalls, 0);
  assert.equal(adapterCalls, 0);
});

test('a concurrent evil-origin execution cannot receive the good-origin promise result', async () => {
  const { catalog, plan, store, adapterId } = seed({ readOnly: true, workflowId: 'concurrent-context' });
  let release;
  let started;
  const startedPromise = new Promise((resolve) => { started = resolve; });
  const blocked = new Promise((resolve) => { release = resolve; });
  let adapterCalls = 0;
  const broker = new ExecutionBroker({
    catalog,
    store,
    adapters: {
      [adapterId]: {
        execute: async () => {
          adapterCalls += 1;
          started();
          await blocked;
          return { status: 'ok' };
        },
      },
    },
  });

  const good = broker.execute(executeInput(plan, { origin: GOOD_ORIGIN, adapter: adapterId }));
  await startedPromise;
  const evil = broker.execute(executeInput(plan, { origin: EVIL_ORIGIN, adapter: adapterId }));
  await assert.rejects(evil, isContextError);

  release();
  const completed = await good;
  assert.equal(completed.state, 'completed');
  assert.equal(adapterCalls, 1);
});

test('same-version capability descriptor drift is rejected before execution', async () => {
  const { catalog, plan, store, capabilityId, adapterId } = seed({ readOnly: true, workflowId: 'binding-drift' });
  let adapterCalls = 0;
  catalog.register({
    identity: IDENTITY,
    replace: true,
    capability: {
      id: capabilityId,
      version: '1',
      readOnly: true,
      adapters: [{ id: adapterId, kind: 'structured-api', version: '1' }],
      origins: [GOOD_ORIGIN],
      inputSchema: { type: 'object', additionalProperties: false },
      // Same id/version, but an execution-relevant output schema change.
      outputSchema: { type: 'object', required: ['changed'], additionalProperties: true },
    },
  });
  const broker = new ExecutionBroker({
    catalog,
    store,
    adapters: {
      [adapterId]: {
        execute: async () => {
          adapterCalls += 1;
          return { changed: true };
        },
      },
    },
  });

  await assert.rejects(
    broker.execute(executeInput(plan, { origin: GOOD_ORIGIN, adapter: adapterId })),
    (error) => error instanceof CoreError && error.code === 'INVALID_PLAN' && error.details?.reason === 'CAPABILITY_BINDING_DRIFT',
  );
  const snapshot = store.get({ identity: IDENTITY, workflowId: plan.workflowId, revision: plan.revision });
  assert.equal(snapshot.state, 'proposed');
  assert.equal(adapterCalls, 0);
});
