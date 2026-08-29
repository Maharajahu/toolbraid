import assert from 'node:assert/strict';
import test from 'node:test';

import {
  HANDOFF_PERSISTENCE_VERSION,
  HANDOFF_STATES,
  HANDOFF_TYPES,
  HandoffBrokerError,
  createHandoffBroker,
  rehydrateHandoffBroker,
  syntheticUiIntent,
} from '../../src/runtime/handoff-broker.js';
import {
  HANDOFF_PERSISTENCE_VERSION as INDEX_HANDOFF_PERSISTENCE_VERSION,
  HANDOFF_STATES as INDEX_HANDOFF_STATES,
  createHandoffBroker as createIndexedHandoffBroker,
  rehydrateHandoffBroker as rehydrateIndexedHandoffBroker,
} from '../../src/runtime/index.js';

const CONTEXT = Object.freeze({
  missionId: 'mission-a',
  memberId: 'member-a',
  sessionId: 'session-a',
  pageFingerprint: 'page-a',
  targetFingerprint: 'target-a',
  purpose: 'complete login',
  safeOrigin: 'https://example.test',
});
const PERSISTENCE_KEY = 'toolbraid-handoff-test-key-2026-08-29';

function clock(start = '2026-08-29T00:00:00.000Z') {
  let current = new Date(start).getTime();
  return {
    now: () => new Date(current),
    advance: (milliseconds) => { current += milliseconds; },
  };
}

function brokerWith(clockState = clock()) {
  const broker = createHandoffBroker({
    now: clockState.now,
    defaultTtlMs: 60_000,
    idFactory: (prefix) => `${prefix}-one`,
    persistenceKey: PERSISTENCE_KEY,
    validateMissionBinding: (binding) => binding.missionId === CONTEXT.missionId
      && binding.memberId === CONTEXT.memberId
      && binding.sessionId === CONTEXT.sessionId
      && binding.pageFingerprint === CONTEXT.pageFingerprint
      && binding.targetFingerprint === CONTEXT.targetFingerprint
      && binding.safeOrigin === CONTEXT.safeOrigin,
    validateUiIntent: (token, expected) => token?.kind === 'toolbraid.synthetic-ui-intent'
      && token?.handoffId === expected.handoffId
      && token?.missionId === expected.missionId
      && token?.memberId === expected.memberId
      && token?.sessionId === expected.sessionId
      && token?.pageFingerprint === expected.pageFingerprint
      && token?.targetFingerprint === expected.targetFingerprint
      && token?.purpose === expected.purpose
      && token?.intent === expected.intent,
    validateCompletionProof: (proof, expected) => proof?.kind === 'toolbraid.completion-proof'
      && proof?.fresh === true
      && proof?.binding?.missionId === expected.missionId
      && proof?.binding?.memberId === expected.memberId
      && proof?.binding?.sessionId === expected.sessionId
      && proof?.binding?.pageFingerprint === expected.pageFingerprint
      && proof?.binding?.targetFingerprint === expected.targetFingerprint
      && proof?.binding?.purpose === expected.purpose
      && proof?.binding?.safeOrigin === expected.safeOrigin,
  });
  return { broker, clockState };
}

function requested(broker, overrides = {}) {
  return broker.request({ type: 'login', ...CONTEXT, ...overrides });
}

function toAwaiting(broker, handoffId) {
  return broker.awaitUiGesture({ handoffId });
}

function openable(broker, handoffId, overrides = {}) {
  const state = broker.state(handoffId);
  return broker.open({
    handoffId,
    uiIntent: syntheticUiIntent({
      handoffId,
      ...state,
      intent: 'open',
      ...overrides,
    }),
  });
}

function completionProof(broker, handoffId, overrides = {}) {
  const state = broker.state(handoffId);
  return {
    kind: 'toolbraid.completion-proof',
    fresh: true,
    handoffId,
    type: state.type,
    binding: {
      missionId: state.missionId,
      memberId: state.memberId,
      sessionId: state.sessionId,
      pageFingerprint: state.pageFingerprint,
      targetFingerprint: state.targetFingerprint,
      purpose: state.purpose,
      safeOrigin: state.safeOrigin,
      ...overrides,
    },
  };
}

