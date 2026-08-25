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
