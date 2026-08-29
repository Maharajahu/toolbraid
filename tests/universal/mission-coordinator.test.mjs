import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MISSION_PHASES,
  MEMBER_STATUS,
  MissionCoordinatorError,
  createMissionCoordinator,
  rehydrateMissionCoordinator,
} from '../../src/runtime/index.js';

function coordinator() {
  let nextId = 0;
  return createMissionCoordinator({
    idFactory: (prefix) => `${prefix}-${++nextId}`,
    now: () => new Date('2026-08-29T00:00:00.000Z'),
  });
}

function member(overrides = {}) {
  return {
    tabId: 7,
    frameId: 0,
    sessionId: 'session-a',
    documentId: 'document-a',
    pageInstanceId: 'page-a',
    origin: 'https://example.test',
    pageFingerprint: 'fingerprint-a',
    ...overrides,
  };
}

function attachOne(instance, overrides = {}) {
  const mission = instance.createMission({ missionId: 'mission-a' });
  const state = instance.attachMember({
    missionId: mission.missionId,
    memberId: 'member-a',
    ...member(overrides),
  });
  return { missionId: mission.missionId, state, member: state.members[0] };
}

test('creates a mission, attaches up to sixteen members, and enforces tab/frame ownership', () => {
  const instance = coordinator();
  const mission = instance.createMission({ missionId: 'mission-a' });
  assert.equal(mission.phase, MISSION_PHASES.RUNNING);
  assert.equal(mission.revision, 0);

  for (let index = 0; index < 16; index += 1) {
    const state = instance.attachMember({
      missionId: mission.missionId,
      memberId: `member-${index}`,
      ...member({
        tabId: index + 1,
        frameId: index % 2,
        sessionId: `session-${index}`,
        documentId: `document-${index}`,
        pageInstanceId: `page-${index}`,
        pageFingerprint: `fingerprint-${index}`,
      }),
    });
    assert.equal(state.members.length, index + 1);
  }

  assert.throws(
    () => instance.attachMember({
      missionId: mission.missionId,
      memberId: 'member-too-many',
      ...member({ tabId: 99, sessionId: 'session-99', documentId: 'document-99', pageInstanceId: 'page-99' }),
    }),
    (error) => error instanceof MissionCoordinatorError && error.code === 'MEMBER_LIMIT_REACHED',
  );

  const other = instance.createMission({ missionId: 'mission-b' });
  assert.throws(
    () => instance.attachMember({ missionId: other.missionId, memberId: 'member-b', ...member() }),
    (error) => error.code === 'TAB_FRAME_ALREADY_ATTACHED',
  );
});

test('routes only with the exact mission, member, and binding digest', () => {
  const instance = coordinator();
  const { missionId, member: attached } = attachOne(instance);
  const target = instance.target({
    missionId,
    memberId: attached.memberId,
    bindingDigest: attached.bindingDigest,
  });
  assert.deepEqual(target, {
    missionId,
    memberId: attached.memberId,
    bindingDigest: attached.bindingDigest,
    tabId: 7,
    frameId: 0,
    sessionId: 'session-a',
    documentId: 'document-a',
    pageInstanceId: 'page-a',
    origin: 'https://example.test',
    pageFingerprint: 'fingerprint-a',
  });

  for (const input of [
    { missionId: 'wrong-mission', memberId: attached.memberId, bindingDigest: attached.bindingDigest, code: 'MISSION_NOT_FOUND' },
    { missionId, memberId: 'wrong-member', bindingDigest: attached.bindingDigest, code: 'MEMBER_NOT_FOUND' },
    { missionId, memberId: attached.memberId, bindingDigest: '0'.repeat(64), code: 'BINDING_DIGEST_MISMATCH' },
  ]) {
    assert.throws(() => instance.target(input), (error) => error.code === input.code);
  }
});

