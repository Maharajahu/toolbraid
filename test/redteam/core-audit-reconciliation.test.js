import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CapabilityCatalog,
  CoreError,
  DeterministicPlanner,
  ExecutionBroker,
  WorkflowStore,
} from '../../src/core/index.js';

const IDENTITY = Object.freeze({ tenantId: 'tenant-a', subjectId: 'subject-a' });
const ORIGIN = 'https://shop.example';

function makeExecution(failingEvent) {
  const catalog = new CapabilityCatalog({
    capabilities: [{
      id: 'orders.update',
      version: '1',
      readOnly: false,
      adapters: [{ id: 'api' }],
      origins: [ORIGIN],
    }],
  });
  const plan = new DeterministicPlanner({ catalog }).propose({
    identity: IDENTITY,
    workflowId: `audit-${failingEvent.replaceAll('_', '-')}`,
    revision: 1,
    nodes: [{
      id: 'update',
      capabilityId: 'orders.update',
      args: { orderId: 'order-1', status: 'paid' },
    }],
  });
  const store = new WorkflowStore({ clock: () => '2026-01-01T00:00:00.000Z' });
  store.create({ identity: IDENTITY, workflowId: plan.workflowId, revision: 1, plan });
  const calls = [];
  const broker = new ExecutionBroker({
    catalog,
    store,
    approvalVerifier: async () => true,
    adapters: {
      api: {
        execute: async (request) => {
          calls.push(request.nodeId);
          return { updated: true };
        },
      },
    },
    audit: {
      append: async (event) => {
        if (event.type === failingEvent) throw new Error('audit sink unavailable');
      },
    },
  });
  const input = { identity: IDENTITY, workflowId: plan.workflowId, revision: 1 };
  return { broker, calls, input, store };
}

test('node completion audit failure terminalizes a committed side effect for reconciliation', async () => {
  const { broker, calls, input, store } = makeExecution('node_completed');

  await assert.rejects(
    broker.execute(input),
    (error) => {
      assert.ok(error instanceof CoreError);
      assert.equal(error.code, 'RECONCILIATION_REQUIRED');
      assert.equal(error.retryable, false);
      assert.deepEqual(error.details, {
        effectCommitted: true,
        phase: 'node_completed',
        nodeId: 'update',
      });
      return true;
    },
  );

  const failed = store.get(input);
  assert.equal(failed.state, 'failed');
  assert.equal(failed.error.code, 'RECONCILIATION_REQUIRED');
  assert.equal(failed.error.retryable, false);
  assert.equal(failed.nodeStates.update.state, 'completed');
  assert.deepEqual(calls, ['update']);

  const repeated = await broker.execute(input);
  assert.equal(repeated.state, 'failed');
  assert.deepEqual(calls, ['update']);
});

test('workflow completion audit failure keeps completion terminal and never repeats the side effect', async () => {
  const { broker, calls, input, store } = makeExecution('workflow_completed');

  await assert.rejects(
    broker.execute(input),
    (error) => error instanceof CoreError &&
      error.code === 'RECONCILIATION_REQUIRED' &&
      error.retryable === false &&
      error.details?.phase === 'workflow_completed',
  );

  assert.equal(store.get(input).state, 'completed');
  assert.deepEqual(calls, ['update']);
  const repeated = await broker.execute(input);
  assert.equal(repeated.state, 'completed');
  assert.deepEqual(calls, ['update']);
});