test('synthetic handoff follows the guarded open path and cannot be opened by the agent', () => {
  const { broker } = brokerWith();
  const created = requested(broker);
  assert.equal(created.state, HANDOFF_STATES.REQUESTED);
  assert.equal(created.type, HANDOFF_TYPES.LOGIN);

  toAwaiting(broker, created.handoffId);
  assert.throws(
    () => broker.open({ handoffId: created.handoffId }),
    (error) => error instanceof HandoffBrokerError && error.code === 'UI_INTENT_REQUIRED',
  );
  const waiting = broker.state(created.handoffId);
  assert.equal(waiting.state, HANDOFF_STATES.AWAITING_UI_GESTURE);
  const opening = openable(broker, created.handoffId);
  assert.equal(opening.state, HANDOFF_STATES.OPENING);
  const active = broker.humanActive({ handoffId: created.handoffId });
  assert.equal(active.state, HANDOFF_STATES.HUMAN_ACTIVE);
  const returning = broker.returnRequested({ handoffId: created.handoffId });
  assert.equal(returning.state, HANDOFF_STATES.RETURN_REQUESTED);
  const validating = broker.validate({ handoffId: created.handoffId });
  assert.equal(validating.state, HANDOFF_STATES.VALIDATING);
  const completed = broker.complete({ handoffId: created.handoffId, uiIntent: syntheticUiIntent({
    handoffId: created.handoffId,
    ...broker.state(created.handoffId),
    intent: 'complete',
  }), completionProof: completionProof(broker, created.handoffId) });
  assert.equal(completed.state, HANDOFF_STATES.COMPLETED);
});

test('CAPTCHA permits one exact checkbox attempt and rejects a second or mismatched binding', () => {
  const { broker } = brokerWith();
  const created = requested(broker, { type: 'captcha', purpose: 'challenge checkbox' });
  toAwaiting(broker, created.handoffId);
  openable(broker, created.handoffId);
  broker.humanActive({ handoffId: created.handoffId });

  const attempted = broker.captchaCheckboxAttempt({
    handoffId: created.handoffId,
    missionId: CONTEXT.missionId,
    memberId: CONTEXT.memberId,
    sessionId: CONTEXT.sessionId,
    pageFingerprint: CONTEXT.pageFingerprint,
    targetFingerprint: CONTEXT.targetFingerprint,
    purpose: 'challenge checkbox',
    safeOrigin: CONTEXT.safeOrigin,
    uiIntent: syntheticUiIntent({
      handoffId: created.handoffId,
      ...broker.state(created.handoffId),
      intent: 'captcha-checkbox',
    }),
  });
  assert.equal(attempted.captchaCheckboxAttempts, 1);

  assert.throws(
    () => broker.captchaCheckboxAttempt({
      handoffId: created.handoffId,
      missionId: CONTEXT.missionId,
      memberId: CONTEXT.memberId,
      sessionId: CONTEXT.sessionId,
      pageFingerprint: CONTEXT.pageFingerprint,
      targetFingerprint: CONTEXT.targetFingerprint,
      purpose: 'challenge checkbox',
      safeOrigin: CONTEXT.safeOrigin,
      uiIntent: syntheticUiIntent({
        handoffId: created.handoffId,
        ...broker.state(created.handoffId),
        intent: 'captcha-checkbox',
      }),
    }),
    (error) => error.code === 'CAPTCHA_ATTEMPT_LIMIT',
  );
  assert.throws(
    () => broker.captchaCheckboxAttempt({
      handoffId: created.handoffId,
      missionId: CONTEXT.missionId,
      memberId: CONTEXT.memberId,
      sessionId: 'other-session',
      pageFingerprint: CONTEXT.pageFingerprint,
      targetFingerprint: CONTEXT.targetFingerprint,
      purpose: 'challenge checkbox',
      safeOrigin: CONTEXT.safeOrigin,
      uiIntent: syntheticUiIntent({
        handoffId: created.handoffId,
        ...broker.state(created.handoffId),
        intent: 'captcha-checkbox',
      }),
    }),
    (error) => error.code === 'HANDOFF_BINDING_MISMATCH',
  );
});

