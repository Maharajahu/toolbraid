import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeDiscoveredTools } from '../../src/engine/normalizer.js';
import {
  createInMemoryWebMcpHub,
  createTestWebMcpClient,
} from '../../src/engine/webmcp.js';
import {
  buildRecoveryToolInput,
  canonicalizeRecoveryOutput,
  validateRecoveryOutput,
} from '../../src/packs/recovery/adapters.js';
import {
  RECOVERY_CAPABILITIES,
  RECOVERY_CAPABILITY_IDS as CAPABILITY,
} from '../../src/packs/recovery/ontology.js';
import {
  RECOVERY_PROVIDER_ORIGINS,
  createRecoveryProviderCatalog,
  registerRecoveryProviderCatalog,
} from '../../src/providers/recovery/catalog.js';

const ORCHESTRATOR = 'https://control.toolbraid.dev';
const FIXED_NOW = () => new Date('2026-08-27T12:00:00.000Z');

function locateTool(catalog, name) {
  for (const provider of catalog.providers) {
    const tool = provider.tools.find((candidate) => candidate.name === name);
    if (tool) return { provider, tool };
  }
  throw new Error(`Missing recovery fixture tool: ${name}`);
}

async function executeCanonical(catalog, name, capabilityId, canonicalArguments) {
  const { tool } = locateTool(catalog, name);
  const input = buildRecoveryToolInput(capabilityId, tool.inputSchema, canonicalArguments);
  const raw = await tool.execute(input);
  const output = canonicalizeRecoveryOutput(capabilityId, raw);
  assert.equal(validateRecoveryOutput(capabilityId, output), output);
  return output;
}

test('discovers nine tools from six origins, quarantines hostile metadata before scoring, and retains health fallback', async () => {
  const catalog = createRecoveryProviderCatalog({ now: FIXED_NOW });
  const hub = createInMemoryWebMcpHub();
  const orchestrator = hub.createContext(ORCHESTRATOR);
  await registerRecoveryProviderCatalog({ hub, orchestratorOrigin: ORCHESTRATOR, catalog });

  const client = createTestWebMcpClient({
    context: orchestrator,
    allowedOrigins: Object.values(RECOVERY_PROVIDER_ORIGINS),
  });
  const discovered = await client.discover();
  assert.equal(discovered.length, 9);
  assert.deepEqual(new Set(discovered.map(({ origin }) => origin)), new Set(Object.values(RECOVERY_PROVIDER_ORIGINS)));

  const normalized = normalizeDiscoveredTools({
    tools: discovered,
    capabilityPack: RECOVERY_CAPABILITIES,
  });
  assert.deepEqual(normalized.stats, {
    discoveredTools: 9,
    securityExcludedTools: 1,
    scoredTools: 8,
    acceptedTools: 8,
    rejectedTools: 0,
  });
  assert.equal(normalized.quarantined.length, 1);
  assert.equal(normalized.quarantined[0].identity.origin, RECOVERY_PROVIDER_ORIGINS.mirage);
  assert.equal(normalized.quarantined[0].identity.name, 'override_approval');
  assert.equal(normalized.quarantined[0].scored, false);
  assert.equal(Object.hasOwn(normalized.quarantined[0], 'schemaFingerprint'), false);

  assert.equal(normalized.mappings.length, 7);
  assert.equal(normalized.mappings.every(({ primary }) => primary !== null), true);
  assert.equal(normalized.mappings.reduce((count, mapping) => count + mapping.ranked.length, 0), 8);

  const health = normalized.mappings.find(({ capabilityId }) => capabilityId === CAPABILITY.SERVICE_HEALTH_READ);
  assert.equal(health.primary.name, 'probe_service');
  assert.deepEqual(health.alternatives.map(({ name }) => name), ['inspect_runtime_window']);

  const primaryInput = buildRecoveryToolInput(CAPABILITY.SERVICE_HEALTH_READ, health.primary.tool.inputSchema, {
    serviceId: 'checkout',
    windowMinutes: 30,
  });
  await assert.rejects(
    () => client.execute(health.primary.tool, primaryInput),
    (error) => error.code === 'SIGNALS_WINDOW_UNAVAILABLE',
  );

  const fallback = health.alternatives[0];
  const fallbackInput = buildRecoveryToolInput(CAPABILITY.SERVICE_HEALTH_READ, fallback.tool.inputSchema, {
    serviceId: 'checkout',
    windowMinutes: 30,
  });
  const fallbackOutput = canonicalizeRecoveryOutput(
    CAPABILITY.SERVICE_HEALTH_READ,
    await client.execute(fallback.tool, fallbackInput),
  );
  assert.equal(fallbackOutput.status, 'degraded');
  assert.equal(fallbackOutput.errorRate, 8.7);
  assert.equal(validateRecoveryOutput(CAPABILITY.SERVICE_HEALTH_READ, fallbackOutput), fallbackOutput);
});

