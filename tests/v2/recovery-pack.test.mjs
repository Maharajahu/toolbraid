import assert from 'node:assert/strict';
import test from 'node:test';

import { runnableNodes } from '../../src/engine/graph.js';
import { normalizeDiscoveredTools } from '../../src/engine/normalizer.js';
import {
  RECOVERY_CAPABILITIES,
  RECOVERY_CAPABILITY_IDS as CAPABILITY,
  RECOVERY_ONTOLOGY,
} from '../../src/packs/recovery/ontology.js';
import {
  buildRecoveryPlan,
  finalizeRecoveryMutationArguments,
} from '../../src/packs/recovery/plan.js';

let mappingSequence = 0;

function mappings(prefix = 'unfamiliar') {
  mappingSequence += 1;
  return Object.fromEntries(RECOVERY_CAPABILITIES.map((definition, index) => [
    definition.id,
    {
      capabilityId: definition.id,
      toolOrigin: `https://${prefix}-${index}-${mappingSequence}.example`,
      toolName: `${prefix}_operation_${index}`,
      toolSchemaFingerprint: String(index + 1).repeat(64),
      confidence: 0.91,
      evidence: [{ cue: definition.semanticCues.nouns[0] }],
    },
  ]));
}

function argumentsByCapability() {
  return {
    [CAPABILITY.SERVICE_HEALTH_READ]: { serviceId: 'checkout', windowMinutes: 30 },
    [CAPABILITY.RELEASE_HISTORY_READ]: { serviceId: 'checkout', limit: 5 },
    [CAPABILITY.DEPLOYMENT_HISTORY_READ]: { serviceId: 'checkout', environment: 'production', limit: 5 },
    [CAPABILITY.RECOVERY_OPTION_PREPARE]: {
      deploymentId: 'deployment-1842',
      targetReleaseId: 'release-1841',
      strategy: 'rollback',
    },
    [CAPABILITY.RECOVERY_OPTION_APPLY]: {
      recoveryOptionId: 'recovery-option-7',
      quoteRevision: 'quote-r3',
      idempotencyKey: 'apply-plan-1-revision-1-node-recovery',
      preconditions: { expectedActiveReleaseId: 'release-1842' },
    },
    [CAPABILITY.STATUS_NOTICE_READ]: { serviceId: 'checkout' },
    [CAPABILITY.STATUS_NOTICE_PUBLISH]: {
      noticeId: 'notice-checkout',
      noticeRevision: 'notice-r8',
      title: 'Checkout recovery in progress',
      body: 'We identified the latest deployment as the likely cause and are applying a safe recovery.',
      idempotencyKey: 'publish-plan-1-revision-1-node-notice',
    },
  };
}

function planWith(prefix = 'unfamiliar') {
  return buildRecoveryPlan({
    id: `plan-${prefix}`,
    objective: 'Restore checkout without changing production or publishing before approval.',
    mappings: mappings(prefix),
    argumentsByCapability: argumentsByCapability(),
    now: new Date('2026-08-27T12:00:00.000Z'),
  });
}

function deferredPlanWith(prefix = 'deferred') {
  const supplied = argumentsByCapability();
  delete supplied[CAPABILITY.RECOVERY_OPTION_APPLY];
  delete supplied[CAPABILITY.STATUS_NOTICE_PUBLISH];
  return buildRecoveryPlan({
    id: `plan-${prefix}`,
    mappings: mappings(prefix),
    argumentsByCapability: supplied,
    deferMutationArguments: true,
    now: new Date('2026-08-27T12:00:00.000Z'),
  });
}

function completeSafeStage(plan, overrides = {}) {
  const values = {
    'read-service-health': { status: 'degraded', errorRate: 0.21 },
    'read-release-history': { releases: [{ releaseId: 'release-1841' }] },
    'read-deployment-history': { deployments: [{ deploymentId: 'deployment-1842' }] },
    'read-status-notice': {
      noticeId: 'notice-checkout',
      noticeRevision: 'notice-r8',
      body: 'Investigating checkout errors.',
    },
    'correlate-evidence': {
      deploymentId: 'deployment-1842',
      targetReleaseId: 'release-1841',
    },
    'prepare-recovery-option': {
      recoveryOptionId: 'recovery-option-live-7',
      quoteRevision: 'quote-live-r3',
      effectSummary: 'Restore checkout to release-1841.',
      preconditions: { expectedActiveReleaseId: 'release-1842' },
    },
    'draft-status-update': {
      title: 'Checkout recovery in progress',
      body: 'We isolated the latest deployment and are restoring the previous release.',
      effectSummary: 'Publish the reviewed checkout recovery update.',
    },
    ...overrides,
  };
  const results = new Map();
  for (const [nodeId, result] of Object.entries(values)) {
    const node = plan.nodes.find((candidate) => candidate.id === nodeId);
    node.status = 'completed';
    node.result = result;
    results.set(nodeId, result);
  }
  return results;
}