test('detects session, page, and cross-origin drift, invalidates pending actions, and requires rebind', () => {
  const instance = coordinator();
  const { missionId, member: attached } = attachOne(instance);
  const pending = instance.registerPendingAction({
    missionId,
    memberId: attached.memberId,
    bindingDigest: attached.bindingDigest,
    actionId: 'action-a',
    metadata: { password: 'must-not-persist' },
  });
  assert.equal(pending.pendingActions.length, 1);
  const before = pending.revision;

  const observed = instance.observeMember({
    missionId,
    memberId: attached.memberId,
    bindingDigest: attached.bindingDigest,
    tabId: 7,
    frameId: 0,
    sessionId: 'session-b',
    documentId: 'document-b',
    pageInstanceId: 'page-b',
    origin: 'https://other.example',
    pageFingerprint: 'fingerprint-b',
  });
  assert.equal(observed.drift, true);
  assert.equal(observed.reason, 'SESSION_CHANGED');
  assert.equal(observed.state.revision, before + 1);
  assert.equal(observed.state.members[0].status, MEMBER_STATUS.AWAITING_REBIND);
  assert.deepEqual(observed.state.pendingActions, []);
  assert.throws(
    () => instance.target({ missionId, memberId: attached.memberId, bindingDigest: attached.bindingDigest }),
    (error) => error.code === 'MEMBER_REBIND_REQUIRED',
  );

  const rebound = instance.rebindMember({
    missionId,
    memberId: attached.memberId,
    ...member({
      sessionId: 'session-b',
      documentId: 'document-b',
      pageInstanceId: 'page-b',
      origin: 'https://other.example',
      pageFingerprint: 'fingerprint-b',
    }),
  });
  assert.equal(rebound.members[0].status, MEMBER_STATUS.ATTACHED);
  assert.notEqual(rebound.members[0].bindingDigest, attached.bindingDigest);
  assert.equal(rebound.pendingActions.length, 0);
  assert.equal(rebound.revision, before + 2);
});

test('invalidates and detaches members without leaving stale ownership or pending authority', () => {
  const instance = coordinator();
  const { missionId, member: attached } = attachOne(instance);
  instance.registerPendingAction({
    missionId,
    memberId: attached.memberId,
    bindingDigest: attached.bindingDigest,
    actionId: 'action-a',
  });
  const invalidated = instance.invalidateMember({
    missionId,
    memberId: attached.memberId,
    bindingDigest: attached.bindingDigest,
    reason: 'TAB_CLOSED',
  });
  assert.equal(invalidated.members[0].status, MEMBER_STATUS.INVALIDATED);
  assert.deepEqual(invalidated.invalidatedActionIds, ['action-a']);
  assert.deepEqual(invalidated.pendingActions, []);

  const detached = instance.detachMember({ missionId, memberId: attached.memberId });
  assert.equal(detached.members[0].status, MEMBER_STATUS.DETACHED);
  assert.equal(detached.activeMemberId, null);

  const other = instance.createMission({ missionId: 'mission-b' });
  const claimed = instance.attachMember({ missionId: other.missionId, memberId: 'member-b', ...member() });
  assert.equal(claimed.members[0].tabId, 7);
});

test('guards phase transitions with revision and exposes waiting/resuming phases', () => {
  const instance = coordinator();
  const { missionId } = attachOne(instance);
  const waiting = instance.setPhase({ missionId, phase: MISSION_PHASES.WAITING_HUMAN, expectedRevision: 1 });
  assert.equal(waiting.phase, MISSION_PHASES.WAITING_HUMAN);
  assert.equal(waiting.revision, 2);
  assert.throws(
    () => instance.setPhase({ missionId, phase: MISSION_PHASES.RUNNING, expectedRevision: 1 }),
    (error) => error.code === 'MISSION_REVISION_MISMATCH',
  );
  const resuming = instance.setPhase({ missionId, phase: MISSION_PHASES.RESUMING, expectedRevision: 2 });
  assert.equal(resuming.phase, MISSION_PHASES.RESUMING);
  assert.equal(instance.setPhase({ missionId, phase: MISSION_PHASES.RUNNING }).phase, MISSION_PHASES.RUNNING);
  assert.throws(
    () => instance.setPhase({ missionId, phase: 'not-a-phase' }),
    (error) => error.code === 'MISSION_PHASE_INVALID',
  );
});