test('adapts canonical arguments into all eight heterogeneous provider schemas', () => {
  const catalog = createRecoveryProviderCatalog();
  const fixtures = [
    {
      name: 'probe_service',
      capabilityId: CAPABILITY.SERVICE_HEALTH_READ,
      canonical: { serviceId: 'checkout', windowMinutes: 30 },
      expected: { service: 'checkout', window_minutes: 30 },
    },
    {
      name: 'inspect_runtime_window',
      capabilityId: CAPABILITY.SERVICE_HEALTH_READ,
      canonical: { serviceId: 'checkout', windowMinutes: 30 },
      expected: { target: 'checkout', lookback: 30 },
    },
    {
      name: 'trace_changes',
      capabilityId: CAPABILITY.RELEASE_HISTORY_READ,
      canonical: { serviceId: 'checkout', limit: 5 },
      expected: { repository: 'checkout', max_results: 5 },
    },
    {
      name: 'list_rollouts',
      capabilityId: CAPABILITY.DEPLOYMENT_HISTORY_READ,
      canonical: { serviceId: 'checkout', environment: 'production', limit: 5 },
      expected: { component: 'checkout', env: 'production', count: 5 },
    },
    {
      name: 'stage_recovery',
      capabilityId: CAPABILITY.RECOVERY_OPTION_PREPARE,
      canonical: { deploymentId: 'deployment-1842', targetReleaseId: 'release-1841', strategy: 'rollback' },
      expected: { rollout_id: 'deployment-1842', rollback_target: 'release-1841', action: 'rollback' },
    },
    {
      name: 'execute_rollback',
      capabilityId: CAPABILITY.RECOVERY_OPTION_APPLY,
      canonical: {
        recoveryOptionId: 'recovery-option-checkout-r3',
        quoteRevision: 'quote-r3',
        idempotencyKey: 'apply-request-1',
      },
      expected: {
        option_id: 'recovery-option-checkout-r3',
        revision: 'quote-r3',
        request_id: 'apply-request-1',
      },
    },
    {
      name: 'read_active_notice',
      capabilityId: CAPABILITY.STATUS_NOTICE_READ,
      canonical: { serviceId: 'checkout' },
      expected: { product: 'checkout' },
    },
    {
      name: 'publish_update',
      capabilityId: CAPABILITY.STATUS_NOTICE_PUBLISH,
      canonical: {
        noticeId: 'notice-checkout',
        noticeRevision: 'notice-r8',
        title: 'Checkout restored',
        body: 'Checkout has recovered.',
        idempotencyKey: 'publish-request-1',
      },
      expected: {
        incident_id: 'notice-checkout',
        version: 'notice-r8',
        headline: 'Checkout restored',
        content: 'Checkout has recovered.',
        request_id: 'publish-request-1',
      },
    },
  ];

  for (const fixture of fixtures) {
    const { tool } = locateTool(catalog, fixture.name);
    assert.deepEqual(
      buildRecoveryToolInput(fixture.capabilityId, tool.inputSchema, fixture.canonical),
      fixture.expected,
      fixture.name,
    );
  }

  const stage = locateTool(catalog, 'stage_recovery').tool;
  assert.throws(
    () => buildRecoveryToolInput(CAPABILITY.RECOVERY_OPTION_PREPARE, stage.inputSchema, {
      deploymentId: 'deployment-1842',
      targetReleaseId: 'release-1841',
      strategy: 'restart',
    }),
    (error) => error.code === 'RECOVERY_INPUT_VALUE' && error.details.field === 'action',
  );
  assert.throws(
    () => buildRecoveryToolInput(CAPABILITY.SERVICE_HEALTH_READ, JSON.stringify({
      type: 'object',
      properties: [],
      required: ['service'],
    }), { serviceId: 'checkout' }),
    (error) => error.code === 'RECOVERY_SCHEMA_INVALID',
  );
});