test('CAPTCHA attempt usage survives rehydration without restoring UI authority', () => {
  const { broker } = brokerWith();
  const created = requested(broker, { type: 'captcha', purpose: 'challenge checkbox' });
  toAwaiting(broker, created.handoffId);
  openable(broker, created.handoffId);
  broker.humanActive({ handoffId: created.handoffId });
  broker.captchaCheckboxAttempt({
    handoffId: created.handoffId,
    missionId: CONTEXT.missionId,
    memberId: CONTEXT.memberId,
    sessionId: CONTEXT.sessionId,
    pageFingerprint: CONTEXT.pageFingerprint,
    targetFingerprint: CONTEXT.targetFingerprint,
    purpose: 'challenge checkbox',
    safeOrigin: CONTEXT.safeOrigin,
    uiIntent: syntheticUiIntent({
      handoffId: created.handoffId,
      ...broker.state(created.handoffId),
      intent: 'captcha-checkbox',
    }),
  });

  const restored = rehydrateHandoffBroker(broker.toPersistence(), {
    now: () => new Date('2026-08-29T00:00:01.000Z'),
    persistenceKey: PERSISTENCE_KEY,
    validateMissionBinding: () => true,
    validateUiIntent: () => true,
  });
  const waiting = restored.state(created.handoffId);
  assert.equal(waiting.state, HANDOFF_STATES.AWAITING_UI_GESTURE);
  assert.equal(waiting.captchaCheckboxAttempts, 1);
  assert.equal(waiting.uiAuthority, null);
});

test('expiry is monotonic, terminal, and does not accept a late UI token', () => {
  const { broker, clockState } = brokerWith();
  const created = requested(broker);
  toAwaiting(broker, created.handoffId);
  clockState.advance(60_001);
  const expired = broker.expire(created.handoffId);
  assert.equal(expired.state, HANDOFF_STATES.EXPIRED);
  assert.throws(
    () => openable(broker, created.handoffId),
    (error) => error.code === 'HANDOFF_EXPIRED',
  );
  assert.throws(
    () => broker.cancel({ handoffId: created.handoffId }),
    (error) => error.code === 'HANDOFF_EXPIRED',
  );
});

test('public and persisted projections redact secrets and raw URLs; rehydration requires revalidation', () => {
  const { broker } = brokerWith();
  const created = requested(broker, {
    url: 'https://alice:password@example.test/login?otp=sentinel-otp#fragment-secret',
    password: 'sentinel-password',
    otp: 'sentinel-otp',
    secret: 'sentinel-secret',
  });
  const serialized = JSON.stringify({ public: created, persistence: broker.toPersistence() });
  for (const secret of ['password', 'sentinel-password', 'sentinel-otp', 'fragment-secret', 'otp=sentinel-otp', 'alice:']) {
    assert.equal(serialized.includes(secret), false, `redaction leaked ${secret}`);
  }
  assert.equal(created.safeOrigin, 'https://example.test');
  assert.equal(created.url, undefined);
  assert.equal(created.password, undefined);
  assert.equal(created.otp, undefined);

  const restored = rehydrateHandoffBroker(broker.toPersistence(), {
    now: () => new Date('2026-08-29T00:00:01.000Z'),
    persistenceKey: PERSISTENCE_KEY,
    validateMissionBinding: () => true,
    validateUiIntent: () => false,
  });
  const restoredState = restored.state(created.handoffId);
  assert.equal(restoredState.state, HANDOFF_STATES.AWAITING_UI_GESTURE);
  assert.equal(restoredState.revalidationRequired, true);
  assert.equal(restoredState.uiAuthority, null);
  assert.equal(restoredState.captchaCheckboxAttempts, 0);
  assert.equal(JSON.stringify(restored.toPersistence()).includes('sentinel'), false);
  assert.equal(restored.toPersistence().version, HANDOFF_PERSISTENCE_VERSION);
});