test('persists only redacted rebind metadata and never resumes stale sessions or pending actions', () => {
  const instance = coordinator();
  const { missionId, member: attached } = attachOne(instance, {
    url: 'https://example.test/login?code=secret-query#fragment-secret',
  });
  instance.registerPendingAction({
    missionId,
    memberId: attached.memberId,
    bindingDigest: attached.bindingDigest,
    actionId: 'action-a',
    metadata: { password: 'sentinel-password', otp: 'sentinel-otp' },
  });
  const metadata = instance.toPersistence();
  const serialized = JSON.stringify(metadata);
  assert.equal(serialized.includes('secret-query'), false);
  assert.equal(serialized.includes('fragment-secret'), false);
  assert.equal(serialized.includes('sentinel-password'), false);
  assert.equal(serialized.includes('sentinel-otp'), false);
  assert.equal(serialized.includes('session-a'), false);
  assert.equal(serialized.includes('document-a'), false);
  assert.equal(serialized.includes('page-a'), false);
  assert.deepEqual(metadata.missions[0].pendingActions, []);
  assert.equal(metadata.missions[0].members[0].bindingDigest, null);
  assert.equal(metadata.missions[0].members[0].status, MEMBER_STATUS.AWAITING_REBIND);

  const restored = rehydrateMissionCoordinator(JSON.stringify(metadata), {
    now: () => new Date('2026-08-29T00:01:00.000Z'),
  });
  const restoredState = restored.state(missionId);
  assert.equal(restoredState.revision, instance.state(missionId).revision);
  assert.equal(restoredState.members[0].status, MEMBER_STATUS.AWAITING_REBIND);
  assert.deepEqual(restoredState.pendingActions, []);
  assert.throws(
    () => restored.target({ missionId, memberId: 'member-a', bindingDigest: attached.bindingDigest }),
    (error) => error.code === 'MEMBER_REBIND_REQUIRED',
  );

  const rebound = restored.rebindMember({
    missionId,
    memberId: 'member-a',
    ...member({
      sessionId: 'session-restored',
      documentId: 'document-restored',
      pageInstanceId: 'page-restored',
      pageFingerprint: 'fingerprint-restored',
    }),
  });
  assert.equal(rebound.members[0].status, MEMBER_STATUS.ATTACHED);
  assert.equal(rebound.pendingActions.length, 0);
});

test('rejects credential-bearing bindings without echoing their values', () => {
  const instance = coordinator();
  const mission = instance.createMission({ missionId: 'mission-a' });
  assert.throws(
    () => instance.attachMember({
      missionId: mission.missionId,
      memberId: 'member-a',
      ...member({ url: 'https://user:password@example.test/login' }),
    }),
    (error) => error.code === 'BINDING_ORIGIN_INVALID'
      && !error.message.includes('password')
      && !JSON.stringify(error.details).includes('password'),
  );
});

