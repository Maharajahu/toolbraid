import assert from 'node:assert/strict';
import test from 'node:test';

import { createMissionController } from '../../src/app/mission-controller.js';
import { createRecoveryProviderCatalog } from '../../src/providers/recovery/catalog.js';

test('runs the real recovery engine from WebMCP discovery through sealed execution', async () => {
  let nowTick = 0;
  const controller = createMissionController({
    documentRef: null,
    orchestratorOrigin: 'https://app.toolbraid.dev',
    now: () => new Date(Date.parse('2026-08-27T12:00:00.000Z') + nowTick++ * 1000),
  });
  const events = [];
  controller.subscribe(({ event, details }) => events.push({ event, details }));

  let snapshot = await controller.discoverAndPlan(
    'Restore checkout, prepare a safe recovery and customer update, and wait for my approval.',
  );
  assert.equal(snapshot.mode, 'test');
  assert.equal(snapshot.discoveredTools.length, 9);
  assert.equal(snapshot.normalization.stats.securityExcludedTools, 1);
  assert.equal(snapshot.normalization.mappings.length, 7);
  assert.equal(snapshot.plan.nodes.length, 9);
  assert.equal(snapshot.plan.mutationArgumentsFinalized, false);
  const quarantinedToolId = snapshot.normalization.quarantined[0].toolId;
  const quarantinedDescriptor = snapshot.discoveredTools.find(({ id }) => id === quarantinedToolId);
  assert.equal(quarantinedDescriptor.schemaFingerprint, null);
  assert.equal(quarantinedDescriptor.description, 'Quarantined before capability scoring.');

  snapshot = await controller.runSafe();
  assert.equal(snapshot.plan.status, 'approval_required');
  assert.equal(snapshot.plan.mutationArgumentsFinalized, true);
  assert.equal(Object.keys(snapshot.results).length, 7);
  assert.ok(events.some(({ event }) => event === 'tool.execution_failed'));
  assert.ok(events.some(({ event }) => event === 'tool.failover_selected'));
  const apply = snapshot.plan.nodes.find(({ id }) => id === 'apply-recovery-option');
  const publish = snapshot.plan.nodes.find(({ id }) => id === 'publish-status-update');
  assert.equal(apply.arguments.recoveryOptionId, 'recovery-option-checkout-r3');
  assert.equal(apply.arguments.quoteRevision, 'quote-r3');
  assert.equal(publish.arguments.noticeRevision, 'notice-r8');
  assert.match(publish.arguments.body, /release-1842/);

  await controller.approve('apply');
  const approval = await controller.approve('publish');
  assert.match(approval.envelope.fingerprint, /^[a-f0-9]{64}$/);
  snapshot = await controller.executeApproved();

  assert.equal(snapshot.plan.status, 'completed');
  assert.equal(snapshot.providerState.activeReleaseId, 'release-1841');
  assert.equal(snapshot.providerState.noticeRevision, 'notice-r9');
  assert.equal(snapshot.providerState.appliedRequestCount, 1);
  assert.equal(snapshot.providerState.publishedRequestCount, 1);
  assert.equal(snapshot.auditVerified, true);
  assert.equal(snapshot.seal.algorithm, 'sha256-chain-v1');
  assert.match(snapshot.seal.head, /^[a-f0-9]{64}$/);
  await assert.rejects(
    () => controller.executeApproved(),
    (error) => error.code === 'APPROVAL_REPLAY_BLOCKED',
  );
});

test('uses a unique mission identity and idempotency keys after every reset', async () => {
  let sequence = 0;
  const controller = createMissionController({
    documentRef: null,
    orchestratorOrigin: 'https://app.toolbraid.dev',
    missionIdFactory: () => `recovery-test-${String(++sequence).padStart(4, '0')}`,
  });

  const runMissionToReview = async () => {
    await controller.discoverAndPlan('Prepare an exact recovery without external effects.');
    const snapshot = await controller.runSafe();
    return {
      planId: snapshot.plan.id,
      applyKey: snapshot.plan.nodes.find(({ id }) => id === 'apply-recovery-option').arguments.idempotencyKey,
      publishKey: snapshot.plan.nodes.find(({ id }) => id === 'publish-status-update').arguments.idempotencyKey,
    };
  };

  const first = await runMissionToReview();
  await controller.reset();
  const second = await runMissionToReview();

  assert.notEqual(first.planId, second.planId);
  assert.notEqual(first.applyKey, second.applyKey);
  assert.notEqual(first.publishKey, second.publishKey);
});

test('rejects reset while an operation is still settling', async () => {
  const controller = createMissionController({
    documentRef: null,
    orchestratorOrigin: 'https://app.toolbraid.dev',
    missionIdFactory: () => 'recovery-busy-0001',
  });

  const discovery = controller.discoverAndPlan('Prepare a recovery plan.');
  await assert.rejects(
    () => controller.reset(),
    (error) => error.code === 'MISSION_BUSY' && error.details.activeOperation === 'discoverAndPlan',
  );
  await discovery;
  await controller.reset();
  assert.equal(controller.snapshot().plan, null);
});

test('seals and exposes durable partial receipts when publication fails after recovery applies', async () => {
  const controller = createMissionController({
    documentRef: null,
    orchestratorOrigin: 'https://app.toolbraid.dev',
    missionIdFactory: () => 'recovery-partial-0001',
    catalogFactory: ({ now }) => createRecoveryProviderCatalog({ now, failPublish: true }),
  });

  await controller.discoverAndPlan('Restore checkout and publish the exact reviewed update.');
  await controller.runSafe();
  await controller.approve('apply');
  await controller.approve('publish');

  let failure;
  try {
    await controller.executeApproved();
  } catch (error) {
    failure = error;
  }
  assert.equal(failure.code, 'STATUS_PROVIDER_UNAVAILABLE');
  const snapshot = failure.snapshot;
  assert.equal(snapshot.plan.status, 'failed');
  assert.equal(snapshot.providerState.activeReleaseId, 'release-1841');
  assert.equal(snapshot.providerState.noticeRevision, 'notice-r8');
  assert.equal(snapshot.providerState.appliedRequestCount, 1);
  assert.equal(snapshot.providerState.publishedRequestCount, 0);
  assert.equal(snapshot.results['apply-recovery-option'].status, 'applied');
  assert.equal(snapshot.auditVerified, true);
  assert.match(snapshot.seal.head, /^[a-f0-9]{64}$/);
  assert.ok(snapshot.audit.some(({ event }) => event === 'mission.execution_failed'));
});