test('only separately validated UI intent may open or complete and intent binding is exact', () => {
  const { broker } = brokerWith();
  const created = requested(broker);
  toAwaiting(broker, created.handoffId);

  assert.throws(
    () => broker.open({
      handoffId: created.handoffId,
      uiIntent: { ...CONTEXT, handoffId: created.handoffId, intent: 'open' },
    }),
    (error) => error.code === 'UI_INTENT_INVALID',
  );

  assert.throws(
    () => broker.open({
      handoffId: created.handoffId,
      uiIntent: syntheticUiIntent({ handoffId: created.handoffId, ...CONTEXT, intent: 'open', sessionId: 'wrong' }),
    }),
    (error) => error.code === 'UI_INTENT_INVALID',
  );

  assert.throws(
    () => broker.open({
      handoffId: created.handoffId,
      uiIntent: syntheticUiIntent({
        handoffId: created.handoffId,
        ...CONTEXT,
        intent: 'open',
        safeOrigin: 'https://other.test',
      }),
    }),
    (error) => error.code === 'UI_INTENT_INVALID',
  );
});

test('constructor and request require trusted exact mission binding and safe origins', () => {
  assert.throws(
    () => createHandoffBroker({ validateUiIntent: () => true }),
    (error) => error.code === 'CONFIG_INVALID',
  );

  const rejected = createHandoffBroker({
    validateMissionBinding: () => false,
    now: () => new Date('2026-08-29T00:00:00.000Z'),
  });
  assert.throws(
    () => requested(rejected),
    (error) => error.code === 'MISSION_BINDING_INVALID',
  );

  const { broker } = brokerWith();
  assert.throws(
    () => requested(broker, { safeOrigin: 'http://example.test/login' }),
    (error) => error.code === 'SAFE_ORIGIN_INVALID',
  );
  assert.throws(
    () => requested(broker, { safeOrigin: 'https://alice:password@example.test/login' }),
    (error) => error.code === 'SAFE_ORIGIN_INVALID'
      && !error.message.includes('password'),
  );
  const loopbackBroker = createHandoffBroker({
    validateMissionBinding: () => true,
    now: () => new Date('2026-08-29T00:00:00.000Z'),
  });
  const loopback = loopbackBroker.request({
    type: 'login',
    ...CONTEXT,
    safeOrigin: 'http://127.0.0.1:3000',
    handoffId: 'loopback-one',
  });
  assert.equal(loopback.safeOrigin, 'http://127.0.0.1:3000');
});

