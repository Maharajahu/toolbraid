import assert from 'node:assert/strict';
import test from 'node:test';

import {
  NODE_STATUS,
  approveNodes,
  createPlan,
  invalidatePlan,
  runnableNodes,
  validateGraphNodes,
} from '../../src/engine/graph.js';

function sampleNodes() {
  return [
    { id: 'health', dependencies: [], approvalRequired: false },
    { id: 'release', dependencies: [], approvalRequired: false },
    { id: 'correlate', dependencies: ['health', 'release'], approvalRequired: false },
    { id: 'apply', dependencies: ['correlate'], approvalRequired: true, arguments: { revision: 'r2' } },
  ];
}

test('validates dependencies and rejects cycles', () => {
  assert.equal(validateGraphNodes(sampleNodes()), true);
  assert.throws(
    () => validateGraphNodes([
      { id: 'a', dependencies: ['b'] },
      { id: 'b', dependencies: ['a'] },
    ]),
    (error) => error.code === 'GRAPH_CYCLE',
  );
});

test('returns independent safe nodes as one parallel batch', () => {
  const plan = createPlan({ id: 'plan-1', objective: 'recover', nodes: sampleNodes() });
  assert.deepEqual(runnableNodes(plan).map((node) => node.id), ['health', 'release']);

  plan.nodes.find((node) => node.id === 'health').status = NODE_STATUS.COMPLETED;
  plan.nodes.find((node) => node.id === 'release').status = NODE_STATUS.COMPLETED;
  assert.deepEqual(runnableNodes(plan).map((node) => node.id), ['correlate']);
});

test('keeps mutations blocked until separately approved', () => {
  const plan = createPlan({ id: 'plan-1', objective: 'recover', nodes: sampleNodes() });
  for (const id of ['health', 'release', 'correlate']) {
    plan.nodes.find((node) => node.id === id).status = NODE_STATUS.COMPLETED;
  }

  assert.deepEqual(runnableNodes(plan), []);
  approveNodes(plan, ['apply']);
  assert.deepEqual(runnableNodes(plan, { includeApprovedMutations: true }).map((node) => node.id), ['apply']);
});

test('tool changes invalidate pending approvals and increment plan revision', () => {
  const plan = createPlan({ id: 'plan-1', objective: 'recover', nodes: sampleNodes() });
  approveNodes(plan, ['apply']);
  invalidatePlan(plan, 'toolchange', new Date('2026-08-27T12:00:00Z'));

  assert.equal(plan.revision, 2);
  assert.equal(plan.status, 'invalidated');
  assert.equal(plan.nodes.find((node) => node.id === 'apply').status, NODE_STATUS.INVALIDATED);
});

test('preserves opaque native WebMCP handles while cloning approval arguments', () => {
  const nativeHandle = {
    origin: 'https://provider.test',
    name: 'apply',
    window: { cannotBeCloned: () => true },
  };
  const argumentsObject = { deploymentId: 'dep-1' };
  const plan = createPlan({
    id: 'plan-opaque',
    objective: 'recover',
    nodes: [{
      id: 'apply',
      dependencies: [],
      approvalRequired: true,
      candidates: [{ tool: nativeHandle, arguments: argumentsObject }],
    }],
  });

  assert.strictEqual(plan.nodes[0].candidates[0].tool, nativeHandle);
  assert.notStrictEqual(plan.nodes[0].candidates[0].arguments, argumentsObject);
  assert.deepEqual(plan.nodes[0].candidates[0].arguments, argumentsObject);
});