test('ontology declaratively covers all seven bounded capabilities with cues and aliases', () => {
  assert.equal(RECOVERY_ONTOLOGY.capabilities.length, 7);
  assert.deepEqual(
    new Set(RECOVERY_ONTOLOGY.capabilities.map(({ id }) => id)),
    new Set(Object.values(CAPABILITY)),
  );
  for (const definition of RECOVERY_ONTOLOGY.capabilities) {
    assert.ok(definition.semanticCues.names.length > 0);
    assert.ok(definition.semanticCues.verbs.length > 0);
    assert.ok(definition.semanticCues.nouns.length > 0);
    assert.ok(Object.keys(definition.inputAliases).length > 0);
    assert.ok(Object.keys(definition.outputAliases).length > 0);
    assert.equal(Object.isFrozen(definition), true);
  }
});

test('builds four independent reads followed by correlation, parallel preparation, and separate gates', () => {
  const plan = planWith();

  assert.deepEqual(
    runnableNodes(plan).map(({ id }) => id),
    ['read-service-health', 'read-release-history', 'read-deployment-history', 'read-status-notice'],
  );
  assert.deepEqual(plan.nodes.find(({ id }) => id === 'correlate-evidence').dependencies, [
    'read-service-health',
    'read-release-history',
    'read-deployment-history',
    'read-status-notice',
  ]);
  assert.deepEqual(plan.nodes.find(({ id }) => id === 'prepare-recovery-option').dependencies, ['correlate-evidence']);
  assert.deepEqual(plan.nodes.find(({ id }) => id === 'draft-status-update').dependencies, ['correlate-evidence']);
  assert.deepEqual(plan.nodes.find(({ id }) => id === 'apply-recovery-option').dependencies, ['prepare-recovery-option']);
  assert.deepEqual(plan.nodes.find(({ id }) => id === 'publish-status-update').dependencies, [
    'draft-status-update',
    'apply-recovery-option',
  ]);
  assert.deepEqual(
    plan.nodes.filter(({ approvalRequired }) => approvalRequired).map(({ id }) => id),
    ['apply-recovery-option', 'publish-status-update'],
  );
});

test('fails closed when any required capability mapping is absent', () => {
  const incomplete = mappings();
  delete incomplete[CAPABILITY.DEPLOYMENT_HISTORY_READ];

  assert.throws(
    () => buildRecoveryPlan({ mappings: incomplete, argumentsByCapability: argumentsByCapability() }),
    (error) => error.code === 'RECOVERY_MAPPING_MISSING'
      && error.details.capabilityId === CAPABILITY.DEPLOYMENT_HISTORY_READ,
  );
});

test('provider substitution changes only mapping identity, never DAG logic', () => {
  const first = planWith('alpha');
  const second = planWith('omega');
  const projectStructure = (plan) => plan.nodes.map((node) => ({
    id: node.id,
    kind: node.kind,
    capabilityId: node.capabilityId ?? null,
    dependencies: node.dependencies,
    approvalRequired: node.approvalRequired,
  }));

  assert.deepEqual(projectStructure(first), projectStructure(second));
  assert.notEqual(
    first.nodes.find(({ capabilityId }) => capabilityId === CAPABILITY.SERVICE_HEALTH_READ).mapping.toolName,
    second.nodes.find(({ capabilityId }) => capabilityId === CAPABILITY.SERVICE_HEALTH_READ).mapping.toolName,
  );
  assert.equal(first.nodes.some((node) => Object.hasOwn(node, 'provider')), false);
});

