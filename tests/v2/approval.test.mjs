import test from 'node:test';
import assert from 'node:assert/strict';

import {
  claimApprovalEnvelope,
  claimApprovalEnvelopeSet,
  consumeApprovalEnvelope,
  createApprovalEnvelope,
  sha256Hex,
  verifyApprovalEnvelope,
} from '../../src/engine/approval.js';

const ISSUED_AT = '2026-08-27T12:00:00.000Z';
const EXPIRES_AT = '2026-08-27T12:05:00.000Z';
const VALID_NOW = '2026-08-27T12:01:00.000Z';
const SCHEMA_FINGERPRINT = 'a'.repeat(64);
let nonceSequence = 0;

function binding(overrides = {}) {
  nonceSequence += 1;
  return {
    planId: 'plan-production-recovery',
    planRevision: 7,
    nodeId: 'apply-approved-recovery',
    toolOrigin: 'https://deploy.example',
    toolName: 'apply_recovery',
    toolSchemaFingerprint: SCHEMA_FINGERPRINT,
    canonicalCapability: 'recovery.option.apply',
    normalizedArguments: {
      deploymentId: 'deploy-1842',
      idempotencyKey: 'recovery-plan-production-recovery-r7',
      quoteRevision: 'quote-r3',
      strategy: { mode: 'rollback', target: 'release-1841' },
    },
    effectSummary: 'Roll back checkout to release-1841.',
    risk: 'external-mutation',
    nonce: `approval-test-${nonceSequence}`,
    issuedAt: ISSUED_AT,
    expiresAt: EXPIRES_AT,
    ...overrides,
  };
}

function contextFrom(source) {
  return {
    planId: source.planId,
    planRevision: source.planRevision,
    nodeId: source.nodeId,
    toolOrigin: source.toolOrigin,
    toolName: source.toolName,
    toolSchemaFingerprint: source.toolSchemaFingerprint,
    canonicalCapability: source.canonicalCapability,
    normalizedArguments: structuredClone(source.normalizedArguments),
    effectSummary: source.effectSummary,
    risk: source.risk,
  };
}

function assertCode(code) {
  return (error) => error?.code === code;
}

