import assert from 'node:assert/strict';
import test from 'node:test';

import { createExtensionMissionRuntime } from '../../extension/mission-runtime.js';

const BASE_TIME = new Date('2026-08-29T12:00:00.000Z');

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function key(tabId, frameId = 0) {
  return `${tabId}:${frameId}`;
}

function originOf(url) {
  return new URL(url).origin;
}

function makeHarness({ persisted = undefined, failGet = false, failSet = false, delaySetMs = 0 } = {}) {
  const sessions = new Map();
  const states = new Map();
  let sequence = 0;

  function installLive(tabId, frameId = 0, overrides = {}) {
    sequence += 1;
    const origin = overrides.origin ?? 'https://example.test';
    const url = overrides.url ?? `${origin}/page-${tabId}-${frameId}`;
    const suffix = overrides.suffix ?? `${tabId}-${frameId}-${sequence}`;
    const session = {
      tabId,
      frameId,
      sessionId: overrides.sessionId ?? `session-${suffix}`,
      nonce: overrides.nonce ?? `nonce-${suffix}-secret`,
      documentId: overrides.documentId ?? `document-${suffix}`,
      pageInstanceId: overrides.pageInstanceId ?? `page-${suffix}`,
      url,
      state: 'active',
    };
    const state = {
      tabId,
      frameId,
      sessionId: session.sessionId,
      documentId: session.documentId,
      pageInstanceId: session.pageInstanceId,
      origin,
      url,
      pageFingerprint: overrides.pageFingerprint ?? `fingerprint-${suffix}`,
      revision: overrides.revision ?? 1,
      pendingActions: [],
    };
    sessions.set(key(tabId, frameId), session);
    states.set(key(tabId, frameId), state);
    return { session: clone(session), state: clone(state) };
  }

  installLive(7, 0, {
    suffix: 'primary',
    url: 'https://example.test/primary?token=secret-query#secret-fragment',
    pageFingerprint: 'fingerprint-primary',
  });

  const lifecycle = {
    get(tabId, frameId = 0) {
      return clone(sessions.get(key(tabId, frameId)) ?? null);
    },
    list() {
      return [...sessions.values()].map(clone);
    },
    acceptPageReady(tabId, input = {}) {
      const frameId = input.frameId ?? 0;
      const previous = sessions.get(key(tabId, frameId));
      const next = installLive(tabId, frameId, input);
      return { session: next.session, reused: Boolean(previous && previous.sessionId === next.session.sessionId) };
    },
    invalidate(tabId, reason = 'navigation', frameId = undefined) {
      const removed = [];
      for (const [entryKey, session] of sessions.entries()) {
        if (session.tabId !== tabId || (frameId !== undefined && session.frameId !== frameId)) continue;
        sessions.delete(entryKey);
        removed.push({ ...clone(session), state: 'closed', closeReason: reason });
      }
      return removed;
    },
  };

  const universalRuntime = {
    state(tabId, frameId = 0) {
      return clone(states.get(key(tabId, frameId)) ?? null);
    },
  };

  const storage = {
    values: new Map(),
    persisted,
    lastSet: null,
    setCalls: [],
    inFlight: 0,
    maxInFlight: 0,
    async get(storageKey) {
      if (failGet) throw new Error(`storage read failed: ${String(storageKey)}`);
      if (this.persisted !== undefined) return clone(this.persisted);
      return clone(this.values.get(String(storageKey)));
    },
    async set(storageKey, value) {
      this.setCalls.push(String(storageKey));
      if (failSet) throw new Error(`storage write failed: ${String(storageKey)}`);
      this.inFlight += 1;
      this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
      try {
        if (delaySetMs > 0) await new Promise((resolve) => setTimeout(resolve, delaySetMs));
        this.values.set(String(storageKey), clone(value));
        this.lastSet = clone(value);
        this.persisted = clone(value);
      } finally {
        this.inFlight -= 1;
      }
    },
    async remove(storageKey) {
      this.values.delete(String(storageKey));
      if (this.persisted !== undefined) this.persisted = undefined;
    },
    async keys() {
      return [...this.values.keys()];
    },
  };

  function setLive(tabId, frameId = 0, overrides = {}) {
    const currentSession = sessions.get(key(tabId, frameId));
    const currentState = states.get(key(tabId, frameId));
    if (!currentSession || !currentState) return installLive(tabId, frameId, overrides);
    const origin = overrides.origin ?? currentState.origin;
    const url = overrides.url ?? `${origin}/page-${tabId}-${frameId}`;
    const session = {
      ...currentSession,
      ...Object.fromEntries(Object.entries(overrides).filter(([field]) => [
        'sessionId', 'nonce', 'documentId', 'pageInstanceId', 'url', 'state',
      ].includes(field))),
      tabId,
      frameId,
      url,
    };
    const state = {
      ...currentState,
      ...Object.fromEntries(Object.entries(overrides).filter(([field]) => [
        'sessionId', 'documentId', 'pageInstanceId', 'url', 'pageFingerprint', 'revision',
      ].includes(field))),
      tabId,
      frameId,
      origin,
      url,
    };
    sessions.set(key(tabId, frameId), session);
    states.set(key(tabId, frameId), state);
    return { session: clone(session), state: clone(state) };
  }

  let idSequence = 0;
  async function open(options = {}) {
    return createExtensionMissionRuntime({
      lifecycleRegistry: lifecycle,
      universalRuntime,
      store: storage,
      now: () => new Date(BASE_TIME),
      idFactory: (prefix) => `${prefix}-${++idSequence}`,
      ...options,
    });
  }

  return {
    lifecycle,
    universalRuntime,
    storage,
    installLive,
    setLive,
    open,
  };
}

