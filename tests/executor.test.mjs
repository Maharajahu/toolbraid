import test from 'node:test';
import assert from 'node:assert/strict';
import { composeCandidates, rankRecommendation } from '../js/core/executor.js';

const travel = [
  { id: 'VR-0745', provider: 'West Midlands Railway', price: 39.9 },
  { id: 'VR-0631', provider: 'Avanti West Coast', price: 52.4 },
];
const stays = [
  { id: 'NS-POINT-A', label: 'Point A Liverpool Street', price: 145 },
  { id: 'NS-CITIZENM', label: 'citizenM Shoreditch', price: 202 },
];

test('composes canonical provider outputs without provider-specific branches', () => {
  const result = composeCandidates(travel, stays);
  assert.equal(result.candidates.length, 4);
  assert.equal(result.candidates[0].id, 'VR-0745::NS-POINT-A');
  assert.equal(result.candidates[0].subtotal, 184.9);
});

test('ranks the best feasible option using total cost and walking access', () => {
  const candidates = composeCandidates(travel, stays);
  const result = rankRecommendation(candidates, [
    { id: 'NS-POINT-A', walkingMinutes: 13, distanceKm: 1 },
    { id: 'NS-CITIZENM', walkingMinutes: 15, distanceKm: 1.1 },
  ], { budget: 250, currency: 'GBP' });
  assert.equal(result.travel.id, 'VR-0745');
  assert.equal(result.stay.id, 'NS-POINT-A');
  assert.equal(result.subtotal, 184.9);
  assert.equal(result.savings, 65.1);
});

test('rejects a mission when every combination exceeds the budget', () => {
  const candidates = composeCandidates(travel, stays);
  assert.throws(
    () => rankRecommendation(candidates, [{ id: 'NS-POINT-A', walkingMinutes: 13, distanceKm: 1 }], { budget: 100, currency: 'GBP' }),
    (error) => error.code === 'NO_FEASIBLE_OPTION',
  );
});

test('fails over dynamically to a compatible read-only provider', async () => {
  const attempts = [];
  const primary = { tool: { name: 'primary.search' }, schema: { type: 'object', properties: {} }, risk: 0 };
  const fallback = { tool: { name: 'fallback.search' }, schema: { type: 'object', properties: {} }, risk: 0 };
  const node = {
    id: 'travel-search', type: 'tool', label: 'Search travel', capabilityId: 'travel.search',
    mapping: primary, alternatives: [fallback], dependencies: [], risk: 0,
    approvalRequired: false, status: 'pending', result: null, error: null,
  };
  const plan = { nodes: [node], status: 'planned' };
  const runtime = {
    async executeTool(tool) {
      attempts.push(tool.name);
      if (tool.name === 'primary.search') throw new Error('provider unavailable');
      return JSON.stringify({ journeys: [{ quoteId: 'F-1', operator: 'Fallback Rail', fare: 40 }] });
    },
  };
  const { runPlanUntilBlocked } = await import('../js/core/executor.js');
  const result = await runPlanUntilBlocked(plan, {
    mission: { origin: 'Coventry', destination: 'London', date: '2026-08-27', passengers: 1 },
    results: new Map(), runtime,
  });
  assert.deepEqual(attempts, ['primary.search', 'fallback.search']);
  assert.equal(node.mapping.tool.name, 'fallback.search');
  assert.equal(result.status, 'completed');
});

test('never substitutes an approved mutating provider action', async () => {
  const attempts = [];
  const base = { schema: { type: 'object', properties: { quoteId: { type: 'string' } }, required: ['quoteId'] }, risk: 1 };
  const node = {
    id: 'travel-hold', type: 'tool', label: 'Hold fare', capabilityId: 'travel.hold',
    mapping: { ...base, tool: { name: 'primary.freeze_quote' } },
    alternatives: [{ ...base, tool: { name: 'fallback.hold_fare' } }], dependencies: [],
    risk: 1, approvalRequired: true, status: 'approved', result: null, error: null,
  };
  const plan = { nodes: [node], status: 'approved' };
  const { runPlanUntilBlocked } = await import('../js/core/executor.js');
  await assert.rejects(
    () => runPlanUntilBlocked(plan, {
      mission: {}, results: new Map([['recommendation', { travel: { id: 'VR-1' } }]]),
      runtime: { async executeTool(tool) { attempts.push(tool.name); throw new Error('unavailable'); } },
    }, { includeApproval: true }),
    /unavailable/,
  );
  assert.deepEqual(attempts, ['primary.freeze_quote']);
});