test('CAPTCHA requires a separate validated checkbox intent and exact safeOrigin', () => {
  const { broker } = brokerWith();
  const created = requested(broker, { type: 'captcha', purpose: 'challenge checkbox' });
  toAwaiting(broker, created.handoffId);
  openable(broker, created.handoffId);
  broker.humanActive({ handoffId: created.handoffId });

  assert.throws(
    () => broker.captchaCheckboxAttempt({
      handoffId: created.handoffId,
      missionId: CONTEXT.missionId,
      memberId: CONTEXT.memberId,
      sessionId: CONTEXT.sessionId,
      pageFingerprint: CONTEXT.pageFingerprint,
      targetFingerprint: CONTEXT.targetFingerprint,
      purpose: 'challenge checkbox',
      safeOrigin: CONTEXT.safeOrigin,
    }),
    (error) => error.code === 'UI_INTENT_REQUIRED',
  );
  assert.throws(
    () => broker.captchaCheckboxAttempt({
      handoffId: created.handoffId,
      missionId: CONTEXT.missionId,
      memberId: CONTEXT.memberId,
      sessionId: CONTEXT.sessionId,
      pageFingerprint: CONTEXT.pageFingerprint,
      targetFingerprint: CONTEXT.targetFingerprint,
      purpose: 'challenge checkbox',
      safeOrigin: 'https://other.test',
      uiIntent: syntheticUiIntent({
        handoffId: created.handoffId,
        ...broker.state(created.handoffId),
        intent: 'captcha-checkbox',
      }),
    }),
    (error) => error.code === 'HANDOFF_BINDING_MISMATCH',
  );
  assert.throws(
    () => broker.captchaCheckboxAttempt({
      handoffId: created.handoffId,
      missionId: CONTEXT.missionId,
      memberId: CONTEXT.memberId,
      sessionId: CONTEXT.sessionId,
      pageFingerprint: CONTEXT.pageFingerprint,
      targetFingerprint: CONTEXT.targetFingerprint,
      purpose: 'challenge checkbox',
      safeOrigin: CONTEXT.safeOrigin,
      uiIntent: syntheticUiIntent({
        handoffId: created.handoffId,
        ...broker.state(created.handoffId),
        intent: 'open',
      }),
    }),
    (error) => error.code === 'UI_INTENT_INVALID',
  );
});

test('completion requires fresh proof and rejects binding drift', () => {
  const { broker } = brokerWith();
  const created = requested(broker);
  toAwaiting(broker, created.handoffId);
  openable(broker, created.handoffId);
  broker.humanActive({ handoffId: created.handoffId });
  broker.returnRequested({ handoffId: created.handoffId });
  broker.validate({ handoffId: created.handoffId });
  const uiIntent = syntheticUiIntent({
    handoffId: created.handoffId,
    ...broker.state(created.handoffId),
    intent: 'complete',
  });
  assert.throws(
    () => broker.complete({ handoffId: created.handoffId, uiIntent }),
    (error) => error.code === 'COMPLETION_PROOF_REQUIRED',
  );
  assert.throws(
    () => broker.complete({
      handoffId: created.handoffId,
      uiIntent,
      completionProof: completionProof(broker, created.handoffId, { sessionId: 'session-drift' }),
    }),
    (error) => error.code === 'HANDOFF_BINDING_MISMATCH',
  );
  assert.throws(
    () => broker.complete({
      handoffId: created.handoffId,
      sessionId: 'session-drift',
      uiIntent,
      completionProof: completionProof(broker, created.handoffId),
    }),
    (error) => error.code === 'COMPLETION_PROOF_BINDING_INVALID',
  );
  const completed = broker.complete({
    handoffId: created.handoffId,
    uiIntent,
    completionProof: completionProof(broker, created.handoffId),
  });
  assert.equal(completed.state, HANDOFF_STATES.COMPLETED);
});

test('handoff broker exports are available from the runtime index', () => {
  assert.equal(INDEX_HANDOFF_PERSISTENCE_VERSION, HANDOFF_PERSISTENCE_VERSION);
  assert.equal(INDEX_HANDOFF_STATES.COMPLETED, HANDOFF_STATES.COMPLETED);
  const indexed = createIndexedHandoffBroker({
    validateMissionBinding: () => true,
    validateUiIntent: () => false,
  });
  assert.equal(typeof indexed.request, 'function');
  assert.equal(typeof rehydrateIndexedHandoffBroker, 'function');
});