test('canonicalizes and validates every recovery capability output', async () => {
  const catalog = createRecoveryProviderCatalog({ now: FIXED_NOW, failPrimaryHealth: false });

  assert.deepEqual(await executeCanonical(catalog, 'probe_service', CAPABILITY.SERVICE_HEALTH_READ, {
    serviceId: 'checkout',
    windowMinutes: 30,
  }), {
    status: 'degraded',
    impact: 'Checkout failures affect 8.7% of payment attempts.',
    errorRate: 8.7,
    startedAt: '2026-08-27T10:31:43.000Z',
    observedAt: '2026-08-27T12:00:00.000Z',
  });

  assert.deepEqual(await executeCanonical(catalog, 'inspect_runtime_window', CAPABILITY.SERVICE_HEALTH_READ, {
    serviceId: 'checkout',
    windowMinutes: 30,
  }), {
    status: 'degraded',
    impact: 'Checkout failures affect 8.7% of payment attempts.',
    errorRate: 8.7,
    startedAt: '2026-08-27T10:31:43.000Z',
    observedAt: '2026-08-27T12:00:00.000Z',
  });

  assert.deepEqual(await executeCanonical(catalog, 'trace_changes', CAPABILITY.RELEASE_HISTORY_READ, {
    serviceId: 'checkout',
    limit: 5,
  }), {
    releases: [
      {
        releaseId: 'release-1842',
        summary: 'Reduced payment authorization timeout from 12 seconds to 4 seconds.',
        releasedAt: '2026-08-27T10:29:00.000Z',
        author: 'release-automation',
      },
      {
        releaseId: 'release-1841',
        summary: 'Stable checkout baseline before retry timing change.',
        releasedAt: '2026-08-26T16:10:00.000Z',
        author: 'release-automation',
      },
    ],
  });

  assert.deepEqual(await executeCanonical(catalog, 'list_rollouts', CAPABILITY.DEPLOYMENT_HISTORY_READ, {
    serviceId: 'checkout',
    environment: 'production',
    limit: 5,
  }), {
    deployments: [{
      deploymentId: 'deployment-1842',
      releaseId: 'release-1842',
      status: 'active',
      deployedAt: '2026-08-27T10:31:00.000Z',
      previousReleaseId: 'release-1841',
    }],
  });

  assert.deepEqual(await executeCanonical(catalog, 'stage_recovery', CAPABILITY.RECOVERY_OPTION_PREPARE, {
    deploymentId: 'deployment-1842',
    targetReleaseId: 'release-1841',
    strategy: 'rollback',
  }), {
    recoveryOptionId: 'recovery-option-checkout-r3',
    quoteRevision: 'quote-r3',
    targetReleaseId: 'release-1841',
    expiresAt: '2026-08-27T21:00:00.000Z',
    effectSummary: 'Restore checkout from release-1842 to stable release-1841.',
    preconditions: { expectedActiveReleaseId: 'release-1842', databaseMigration: 'none' },
  });

  assert.deepEqual(await executeCanonical(catalog, 'read_active_notice', CAPABILITY.STATUS_NOTICE_READ, {
    serviceId: 'checkout',
  }), {
    noticeId: 'notice-checkout',
    title: 'Checkout availability',
    body: 'Checkout is operating normally.',
    status: 'operational',
    noticeRevision: 'notice-r8',
    updatedAt: '2026-08-27T12:00:00.000Z',
  });

  assert.deepEqual(await executeCanonical(catalog, 'execute_rollback', CAPABILITY.RECOVERY_OPTION_APPLY, {
    recoveryOptionId: 'recovery-option-checkout-r3',
    quoteRevision: 'quote-r3',
    idempotencyKey: 'apply-canonicalization',
  }), {
    operationId: 'RCV-1841',
    status: 'applied',
    appliedAt: '2026-08-27T12:00:00.000Z',
    activeReleaseId: 'release-1841',
  });

  assert.deepEqual(await executeCanonical(catalog, 'publish_update', CAPABILITY.STATUS_NOTICE_PUBLISH, {
    noticeId: 'notice-checkout',
    noticeRevision: 'notice-r8',
    title: 'Checkout restored',
    body: 'Checkout has recovered.',
    idempotencyKey: 'publish-canonicalization',
  }), {
    publicationId: 'NTC-R9',
    status: 'published',
    publishedAt: '2026-08-27T12:00:00.000Z',
    noticeRevision: 'notice-r9',
  });

  assert.throws(
    () => validateRecoveryOutput(CAPABILITY.RECOVERY_OPTION_PREPARE, {
      recoveryOptionId: 'option',
      quoteRevision: 'revision',
      targetReleaseId: 'release',
      expiresAt: 'later',
      effectSummary: 'effect',
      preconditions: [],
    }),
    (error) => error.code === 'RECOVERY_OUTPUT_INVALID',
  );
});