function liveMemberInput(harness, tabId, frameId = 0, overrides = {}) {
  const session = harness.lifecycle.get(tabId, frameId);
  const state = harness.universalRuntime.state(tabId, frameId);
  return {
    missionId: overrides.missionId,
    memberId: overrides.memberId,
    tabId,
    frameId,
    ...overrides,
    sessionId: overrides.sessionId ?? session.sessionId,
    documentId: overrides.documentId ?? session.documentId,
    pageInstanceId: overrides.pageInstanceId ?? session.pageInstanceId,
    origin: overrides.origin ?? state.origin,
    pageFingerprint: overrides.pageFingerprint ?? state.pageFingerprint,
  };
}

async function createMission(runtime, missionId) {
  return runtime.createMission({
    missionId,
    objective: 'Publish a safe notice without persisting password=sentinel-password.',
  });
}

async function attach(runtime, harness, missionId, memberId, tabId, frameId = 0, overrides = {}) {
  return runtime.attachMember(liveMemberInput(harness, tabId, frameId, {
    missionId,
    memberId,
    ...overrides,
  }));
}

function memberFrom(state, memberId) {
  return state.members.find((member) => member.memberId === memberId) ?? null;
}

function assertSafeError(error) {
  return error && typeof error.code === 'string' && !String(error.message).includes('secret');
}

test('creates a mission and persists exact redacted rebind metadata', async () => {
  const harness = makeHarness();
  const runtime = await harness.open();
  await createMission(runtime, 'mission-redacted');
  const attached = await attach(runtime, harness, 'mission-redacted', 'member-primary', 7);
  await runtime.registerPendingAction({
    missionId: 'mission-redacted',
    memberId: 'member-primary',
    bindingDigest: memberFrom(attached, 'member-primary').bindingDigest,
    actionId: 'action-secret',
    metadata: { password: 'sentinel-password', otp: 'sentinel-otp' },
  });

  const serialized = JSON.stringify(harness.storage.lastSet);
  assert.equal(typeof harness.storage.lastSet?.version, 'number');
  assert.equal(serialized.includes('sentinel-password'), false);
  assert.equal(serialized.includes('sentinel-otp'), false);
  assert.equal(serialized.includes('secret-query'), false);
  assert.equal(serialized.includes('secret-fragment'), false);
  assert.equal(serialized.includes('nonce-primary-secret'), false);
  assert.equal(serialized.includes('session-primary'), false);
  assert.equal(serialized.includes('document-primary'), false);
  assert.equal(serialized.includes('page-primary'), false);
  assert.deepEqual(harness.storage.lastSet.missions[0].pendingActions, []);
  assert.equal(harness.storage.lastSet.missions[0].members[0].status, 'awaiting-rebind');
  assert.equal(harness.storage.lastSet.missions[0].members[0].bindingDigest, null);
});

