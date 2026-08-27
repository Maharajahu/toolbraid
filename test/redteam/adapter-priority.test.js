import test from 'node:test';
import assert from 'node:assert/strict';

import { CapabilityCatalog, DeterministicPlanner } from '../../src/core/index.js';

const IDENTITY = { tenantId: 'tenant-a', subjectId: 'user-a' };

function planner() {
  const catalog = new CapabilityCatalog({
    capabilities: [{
      id: 'orders.lookup',
      version: '1',
      readOnly: true,
      origins: ['https://shop.example.test'],
      // Deliberately place the weaker route first.  Catalog ordering and
      // client input must not control the trust ladder.
      adapters: [
        { id: 'vision.fallback', kind: 'vision' },
        { id: 'webmcp', kind: 'webmcp' },
        { id: 'structured.orders', kind: 'structured-api' },
      ],
    }],
  });
  return new DeterministicPlanner({ catalog });
}

test('planner selects the strongest server-approved adapter regardless of catalog order', () => {
  const plan = planner().propose({
    identity: IDENTITY,
    workflowId: 'trusted-adapter-choice',
    nodes: [{ id: 'lookup', capabilityId: 'orders.lookup', args: {} }],
  });
  assert.equal(plan.nodes[0].adapter, 'structured.orders');
});

test('client cannot downgrade a capability to a weaker allowed adapter', () => {
  assert.throws(
    () => planner().propose({
      identity: IDENTITY,
      workflowId: 'adapter-downgrade',
      nodes: [{ id: 'lookup', capabilityId: 'orders.lookup', adapterId: 'webmcp', args: {} }],
    }),
    (error) => error?.code === 'ADAPTER_DOWNGRADE_FORBIDDEN',
  );
});

test('an explicit adapter is accepted only when it matches the server selection', () => {
  const plan = planner().propose({
    identity: IDENTITY,
    workflowId: 'matching-adapter',
    nodes: [{ id: 'lookup', capabilityId: 'orders.lookup', adapter: 'structured.orders', args: {} }],
  });
  assert.equal(plan.nodes[0].adapter, 'structured.orders');
});
