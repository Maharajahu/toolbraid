import test from 'node:test';
import assert from 'node:assert/strict';
import { CAPABILITY_BY_ID } from '../js/core/ontology.js';
import { RISK_LEVELS } from '../js/core/risk.js';
import { buildTripPlan, getRunnableNodes } from '../js/core/planner.js';

function mapping(capabilityId) {
  const reversible = capabilityId.endsWith('.hold');
  return {
    capability: CAPABILITY_BY_ID.get(capabilityId),
    confidence: 0.92,
    quarantined: false,
    risk: reversible ? RISK_LEVELS.REVERSIBLE : RISK_LEVELS.READ_ONLY,
    schema: { type: 'object', properties: {} },
    tool: { name: `provider.${capabilityId.replace('.', '_')}`, description: capabilityId },
  };
}

const mission = {
  origin: 'Coventry', destination: 'London', destinationAddress: '1 Principal Place',
  date: '2026-08-26', budget: 250, currency: 'GBP', passengers: 1, nights: 1,
};

test('builds a seven-node dependency graph with two explicit approval gates', () => {
  const mappings = [
    mapping('travel.search'), mapping('accommodation.search'), mapping('location.distance'),
    mapping('travel.hold'), mapping('accommodation.hold'),
  ];
  const plan = buildTripPlan(mission, mappings);
  assert.equal(plan.nodes.length, 7);
  assert.equal(plan.nodes.filter((node) => node.approvalRequired).length, 2);
  assert.deepEqual(getRunnableNodes(plan).map((node) => node.id).sort(), ['stay-search', 'travel-search']);
  assert.equal(getRunnableNodes(plan, { includeApproval: true }).some((node) => node.approvalRequired), false);
});

test('fails closed when a required capability is absent', () => {
  const mappings = [mapping('travel.search'), mapping('accommodation.search')];
  assert.throws(
    () => buildTripPlan(mission, mappings),
    (error) => error.code === 'CAPABILITY_GAP' && error.missing.includes('location.distance'),
  );
});

test('retains lower-ranked compatible providers as read-only failover candidates', () => {
  const primary = mapping('travel.search');
  primary.tool.name = 'primary.travel_search';
  primary.confidence = 0.96;
  const fallback = mapping('travel.search');
  fallback.tool.name = 'fallback.find_routes';
  fallback.confidence = 0.81;
  const mappings = [
    primary, fallback, mapping('accommodation.search'), mapping('location.distance'),
    mapping('travel.hold'), mapping('accommodation.hold'),
  ];
  const plan = buildTripPlan(mission, mappings);
  const travelNode = plan.nodes.find((node) => node.id === 'travel-search');
  assert.equal(travelNode.mapping.tool.name, 'primary.travel_search');
  assert.deepEqual(travelNode.alternatives.map((item) => item.tool.name), ['fallback.find_routes']);
});