test('attaches distinct tab/frame owners, rejects duplicate ids, and enforces sixteen members', async () => {
  const harness = makeHarness();
  const runtime = await harness.open();
  await createMission(runtime, 'mission-members');
  harness.installLive(1, 0, { suffix: 'member-1', pageFingerprint: 'fingerprint-member-1' });
  await attach(runtime, harness, 'mission-members', 'member-1', 1);

  await assert.rejects(
    () => attach(runtime, harness, 'mission-members', 'member-1', 1),
    (error) => error?.code === 'MEMBER_ALREADY_EXISTS',
  );

  for (let index = 2; index <= 16; index += 1) {
    harness.installLive(index, index % 2, {
      suffix: `member-${index}`,
      pageFingerprint: `fingerprint-member-${index}`,
    });
    await attach(runtime, harness, 'mission-members', `member-${index}`, index, index % 2);
  }
  assert.equal(runtime.state('mission-members').members.length, 16);

  harness.installLive(17, 0, { suffix: 'member-17' });
  await assert.rejects(
    () => attach(runtime, harness, 'mission-members', 'member-17', 17),
    (error) => error?.code === 'MEMBER_LIMIT_REACHED',
  );

  await createMission(runtime, 'mission-other');
  await assert.rejects(
    () => attach(runtime, harness, 'mission-other', 'member-other', 1),
    (error) => error?.code === 'TAB_FRAME_ALREADY_ATTACHED',
  );
});

test('targets and reads through the exact digest and live binding without mutating mission state', async () => {
  const harness = makeHarness();
  const runtime = await harness.open();
  await createMission(runtime, 'mission-target');
  const attached = await attach(runtime, harness, 'mission-target', 'member-target', 7);
  const member = memberFrom(attached, 'member-target');
  const beforeRevision = runtime.state('mission-target').revision;

  const target = await runtime.target({
    missionId: 'mission-target',
    memberId: 'member-target',
    bindingDigest: member.bindingDigest,
  });
  assert.equal(target.memberId, 'member-target');
  assert.equal(target.tabId, 7);
  assert.equal(target.frameId, 0);
  assert.equal(target.sessionId, 'session-primary');
  assert.equal(target.origin, 'https://example.test');
  assert.equal(target.pageFingerprint, 'fingerprint-primary');

  const read = await runtime.read({
    missionId: 'mission-target',
    memberId: 'member-target',
    bindingDigest: member.bindingDigest,
  });
  const readTarget = read.target ?? read;
  assert.equal(readTarget.bindingDigest, member.bindingDigest);
  assert.equal(readTarget.sessionId, 'session-primary');
  assert.equal(readTarget.pageFingerprint, 'fingerprint-primary');
  assert.equal(runtime.state('mission-target').revision, beforeRevision);

  await assert.rejects(
    () => runtime.target({ missionId: 'mission-target', memberId: 'member-target' }),
    (error) => error?.code === 'BINDING_DIGEST_REQUIRED',
  );
  await assert.rejects(
    () => runtime.target({ missionId: 'mission-target', memberId: 'member-target', bindingDigest: '0'.repeat(64) }),
    (error) => error?.code === 'BINDING_DIGEST_MISMATCH',
  );
});

