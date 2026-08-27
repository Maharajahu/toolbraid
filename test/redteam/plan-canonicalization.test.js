import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CapabilityCatalog,
  DeterministicPlanner,
  hashPlan,
  validatePlan,
} from '../../src/core/index.js';

const IDENTITY = { tenantId: 'tenant-a', subjectId: 'subject-a' };

test('stored plans reject proposal-only dependency aliases even after re-hashing', () => {
  const catalog = new CapabilityCatalog({ capabilities: [{
    id: 'orders.lookup',
    version: '1',
    readOnly: true,
    adapters: [{ id: 'structured.orders', kind: 'structured-api' }],
    origins: ['https://shop.example.test'],
  }] });
  const plan = new DeterministicPlanner({ catalog }).propose({
    identity: IDENTITY,
    workflowId: 'canonical-dependencies',
    nodes: [
      { id: 'first', capabilityId: 'orders.lookup', args: {} },
      { id: 'second', capabilityId: 'orders.lookup', args: {}, dependsOn: ['first'] },
    ],
  });
  const tampered = structuredClone(plan);
  tampered.nodes[1].dependencies = tampered.nodes[1].dependsOn;
  delete tampered.nodes[1].dependsOn;
  tampered.planHash = hashPlan(tampered);

  assert.throws(
    () => validatePlan({ identity: IDENTITY, plan: tampered }),
    (error) => error?.code === 'INVALID_PLAN',
  );
});