test('feeds the declarative ontology directly into the normalizer and preserves exact live tool handles', () => {
  const tools = RECOVERY_CAPABILITIES.map((definition, index) => ({
    origin: `https://live-${index}.example`,
    name: definition.semanticCues.names[0],
    title: definition.title,
    description: definition.purpose,
    inputSchema: {
      type: 'object',
      properties: Object.fromEntries(definition.requiredConcepts.map((concept) => [
        concept,
        { type: 'string', title: concept, description: `${concept} for this operation` },
      ])),
      required: [...definition.requiredConcepts],
    },
    annotations: { readOnlyHint: definition.minimumRisk === 0 },
  }));
  const normalized = normalizeDiscoveredTools({
    tools,
    capabilityPack: RECOVERY_CAPABILITIES,
    minimumConfidence: 0.45,
    ambiguityMargin: 0.04,
  });

  assert.equal(normalized.mappings.every(({ primary }) => primary !== null), true);
  const plan = buildRecoveryPlan({ mappings: normalized.mappings, argumentsByCapability: argumentsByCapability() });
  for (const node of plan.nodes.filter(({ type }) => type === 'tool')) {
    const expectedTool = normalized.mappings.find(({ capabilityId }) => capabilityId === node.capabilityId).primary.tool;
    assert.equal(node.mapping.tool, expectedTool);
    assert.equal(Object.prototype.propertyIsEnumerable.call(node.mapping, 'tool'), false);
  }
});

test('attaches immutable exact mutation arguments while both nodes are still pending approval', () => {
  const supplied = argumentsByCapability();
  const plan = buildRecoveryPlan({ mappings: mappings(), argumentsByCapability: supplied });
  const apply = plan.nodes.find(({ id }) => id === 'apply-recovery-option');
  const publish = plan.nodes.find(({ id }) => id === 'publish-status-update');

  assert.equal(apply.status, 'pending');
  assert.equal(publish.status, 'pending');
  assert.equal(apply.approvalRequired, true);
  assert.equal(publish.approvalRequired, true);
  assert.deepEqual(apply.arguments, supplied[CAPABILITY.RECOVERY_OPTION_APPLY]);
  assert.deepEqual(publish.arguments, supplied[CAPABILITY.STATUS_NOTICE_PUBLISH]);
  assert.equal(apply.arguments.quoteRevision, 'quote-r3');
  assert.equal(apply.arguments.idempotencyKey, 'apply-plan-1-revision-1-node-recovery');
  assert.equal(publish.arguments.idempotencyKey, 'publish-plan-1-revision-1-node-notice');
  assert.equal(Object.isFrozen(apply.arguments), true);
  assert.equal(Object.isFrozen(apply.arguments.preconditions), true);
  assert.equal(Object.isFrozen(publish.arguments), true);

  supplied[CAPABILITY.RECOVERY_OPTION_APPLY].quoteRevision = 'tampered-after-build';
  assert.equal(apply.arguments.quoteRevision, 'quote-r3');
});

test('fails closed if exact mutation preconditions are not present before approval', () => {
  const supplied = argumentsByCapability();
  delete supplied[CAPABILITY.RECOVERY_OPTION_APPLY].quoteRevision;

  assert.throws(
    () => buildRecoveryPlan({ mappings: mappings(), argumentsByCapability: supplied }),
    (error) => error.code === 'RECOVERY_ARGUMENTS_INCOMPLETE'
      && error.details.field === 'quoteRevision',
  );
});

test('explicitly builds a deferred recovery plan without weakening strict planning by default', () => {
  const deferred = deferredPlanWith();
  const apply = deferred.nodes.find(({ id }) => id === 'apply-recovery-option');
  const publish = deferred.nodes.find(({ id }) => id === 'publish-status-update');

  assert.deepEqual(apply.arguments, {});
  assert.deepEqual(publish.arguments, {});
  assert.equal(apply.argumentsDeferred, true);
  assert.equal(publish.argumentsDeferred, true);
  assert.equal(Object.isFrozen(apply.arguments), false);
  assert.equal(deferred.metadata.mutationArgumentsDeferred, true);
  assert.equal(deferred.metadata.mutationArgumentsFinalized, false);

  assert.throws(
    () => buildRecoveryPlan({ mappings: mappings(), argumentsByCapability: {} }),
    (error) => error.code === 'RECOVERY_ARGUMENTS_MISSING'
      && error.details.capabilityId === CAPABILITY.RECOVERY_OPTION_APPLY,
  );
  assert.throws(
    () => buildRecoveryPlan({
      mappings: mappings(),
      argumentsByCapability: argumentsByCapability(),
      deferMutationArguments: 'yes',
    }),
    (error) => error.code === 'RECOVERY_OPTION_INVALID',
  );
});