test('ignores or rejects forged UI binding fields and never grants forged authority', async () => {
  const harness = makeHarness();
  const runtime = await harness.open();
  await createMission(runtime, 'mission-forged');

  let attached;
  try {
    attached = await runtime.attachMember({
      missionId: 'mission-forged',
      memberId: 'member-forged',
      tabId: 7,
      frameId: 0,
      sessionId: 'forged-session',
      documentId: 'forged-document',
      pageInstanceId: 'forged-page',
      origin: 'https://evil.example',
      pageFingerprint: 'forged-fingerprint',
      binding: {
        tabId: 999,
        frameId: 9,
        origin: 'https://evil.example',
        sessionId: 'forged-nested-session',
      },
    });
  } catch (error) {
    assert.equal(assertSafeError(error), true);
    return;
  }

  const member = memberFrom(attached, 'member-forged');
  assert.equal(member.tabId, 7);
  assert.equal(member.frameId, 0);
  assert.equal(member.sessionId, 'session-primary');
  assert.equal(member.documentId, 'document-primary');
  assert.equal(member.pageInstanceId, 'page-primary');
  assert.equal(member.origin, 'https://example.test');
  assert.equal(member.pageFingerprint, 'fingerprint-primary');
  assert.equal(JSON.stringify(attached).includes('forged-session'), false);
  assert.equal(JSON.stringify(attached).includes('evil.example'), false);

  const target = await runtime.target({
    missionId: 'mission-forged',
    memberId: 'member-forged',
    bindingDigest: member.bindingDigest,
    tabId: 999,
    frameId: 9,
    sessionId: 'forged-session',
    origin: 'https://evil.example',
    pageFingerprint: 'forged-fingerprint',
  });
  assert.equal(target.tabId, 7);
  assert.equal(target.frameId, 0);
  assert.equal(target.sessionId, 'session-primary');
  assert.equal(target.origin, 'https://example.test');
  assert.equal(target.pageFingerprint, 'fingerprint-primary');
});

test('rehydrates after restart as awaiting-rebind and requires an explicit fresh rebind', async () => {
  const firstHarness = makeHarness();
  const first = await firstHarness.open();
  await createMission(first, 'mission-restart');
  const attached = await attach(first, firstHarness, 'mission-restart', 'member-restart', 7);
  const oldDigest = memberFrom(attached, 'member-restart').bindingDigest;
  await first.registerPendingAction({
    missionId: 'mission-restart',
    memberId: 'member-restart',
    bindingDigest: oldDigest,
    actionId: 'action-before-restart',
  });
  const persisted = clone(firstHarness.storage.lastSet);

  const restartedHarness = makeHarness({ persisted });
  restartedHarness.lifecycle.invalidate(7, 'worker-restart');
  const restarted = await restartedHarness.open();
  const restored = restarted.state('mission-restart');
  const restoredMember = memberFrom(restored, 'member-restart');
  assert.equal(restoredMember.status, 'awaiting-rebind');
  assert.equal(restoredMember.rebindRequired, true);
  assert.deepEqual(restored.pendingActions, []);
  await assert.rejects(
    () => restarted.target({ missionId: 'mission-restart', memberId: 'member-restart', bindingDigest: oldDigest }),
    (error) => error?.code === 'MEMBER_REBIND_REQUIRED',
  );

  restartedHarness.installLive(7, 0, {
    suffix: 'restored',
    sessionId: 'session-restored',
    documentId: 'document-restored',
    pageInstanceId: 'page-restored',
    pageFingerprint: 'fingerprint-restored',
  });
  const rebound = await restarted.rebindMember({
    missionId: 'mission-restart',
    memberId: 'member-restart',
    tabId: 7,
    frameId: 0,
  });
  const reboundMember = memberFrom(rebound, 'member-restart');
  assert.equal(reboundMember.status, 'attached');
  assert.equal(reboundMember.sessionId, 'session-restored');
  assert.notEqual(reboundMember.bindingDigest, oldDigest);
  assert.deepEqual(rebound.pendingActions, []);
});

