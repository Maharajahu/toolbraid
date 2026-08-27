import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CoreError,
  DeterministicPlanner,
  MAX_NODE_DEPENDENCIES,
  MAX_PLAN_DEPTH,
  MAX_PLAN_INPUT_BYTES,
  MAX_PLAN_NODES,
} from '../../src/core/index.js';
import {
  PUBLIC_TOOL_DEFINITIONS,
  RuntimeError,
  createCompositionRoot,
} from '../../src/runtime/composition-root.js';

const identity = Object.freeze({
  tenantId: 'tenant-a',
  subject: 'subject-a',
  origin: 'https://safe.example.test',
});

function descriptor() {
  return {
    id: 'records.read',
    version: '1',
    readOnly: true,
    adapters: [{ id: 'api' }],
    origins: [identity.origin],
  };
}

function runtime() {
  return createCompositionRoot({
    allowReadOnly: true,
    capabilities: [descriptor()],
    adapters: [{
      id: 'api',
      origin: identity.origin,
      capabilities: [{ id: 'records.read' }],
      async invoke() { return { ok: true }; },
    }],
  });
}

test('public schema bounds top-level and nested plan node collections', () => {
  const plan = PUBLIC_TOOL_DEFINITIONS.find(({ name }) => name === 'plan.propose');
  assert.equal(plan.inputSchema.properties.nodes.maxItems, MAX_PLAN_NODES);
  assert.equal(plan.inputSchema.properties.steps.maxItems, MAX_PLAN_NODES);
  assert.equal(plan.inputSchema.properties.request.properties.nodes.maxItems, MAX_PLAN_NODES);
  assert.equal(
    plan.inputSchema.properties.nodes.items.properties.dependsOn.maxItems,
    MAX_NODE_DEPENDENCIES,
  );
});

test('composition rejects excessive nodes before cloning or planning them', async () => {
  const instance = runtime();
  const nodes = Array.from({ length: MAX_PLAN_NODES + 1 }, (_, index) => ({
    nodeId: `node-${index + 1}`,
    capabilityId: 'records.read',
    args: {},
  }));
  await assert.rejects(
    instance.callTool('plan.propose', { ...identity, request: { nodes } }),
    (error) => error instanceof RuntimeError && error.code === 'PLAN_LIMIT_EXCEEDED',
  );
  assert.equal(instance.workflows.size, 0);
});

test('core planner bounds dependency fan-in and aggregate JSON size', () => {
  let resolves = 0;
  const planner = new DeterministicPlanner({
    catalog: {
      resolve() {
        resolves += 1;
        return descriptor();
      },
    },
  });
  const dependencies = Array.from(
    { length: MAX_NODE_DEPENDENCIES + 1 },
    (_, index) => `dependency-${index + 1}`,
  );
  assert.throws(
    () => planner.propose({
      identity,
      nodes: [{ id: 'target', capabilityId: 'records.read', dependsOn: dependencies, args: {} }],
    }),
    (error) => error instanceof CoreError && error.code === 'PLAN_LIMIT_EXCEEDED',
  );
  assert.equal(resolves, 0);

  const oversized = 'x'.repeat(MAX_PLAN_INPUT_BYTES + 1);
  assert.throws(
    () => planner.propose({
      identity,
      nodes: [{ id: 'large', capabilityId: 'records.read', args: { oversized } }],
    }),
    (error) => error instanceof CoreError && error.code === 'PLAN_LIMIT_EXCEEDED',
  );
});

test('deeply nested plan arguments fail before recursive canonicalization', async () => {
  let nested = { value: true };
  for (let depth = 0; depth <= MAX_PLAN_DEPTH; depth += 1) nested = { nested };
  await assert.rejects(
    runtime().callTool('plan.propose', {
      ...identity,
      nodes: [{ nodeId: 'deep', capabilityId: 'records.read', args: nested }],
    }),
    (error) => error instanceof RuntimeError && error.code === 'PLAN_LIMIT_EXCEEDED',
  );
});
