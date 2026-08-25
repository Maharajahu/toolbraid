import test from 'node:test';
import assert from 'node:assert/strict';
import { extractMission } from '../js/core/intent.js';

test('extracts route, relative date, and budget from a natural-language goal', () => {
  const mission = extractMission('Find transport from Coventry to London tomorrow, with a total budget under £250.');
  assert.equal(mission.origin, 'Coventry');
  assert.equal(mission.destination, 'London');
  assert.equal(mission.budget, 250);
  assert.match(mission.date, /^20\d{2}-\d{2}-\d{2}$/);
});

test('explicit structured constraints override inferred mission values', () => {
  const mission = extractMission('Travel from Oxford to Bristol under £100.', {
    origin: 'Coventry',
    destination: 'London',
    date: '2026-09-01',
    budget: 275,
    destinationAddress: '1 Principal Place, London EC2A 2FA',
  });
  assert.deepEqual(
    { origin: mission.origin, destination: mission.destination, date: mission.date, budget: mission.budget },
    { origin: 'Coventry', destination: 'London', date: '2026-09-01', budget: 275 },
  );
});