test('rehydration revalidates the exact mission binding and rejects persistence tampering', () => {
  const { broker } = brokerWith();
  const created = requested(broker);
  const persistence = broker.toPersistence();

  assert.throws(
    () => rehydrateHandoffBroker(persistence, {
      persistenceKey: PERSISTENCE_KEY,
      now: () => new Date('2026-08-29T00:00:01.000Z'),
      validateMissionBinding: () => false,
      validateUiIntent: () => false,
    }),
    (error) => error.code === 'MISSION_BINDING_INVALID',
  );

  for (const [mutate, expectedCode] of [
    [(copy) => { copy.handoffs[0].expiresAt = '2026-08-29T01:00:00.000Z'; }, 'PERSISTENCE_TIME_INVALID'],
    [(copy) => { copy.handoffs[0].state = HANDOFF_STATES.COMPLETED; }, 'PERSISTENCE_INTEGRITY_INVALID'],
  ]) {
    const tampered = structuredClone(persistence);
    mutate(tampered);
    assert.throws(
      () => rehydrateHandoffBroker(tampered, {
        persistenceKey: PERSISTENCE_KEY,
        now: () => new Date('2026-08-29T00:00:01.000Z'),
        validateMissionBinding: () => true,
        validateUiIntent: () => true,
      }),
      (error) => error.code === expectedCode,
    );
  }
  assert.equal(created.state, HANDOFF_STATES.REQUESTED);
});

test('rehydration preserves consumed UI intent fingerprints and blocks replay', () => {
  const { broker } = brokerWith();
  const created = requested(broker);
  toAwaiting(broker, created.handoffId);
  const token = syntheticUiIntent({
    handoffId: created.handoffId,
    ...broker.state(created.handoffId),
    intent: 'open',
  });
  broker.open({ handoffId: created.handoffId, uiIntent: token });

  const restored = rehydrateHandoffBroker(broker.toPersistence(), {
    persistenceKey: PERSISTENCE_KEY,
    now: () => new Date('2026-08-29T00:00:01.000Z'),
    validateMissionBinding: () => true,
    validateUiIntent: () => true,
  });
  assert.equal(restored.state(created.handoffId).state, HANDOFF_STATES.AWAITING_UI_GESTURE);
  assert.throws(
    () => restored.open({ handoffId: created.handoffId, uiIntent: token }),
    (error) => error.code === 'UI_INTENT_REPLAY',
  );
});

test('UI intents require one canonical exact binding including safeOrigin', () => {
  const broker = createHandoffBroker({
    persistenceKey: PERSISTENCE_KEY,
    now: () => new Date('2026-08-29T00:00:00.000Z'),
    idFactory: (prefix) => `${prefix}-canonical`,
    validateMissionBinding: () => true,
    validateUiIntent: () => true,
  });
  const created = requested(broker);
  toAwaiting(broker, created.handoffId);
  const exact = syntheticUiIntent({ handoffId: created.handoffId, ...created, intent: 'open' });
  const { safeOrigin, ...missingOrigin } = exact;
  assert.throws(
    () => broker.open({ handoffId: created.handoffId, uiIntent: missingOrigin }),
    (error) => error.code === 'UI_INTENT_INVALID',
  );
  assert.throws(
    () => broker.open({
      handoffId: created.handoffId,
      uiIntent: { ...missingOrigin, origin: safeOrigin },
    }),
    (error) => error.code === 'UI_INTENT_INVALID',
  );
});

test('completion proof requires canonical fresh binding and rejects conflicting aliases', () => {
  const { broker } = brokerWith();
  const created = requested(broker);
  toAwaiting(broker, created.handoffId);
  openable(broker, created.handoffId);
  broker.humanActive({ handoffId: created.handoffId });
  broker.returnRequested({ handoffId: created.handoffId });
  broker.validate({ handoffId: created.handoffId });
  const intent = syntheticUiIntent({
    handoffId: created.handoffId,
    ...broker.state(created.handoffId),
    intent: 'complete',
  });
  const exactProof = completionProof(broker, created.handoffId);
  assert.throws(
    () => broker.complete({
      handoffId: created.handoffId,
      uiIntent: intent,
      completionProof: { ...exactProof, sessionId: 'drift' },
    }),
    (error) => error.code === 'COMPLETION_PROOF_BINDING_INVALID',
  );
  assert.throws(
    () => broker.complete({
      handoffId: created.handoffId,
      uiIntent: { ...intent, nonce: 'fresh-ui-intent' },
      completionProof: { ...exactProof, fresh: false },
    }),
    (error) => error.code === 'COMPLETION_PROOF_INVALID',
  );
});