test('finalizes exact mutation arguments atomically from completed real results and deep-freezes them', () => {
  const plan = deferredPlanWith('two-stage');
  const results = completeSafeStage(plan);
  const preparedSource = results.get('prepare-recovery-option');
  const draftSource = results.get('draft-status-update');

  finalizeRecoveryMutationArguments(plan, {
    results,
    idempotencyKeys: {
      [CAPABILITY.RECOVERY_OPTION_APPLY]: 'apply-live-plan-r1',
      [CAPABILITY.STATUS_NOTICE_PUBLISH]: 'publish-live-plan-r1',
    },
  });

  const apply = plan.nodes.find(({ id }) => id === 'apply-recovery-option');
  const publish = plan.nodes.find(({ id }) => id === 'publish-status-update');
  assert.deepEqual(apply.arguments, {
    recoveryOptionId: 'recovery-option-live-7',
    quoteRevision: 'quote-live-r3',
    idempotencyKey: 'apply-live-plan-r1',
    preconditions: { expectedActiveReleaseId: 'release-1842' },
  });
  assert.deepEqual(publish.arguments, {
    noticeId: 'notice-checkout',
    noticeRevision: 'notice-r8',
    title: 'Checkout recovery in progress',
    body: 'We isolated the latest deployment and are restoring the previous release.',
    idempotencyKey: 'publish-live-plan-r1',
  });
  assert.equal(apply.effectSummary, 'Restore checkout to release-1841.');
  assert.equal(publish.effectSummary, 'Publish the reviewed checkout recovery update.');
  assert.equal(apply.argumentsDeferred, false);
  assert.equal(publish.argumentsDeferred, false);
  assert.equal(Object.isFrozen(apply.arguments), true);
  assert.equal(Object.isFrozen(apply.arguments.preconditions), true);
  assert.equal(Object.isFrozen(publish.arguments), true);
  assert.equal(plan.metadata.mutationArgumentsDeferred, false);
  assert.equal(plan.metadata.mutationArgumentsFinalized, true);

  preparedSource.preconditions.expectedActiveReleaseId = 'tampered-after-finalization';
  draftSource.body = 'tampered after finalization';
  assert.equal(apply.arguments.preconditions.expectedActiveReleaseId, 'release-1842');
  assert.equal(publish.arguments.body, 'We isolated the latest deployment and are restoring the previous release.');
});

test('refuses finalization before the safe stage completes', () => {
  const plan = deferredPlanWith('not-ready');

  assert.throws(
    () => finalizeRecoveryMutationArguments(plan),
    (error) => error.code === 'RECOVERY_FINALIZATION_NOT_READY'
      && error.details.nodeId === 'read-service-health',
  );
});

test('refuses finalization when a completed safe node has no recorded result', () => {
  const plan = deferredPlanWith('missing-result');
  const results = completeSafeStage(plan);
  const releaseNode = plan.nodes.find(({ id }) => id === 'read-release-history');
  releaseNode.result = null;
  results.delete('read-release-history');

  assert.throws(
    () => finalizeRecoveryMutationArguments(plan, { results }),
    (error) => error.code === 'RECOVERY_RESULT_MISSING'
      && error.details.nodeId === 'read-release-history',
  );
});

test('failed mutation argument validation leaves both deferred gates untouched', () => {
  const plan = deferredPlanWith('invalid-draft');
  const results = completeSafeStage(plan, {
    'draft-status-update': { title: 'Checkout recovery in progress', body: '' },
  });

  assert.throws(
    () => finalizeRecoveryMutationArguments(plan, { results }),
    (error) => error.code === 'RECOVERY_ARGUMENTS_INCOMPLETE'
      && error.details.capabilityId === CAPABILITY.STATUS_NOTICE_PUBLISH
      && error.details.field === 'body',
  );
  for (const nodeId of ['apply-recovery-option', 'publish-status-update']) {
    const node = plan.nodes.find(({ id }) => id === nodeId);
    assert.deepEqual(node.arguments, {});
    assert.equal(node.argumentsDeferred, true);
  }
  assert.equal(plan.metadata.mutationArgumentsDeferred, true);
  assert.equal(plan.metadata.mutationArgumentsFinalized, false);
});

test('rejects supplied results that differ from the completed results recorded by the plan', () => {
  const plan = deferredPlanWith('result-mismatch');
  const results = completeSafeStage(plan);
  results.set('prepare-recovery-option', {
    ...results.get('prepare-recovery-option'),
    quoteRevision: 'attacker-revision',
  });

  assert.throws(
    () => finalizeRecoveryMutationArguments(plan, { results }),
    (error) => error.code === 'RECOVERY_RESULT_MISMATCH'
      && error.details.nodeId === 'prepare-recovery-option',
  );
});