test('requires the exact current digest for attached-member authority changes', () => {
  const instance = coordinator();
  const { missionId, member: attached } = attachOne(instance);
  const changed = member({
    sessionId: 'session-next',
    documentId: 'document-next',
    pageInstanceId: 'page-next',
    pageFingerprint: 'fingerprint-next',
  });

  for (const operation of [
    () => instance.rebindMember({ missionId, memberId: attached.memberId, ...changed }),
    () => instance.invalidateMember({ missionId, memberId: attached.memberId, reason: 'TEST' }),
    () => instance.detachMember({ missionId, memberId: attached.memberId }),
    () => instance.observeMember({ missionId, memberId: attached.memberId, ...changed }),
  ]) {
    assert.throws(operation, (error) => error.code === 'BINDING_DIGEST_REQUIRED');
  }

  for (const operation of [
    () => instance.rebindMember({ missionId, memberId: attached.memberId, bindingDigest: '0'.repeat(64), ...changed }),
    () => instance.invalidateMember({ missionId, memberId: attached.memberId, bindingDigest: '0'.repeat(64), reason: 'TEST' }),
    () => instance.detachMember({ missionId, memberId: attached.memberId, bindingDigest: '0'.repeat(64) }),
    () => instance.observeMember({ missionId, memberId: attached.memberId, bindingDigest: '0'.repeat(64), ...changed }),
  ]) {
    assert.throws(operation, (error) => error.code === 'BINDING_DIGEST_MISMATCH');
  }

  const closed = instance.detachByTabFrame({ tabId: 7, frameId: 0 });
  assert.equal(closed.members[0].status, MEMBER_STATUS.DETACHED);
});

test('detached members are terminal and require a new member id for reattachment', () => {
  const instance = coordinator();
  const { missionId, member: attached } = attachOne(instance);
  const detached = instance.detachMember({
    missionId,
    memberId: attached.memberId,
    bindingDigest: attached.bindingDigest,
  });
  assert.equal(detached.members[0].status, MEMBER_STATUS.DETACHED);
  assert.throws(
    () => instance.rebindMember({
      missionId,
      memberId: attached.memberId,
      ...member({ sessionId: 'session-next', pageFingerprint: 'fingerprint-next' }),
    }),
    (error) => error.code === 'MEMBER_DETACHED',
  );
  assert.throws(
    () => instance.attachMember({ missionId, memberId: attached.memberId, ...member({ sessionId: 'session-next' }) }),
    (error) => error.code === 'MEMBER_ALREADY_EXISTS',
  );
  const replacement = instance.attachMember({ missionId, memberId: 'member-replacement', ...member({ sessionId: 'session-next' }) });
  assert.equal(replacement.members.at(-1).memberId, 'member-replacement');
});

test('terminal missions reject all membership, action, and phase mutations', () => {
  for (const phase of [MISSION_PHASES.COMPLETED, MISSION_PHASES.FAILED, MISSION_PHASES.CANCELLED]) {
    const instance = coordinator();
    const { missionId, member: attached } = attachOne(instance);
    const terminal = instance.setPhase({ missionId, phase });
    assert.equal(terminal.phase, phase);
    const changed = member({ sessionId: 'session-terminal-next', pageFingerprint: 'fingerprint-terminal-next' });
    const operations = [
      () => instance.selectMember({ missionId, memberId: attached.memberId }),
      () => instance.observeMember({ missionId, memberId: attached.memberId, bindingDigest: attached.bindingDigest, ...changed }),
      () => instance.invalidateMember({ missionId, memberId: attached.memberId, bindingDigest: attached.bindingDigest, reason: 'TEST' }),
      () => instance.detachMember({ missionId, memberId: attached.memberId, bindingDigest: attached.bindingDigest }),
      () => instance.rebindMember({ missionId, memberId: attached.memberId, bindingDigest: attached.bindingDigest, ...changed }),
      () => instance.registerPendingAction({ missionId, memberId: attached.memberId, bindingDigest: attached.bindingDigest, actionId: 'terminal-action' }),
      () => instance.setPhase({ missionId, phase: MISSION_PHASES.RUNNING }),
      () => instance.setPhase({ missionId, phase }),
      () => instance.invalidateMission({ missionId, reason: 'TEST' }),
    ];
    for (const operation of operations) {
      assert.throws(operation, (error) => error.code === 'MISSION_TERMINAL');
    }
    assert.equal(instance.state(missionId).phase, phase);
    assert.equal(instance.state(missionId).revision, terminal.revision);
  }
});