test('page-ready/session and snapshot fingerprint or origin drift invalidate pending authority', async () => {
  const harness = makeHarness();
  const runtime = await harness.open();
  await createMission(runtime, 'mission-drift-ready');
  const attached = await attach(runtime, harness, 'mission-drift-ready', 'member-ready', 7);
  await runtime.registerPendingAction({
    missionId: 'mission-drift-ready',
    memberId: 'member-ready',
    bindingDigest: memberFrom(attached, 'member-ready').bindingDigest,
    actionId: 'action-ready',
  });

  const next = harness.setLive(7, 0, {
    suffix: 'next-document',
    sessionId: 'session-next-document',
    documentId: 'document-next-document',
    pageInstanceId: 'page-next-document',
    pageFingerprint: 'fingerprint-next-document',
  });
  await runtime.handlePageReady({
    tabId: 7,
    frameId: 0,
    session: next.session,
    ...next.session,
    origin: next.state.origin,
    pageFingerprint: next.state.pageFingerprint,
  });
  let state = runtime.state('mission-drift-ready');
  assert.equal(memberFrom(state, 'member-ready').status, 'awaiting-rebind');
  assert.deepEqual(state.pendingActions, []);

  harness.installLive(8, 0, {
    suffix: 'snapshot-member',
    pageFingerprint: 'fingerprint-snapshot-member',
  });
  await createMission(runtime, 'mission-drift-snapshot');
  const second = await attach(runtime, harness, 'mission-drift-snapshot', 'member-snapshot', 8);
  await runtime.registerPendingAction({
    missionId: 'mission-drift-snapshot',
    memberId: 'member-snapshot',
    bindingDigest: memberFrom(second, 'member-snapshot').bindingDigest,
    actionId: 'action-snapshot',
  });
  harness.setLive(8, 0, { pageFingerprint: 'fingerprint-dom-drift' });
  await runtime.handlePageSnapshot({
    tabId: 8,
    frameId: 0,
    session: harness.lifecycle.get(8, 0),
    sessionId: harness.lifecycle.get(8, 0).sessionId,
    origin: 'https://example.test',
    pageFingerprint: 'fingerprint-dom-drift',
  });
  state = runtime.state('mission-drift-snapshot');
  assert.equal(memberFrom(state, 'member-snapshot').status, 'awaiting-rebind');
  assert.deepEqual(state.pendingActions, []);

  harness.installLive(9, 0, {
    suffix: 'origin-member',
    origin: 'https://example.test',
    pageFingerprint: 'fingerprint-origin-member',
  });
  await createMission(runtime, 'mission-drift-origin');
  const originMember = await attach(runtime, harness, 'mission-drift-origin', 'member-origin', 9);
  await runtime.registerPendingAction({
    missionId: 'mission-drift-origin',
    memberId: 'member-origin',
    bindingDigest: memberFrom(originMember, 'member-origin').bindingDigest,
    actionId: 'action-origin',
  });
  harness.setLive(9, 0, {
    origin: 'https://evil.example',
    pageFingerprint: 'fingerprint-origin-drift',
  });
  await runtime.handlePageSnapshot({
    tabId: 9,
    frameId: 0,
    session: harness.lifecycle.get(9, 0),
    sessionId: harness.lifecycle.get(9, 0).sessionId,
    origin: 'https://evil.example',
    pageFingerprint: 'fingerprint-origin-drift',
  });
  state = runtime.state('mission-drift-origin');
  assert.equal(memberFrom(state, 'member-origin').status, 'awaiting-rebind');
  assert.deepEqual(state.pendingActions, []);
});

test('cross-origin navigation invalidates and tab removal detaches ownership', async () => {
  const harness = makeHarness();
  harness.installLive(8, 0, { suffix: 'secondary' });
  const runtime = await harness.open();
  await createMission(runtime, 'mission-close');
  const first = await attach(runtime, harness, 'mission-close', 'member-navigation', 7);
  const second = await attach(runtime, harness, 'mission-close', 'member-removed', 8);
  await runtime.registerPendingAction({
    missionId: 'mission-close',
    memberId: 'member-navigation',
    bindingDigest: memberFrom(first, 'member-navigation').bindingDigest,
    actionId: 'action-navigation',
  });
  await runtime.registerPendingAction({
    missionId: 'mission-close',
    memberId: 'member-removed',
    bindingDigest: memberFrom(second, 'member-removed').bindingDigest,
    actionId: 'action-removed',
  });

  await runtime.handleTabUpdated(7, {
    status: 'loading',
    url: 'https://other.example/new-page',
  }, {
    id: 7,
    url: 'https://other.example/new-page',
  });
  let state = runtime.state('mission-close');
  assert.equal(memberFrom(state, 'member-navigation').status, 'invalidated');
  assert.equal(state.pendingActions.some((action) => action.actionId === 'action-navigation'), false);

  await runtime.handleTabRemoved(8);
  state = runtime.state('mission-close');
  assert.equal(memberFrom(state, 'member-removed').status, 'detached');
  assert.equal(state.pendingActions.some((action) => action.actionId === 'action-removed'), false);

  await createMission(runtime, 'mission-reuse');
  harness.installLive(8, 0, { suffix: 'replacement' });
  const replacement = await attach(runtime, harness, 'mission-reuse', 'member-replacement', 8);
  assert.equal(memberFrom(replacement, 'member-replacement').tabId, 8);
});

