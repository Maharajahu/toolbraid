import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_MISSION_PROFILE_ID,
  MISSION_GUIDE_STEPS,
  MISSION_PROFILES,
  missionProfileById,
  resolveMissionProfile,
} from '../../src/app/mission-profiles.js';

test('exposes three frozen mission profiles with complete judge guidance', () => {
  assert.deepEqual(MISSION_PROFILES.map(({ id }) => id), [
    'production-recovery',
    'incident-trace',
    'authority-attack',
  ]);
  assert.equal(DEFAULT_MISSION_PROFILE_ID, 'production-recovery');
  for (const profile of MISSION_PROFILES) {
    assert.equal(Object.isFrozen(profile), true);
    assert.deepEqual(Object.keys(profile.guide), MISSION_GUIDE_STEPS);
    assert.equal(profile.constraints.length, 3);
    assert.match(profile.proof, /·/);
  }
});

test('resolves deep links exactly and fails closed to the default profile', () => {
  assert.equal(resolveMissionProfile('?mission=incident-trace').completion, 'read-only');
  assert.equal(resolveMissionProfile('?mission=authority-attack').completion, 'security');
  assert.equal(resolveMissionProfile('?mission=unknown').id, DEFAULT_MISSION_PROFILE_ID);
  assert.equal(missionProfileById(null).id, DEFAULT_MISSION_PROFILE_ID);
});