test('creates and verifies an exact provider-independent v2 approval envelope', () => {
  const source = binding();
  const envelope = createApprovalEnvelope(source);

  assert.equal(verifyApprovalEnvelope(envelope, contextFrom(source), { now: VALID_NOW }), true);
  assert.equal(envelope.version, 2);
  assert.equal(envelope.expiresAt, EXPIRES_AT);
  assert.equal(envelope.normalizedArguments.quoteRevision, 'quote-r3');
  assert.equal(envelope.normalizedArguments.idempotencyKey, 'recovery-plan-production-recovery-r7');
  assert.match(envelope.fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('rejects any bound envelope field tampering', () => {
  const source = binding();
  const envelope = createApprovalEnvelope(source);
  const tampered = { ...envelope, effectSummary: 'Publish an unrelated customer notice.' };

  assert.throws(
    () => verifyApprovalEnvelope(tampered, contextFrom(source), { now: VALID_NOW }),
    assertCode('APPROVAL_RECORD_TAMPERED'),
  );
});

test('rejects a changed plan revision', () => {
  const source = binding();
  const envelope = createApprovalEnvelope(source);
  const current = { ...contextFrom(source), planRevision: source.planRevision + 1 };

  assert.throws(
    () => verifyApprovalEnvelope(envelope, current, { now: VALID_NOW }),
    assertCode('APPROVAL_PLAN_REVISION_MISMATCH'),
  );
});

test('rejects any exact normalized argument change', () => {
  const source = binding();
  const envelope = createApprovalEnvelope(source);
  const current = contextFrom(source);
  current.normalizedArguments.strategy.target = 'release-1700';

  assert.throws(
    () => verifyApprovalEnvelope(envelope, current, { now: VALID_NOW }),
    assertCode('APPROVAL_ARGUMENTS_MISMATCH'),
  );
});

test('rejects a changed provider origin', () => {
  const source = binding();
  const envelope = createApprovalEnvelope(source);

  assert.throws(
    () => verifyApprovalEnvelope(envelope, { ...contextFrom(source), toolOrigin: 'https://attacker.example' }, { now: VALID_NOW }),
    assertCode('APPROVAL_TOOL_ORIGIN_MISMATCH'),
  );
});

test('rejects a changed native tool name', () => {
  const source = binding();
  const envelope = createApprovalEnvelope(source);

  assert.throws(
    () => verifyApprovalEnvelope(envelope, { ...contextFrom(source), toolName: 'publish_update' }, { now: VALID_NOW }),
    assertCode('APPROVAL_TOOL_NAME_MISMATCH'),
  );
});

test('rejects a changed live tool schema fingerprint', () => {
  const source = binding();
  const envelope = createApprovalEnvelope(source);

  assert.throws(
    () => verifyApprovalEnvelope(
      envelope,
      { ...contextFrom(source), toolSchemaFingerprint: 'b'.repeat(64) },
      { now: VALID_NOW },
    ),
    assertCode('APPROVAL_TOOL_SCHEMA_MISMATCH'),
  );
});

test('rejects an expired approval', () => {
  const source = binding();
  const envelope = createApprovalEnvelope(source);

  assert.throws(
    () => verifyApprovalEnvelope(envelope, contextFrom(source), { now: EXPIRES_AT }),
    assertCode('APPROVAL_EXPIRED'),
  );
});

test('claims the nonce without mutating the envelope and blocks replay of the original object', () => {
  const source = binding();
  const envelope = createApprovalEnvelope(source);
  const current = contextFrom(source);
  const receipt = claimApprovalEnvelope(envelope, current, { now: VALID_NOW });

  assert.equal(receipt.nonce, envelope.nonce);
  assert.equal(Object.hasOwn(envelope, 'claimedAt'), false);
  assert.throws(
    () => verifyApprovalEnvelope(envelope, current, { now: VALID_NOW }),
    assertCode('APPROVAL_REPLAY_BLOCKED'),
  );
});

test('an invalid claim leaves every nonce in the set unconsumed', () => {
  const firstSource = binding({ nodeId: 'apply-approved-recovery' });
  const secondSource = binding({ nodeId: 'publish-status-update' });
  const firstEnvelope = createApprovalEnvelope(firstSource);
  const secondEnvelope = createApprovalEnvelope(secondSource);
  const tamperedSecond = { ...secondEnvelope, effectSummary: 'Tampered effect.' };

  assert.throws(
    () => claimApprovalEnvelopeSet([
      { envelope: firstEnvelope, expected: contextFrom(firstSource) },
      { envelope: tamperedSecond, expected: contextFrom(secondSource) },
    ], { now: VALID_NOW }),
    assertCode('APPROVAL_RECORD_TAMPERED'),
  );

  assert.equal(verifyApprovalEnvelope(firstEnvelope, contextFrom(firstSource), { now: VALID_NOW }), true);
  assert.equal(claimApprovalEnvelope(firstEnvelope, contextFrom(firstSource), { now: VALID_NOW }).nonce, firstEnvelope.nonce);
});

test('rejects duplicate nonces within a claim set without consuming either envelope', () => {
  const sharedNonce = `approval-duplicate-${++nonceSequence}`;
  const firstSource = binding({ nodeId: 'apply-approved-recovery', nonce: sharedNonce });
  const secondSource = binding({ nodeId: 'publish-status-update', nonce: sharedNonce });
  const firstEnvelope = createApprovalEnvelope(firstSource);
  const secondEnvelope = createApprovalEnvelope(secondSource);

  assert.throws(
    () => claimApprovalEnvelopeSet([
      { envelope: firstEnvelope, expected: contextFrom(firstSource) },
      { envelope: secondEnvelope, expected: contextFrom(secondSource) },
    ], { now: VALID_NOW }),
    assertCode('APPROVAL_DUPLICATE_NONCE'),
  );

  assert.equal(verifyApprovalEnvelope(firstEnvelope, contextFrom(firstSource), { now: VALID_NOW }), true);
  assert.equal(claimApprovalEnvelope(firstEnvelope, contextFrom(firstSource), { now: VALID_NOW }).nonce, sharedNonce);
});

test('claims a valid approval set together and blocks replay of every envelope', () => {
  const firstSource = binding({ nodeId: 'apply-approved-recovery' });
  const secondSource = binding({ nodeId: 'publish-status-update' });
  const firstEnvelope = createApprovalEnvelope(firstSource);
  const secondEnvelope = createApprovalEnvelope(secondSource);

  const receipts = claimApprovalEnvelopeSet([
    { envelope: firstEnvelope, expected: contextFrom(firstSource) },
    { envelope: secondEnvelope, expected: contextFrom(secondSource) },
  ], { now: VALID_NOW });

  assert.equal(Object.isFrozen(receipts), true);
  assert.deepEqual(receipts.map(({ nonce }) => nonce), [firstEnvelope.nonce, secondEnvelope.nonce]);
  assert.throws(
    () => verifyApprovalEnvelope(firstEnvelope, contextFrom(firstSource), { now: VALID_NOW }),
    assertCode('APPROVAL_REPLAY_BLOCKED'),
  );
  assert.throws(
    () => verifyApprovalEnvelope(secondEnvelope, contextFrom(secondSource), { now: VALID_NOW }),
    assertCode('APPROVAL_REPLAY_BLOCKED'),
  );
});

test('two concurrent consumptions allow exactly one mutation', async () => {
  const source = binding();
  const envelope = createApprovalEnvelope(source);
  const current = contextFrom(source);
  let mutationCount = 0;

  const mutate = async () => {
    mutationCount += 1;
    await Promise.resolve();
    return 'applied';
  };

  const outcomes = await Promise.allSettled([
    consumeApprovalEnvelope(envelope, current, mutate, { now: VALID_NOW }),
    consumeApprovalEnvelope(envelope, current, mutate, { now: VALID_NOW }),
  ]);

  assert.equal(outcomes.filter(({ status }) => status === 'fulfilled').length, 1);
  assert.equal(outcomes.filter(({ status }) => status === 'rejected').length, 1);
  assert.equal(outcomes.find(({ status }) => status === 'rejected').reason.code, 'APPROVAL_REPLAY_BLOCKED');
  assert.equal(mutationCount, 1);
});