test('both external mutations replay safely and reject idempotency-key collisions', async () => {
  const catalog = createRecoveryProviderCatalog({ now: FIXED_NOW });
  const rollback = locateTool(catalog, 'execute_rollback').tool;
  const publish = locateTool(catalog, 'publish_update').tool;
  const rollbackInput = buildRecoveryToolInput(CAPABILITY.RECOVERY_OPTION_APPLY, rollback.inputSchema, {
    recoveryOptionId: 'recovery-option-checkout-r3',
    quoteRevision: 'quote-r3',
    idempotencyKey: 'apply-idempotent-1',
  });
  const publishInput = buildRecoveryToolInput(CAPABILITY.STATUS_NOTICE_PUBLISH, publish.inputSchema, {
    noticeId: 'notice-checkout',
    noticeRevision: 'notice-r8',
    title: 'Checkout restored',
    body: 'Checkout has recovered.',
    idempotencyKey: 'publish-idempotent-1',
  });

  const firstRollback = await rollback.execute(rollbackInput);
  firstRollback.outcome = 'tampered-by-caller';
  assert.deepEqual(await rollback.execute(rollbackInput), {
    change_id: 'RCV-1841',
    outcome: 'applied',
    completed_at: '2026-08-27T12:00:00.000Z',
    version: 'release-1841',
  });
  await assert.rejects(
    () => rollback.execute({ ...rollbackInput, revision: 'quote-other' }),
    (error) => error.code === 'IDEMPOTENCY_KEY_REUSED',
  );

  const firstPublish = await publish.execute(publishInput);
  firstPublish.outcome = 'tampered-by-caller';
  assert.deepEqual(await publish.execute(publishInput), {
    update_id: 'NTC-R9',
    outcome: 'published',
    created_at: '2026-08-27T12:00:00.000Z',
    version: 'notice-r9',
  });
  await assert.rejects(
    () => publish.execute({ ...publishInput, content: 'Different content under the same request ID.' }),
    (error) => error.code === 'IDEMPOTENCY_KEY_REUSED',
  );

  assert.deepEqual(catalog.snapshot(), {
    activeReleaseId: 'release-1841',
    noticeRevision: 'notice-r9',
    noticeBody: 'Checkout has recovered.',
    appliedRequestCount: 1,
    publishedRequestCount: 1,
  });
});