test('malformed or failed storage never creates a usable mission runtime', async () => {
  const malformed = makeHarness({ persisted: { version: 999, missions: [] } });
  await assert.rejects(
    () => malformed.open(),
    (error) => assertSafeError(error),
  );

  const unreadable = makeHarness({ failGet: true });
  await assert.rejects(
    () => unreadable.open(),
    (error) => assertSafeError(error),
  );

  const unwritable = makeHarness({ failSet: true });
  const runtime = await unwritable.open();
  await assert.rejects(
    () => createMission(runtime, 'mission-write-failure'),
    (error) => assertSafeError(error),
  );
  assert.throws(
    () => runtime.state('mission-write-failure'),
    (error) => error?.code === 'MISSION_NOT_FOUND',
  );
});

test('serializes concurrent mission operations and storage writes', async () => {
  const harness = makeHarness({ delaySetMs: 2 });
  const runtime = await harness.open();
  await createMission(runtime, 'mission-serialized');
  harness.installLive(21, 0, { suffix: 'serial-21' });
  harness.installLive(22, 0, { suffix: 'serial-22' });

  await Promise.all([
    attach(runtime, harness, 'mission-serialized', 'member-21', 21),
    attach(runtime, harness, 'mission-serialized', 'member-22', 22),
  ]);
  const state = runtime.state('mission-serialized');
  assert.equal(state.members.length, 2);
  assert.equal(state.revision, 2);
  assert.equal(harness.storage.maxInFlight, 1);
});

test('public mission state is JSON-safe and contains no executable or cyclic values', async () => {
  const harness = makeHarness();
  const runtime = await harness.open();
  await createMission(runtime, 'mission-public');
  const attached = await attach(runtime, harness, 'mission-public', 'member-public', 7);
  await runtime.registerPendingAction({
    missionId: 'mission-public',
    memberId: 'member-public',
    bindingDigest: memberFrom(attached, 'member-public').bindingDigest,
    actionId: 'action-public',
  });
  const state = runtime.state('mission-public');
  const serialized = JSON.stringify(state);
  assert.equal(typeof serialized, 'string');
  const parsed = JSON.parse(serialized);
  assert.deepEqual(parsed.missionId, 'mission-public');
  assert.equal(serialized.includes('function'), false);
  assert.equal(serialized.includes('sentinel-password'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(parsed, 'nonce'), false);
});

test('exposes the exact live binding to the handoff facade without requiring a caller-owned digest', async () => {
  const harness = makeHarness();
  const runtime = await harness.open();
  await createMission(runtime, 'mission-handoff-binding');
  await attach(runtime, harness, 'mission-handoff-binding', 'member-handoff-binding', 7);

  const binding = runtime.getBinding('mission-handoff-binding', 'member-handoff-binding');
  assert.equal(binding.missionId, 'mission-handoff-binding');
  assert.equal(binding.memberId, 'member-handoff-binding');
  assert.equal(binding.tabId, 7);
  assert.equal(typeof binding.bindingDigest, 'string');
  assert.equal(runtime.validateBinding({
    missionId: binding.missionId,
    memberId: binding.memberId,
    tabId: binding.tabId,
    frameId: binding.frameId,
    sessionId: binding.sessionId,
    origin: binding.origin,
    pageFingerprint: binding.pageFingerprint,
  }), true);
  assert.equal(runtime.validateBinding({ ...binding, pageFingerprint: 'drifted' }), false);
});
