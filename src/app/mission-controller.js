import { createApprovalEnvelope, claimApprovalEnvelopeSet, sha256Hex } from '../engine/approval.js';
import { createAuditTrail, verifyAuditChain } from '../engine/audit.js';
import { runPlanUntilBlocked } from '../engine/executor.js';
import { approveNodes } from '../engine/graph.js';
import { fingerprintToolSchema, normalizeDiscoveredTools } from '../engine/normalizer.js';
import { assessToolSecurity } from '../engine/risk.js';
import {
  createInMemoryWebMcpHub,
  createNativeWebMcpClient,
  createTestWebMcpClient,
} from '../engine/webmcp.js';
import {
  buildRecoveryToolInput,
  canonicalizeRecoveryOutput,
  validateRecoveryOutput,
} from '../packs/recovery/adapters.js';
import {
  RECOVERY_CAPABILITIES,
  RECOVERY_CAPABILITY_IDS as CAPABILITY,
} from '../packs/recovery/ontology.js';
import {
  buildRecoveryPlan,
  finalizeRecoveryMutationArguments,
} from '../packs/recovery/plan.js';
import {
  RECOVERY_PROVIDER_DESCRIPTORS,
  createRecoveryProviderCatalog,
  registerRecoveryProviderCatalog,
} from '../providers/recovery/catalog.js';

const DEFAULT_ORCHESTRATOR_ORIGIN = 'https://app.toolbraid.dev';
const APPLY_NODE_ID = 'apply-recovery-option';
const PUBLISH_NODE_ID = 'publish-status-update';
const MUTATION_NODE_BY_SCOPE = Object.freeze({ apply: APPLY_NODE_ID, publish: PUBLISH_NODE_ID });

const DEFAULT_ARGUMENTS = Object.freeze({
  [CAPABILITY.SERVICE_HEALTH_READ]: Object.freeze({ serviceId: 'checkout', windowMinutes: 30 }),
  [CAPABILITY.RELEASE_HISTORY_READ]: Object.freeze({ serviceId: 'checkout', limit: 5 }),
  [CAPABILITY.DEPLOYMENT_HISTORY_READ]: Object.freeze({ serviceId: 'checkout', environment: 'production', limit: 5 }),
  [CAPABILITY.RECOVERY_OPTION_PREPARE]: Object.freeze({}),
  [CAPABILITY.STATUS_NOTICE_READ]: Object.freeze({ serviceId: 'checkout' }),
});

function controllerError(code, message, details = {}) {
  const error = new Error(message);
  error.name = 'MissionControllerError';
  error.code = code;
  error.details = details;
  return error;
}

function canonicalOrigin(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.origin !== value) {
    throw controllerError('ORIGIN_INVALID', `Provider origin must be canonical: ${value}`, { origin: value });
  }
  return url.origin;
}

function toolId(tool) {
  return `tool-${sha256Hex(`${tool.origin}\u0000${tool.name}`).slice(0, 16)}`;
}

function boundedText(value, fallback, limit) {
  if (typeof value !== 'string') return fallback;
  return value.slice(0, limit);
}

function toolDescriptor(tool, { schemaFingerprint = null, quarantined = false } = {}) {
  return Object.freeze({
    id: toolId(tool),
    origin: tool.origin,
    name: tool.name,
    title: quarantined ? tool.name : boundedText(tool.title, tool.name, 160),
    description: quarantined
      ? 'Quarantined before capability scoring.'
      : boundedText(tool.description, '', 512),
    schemaFingerprint,
  });
}

function defaultMissionIdFactory() {
  const id = globalThis.crypto?.randomUUID?.();
  if (!id) throw controllerError('MISSION_ID_UNAVAILABLE', 'A cryptographically random mission ID is required.');
  return `recovery-${id}`;
}

function validateMissionId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{7,127}$/.test(value)) {
    throw controllerError('MISSION_ID_INVALID', 'Mission ID factory returned an invalid identifier.');
  }
  return value;
}

function resultObject(results) {
  return Object.fromEntries([...results.entries()].map(([key, value]) => [key, structuredClone(value)]));
}

function nodeWithoutHandle(node) {
  const candidate = (mapping) => mapping ? {
    capabilityId: mapping.capabilityId,
    origin: mapping.origin,
    name: mapping.name,
    schemaFingerprint: mapping.schemaFingerprint,
    confidence: mapping.confidence,
  } : null;
  return {
    id: node.id,
    title: node.title ?? node.label ?? node.id,
    capabilityId: node.capabilityId ?? null,
    dependencies: [...node.dependencies],
    status: node.status,
    risk: node.riskLabel ?? node.risk ?? null,
    approvalRequired: Boolean(node.approvalRequired),
    argumentsDeferred: Boolean(node.argumentsDeferred),
    arguments: structuredClone(node.arguments ?? {}),
    mapping: candidate(node.candidates?.[0] ?? node.mapping),
    alternatives: (node.alternatives ?? []).map(candidate),
    result: node.result === undefined ? null : structuredClone(node.result),
    error: node.error ?? null,
  };
}

function providerDescriptors(origins) {
  return RECOVERY_PROVIDER_DESCRIPTORS.map((provider, index) => Object.freeze({
    ...provider,
    origin: origins[index],
  }));
}

function correlationOperation({ results }) {
  const health = results.get('read-service-health');
  const releaseHistory = results.get('read-release-history');
  const deploymentHistory = results.get('read-deployment-history');
  const notice = results.get('read-status-notice');
  const activeDeployment = deploymentHistory?.deployments?.find((entry) => entry.status === 'active')
    ?? deploymentHistory?.deployments?.[0];
  const activeRelease = releaseHistory?.releases?.find((entry) => entry.releaseId === activeDeployment?.releaseId);
  if (!health || !activeDeployment || !activeRelease || !notice) {
    throw controllerError('EVIDENCE_INCOMPLETE', 'Recovery correlation requires all four canonical evidence results.');
  }
  return {
    serviceId: 'checkout',
    deploymentId: activeDeployment.deploymentId,
    currentReleaseId: activeDeployment.releaseId,
    targetReleaseId: activeDeployment.previousReleaseId,
    errorRate: health.errorRate,
    impact: health.impact,
    suspectedChange: activeRelease.summary,
    noticeId: notice.noticeId,
    noticeRevision: notice.noticeRevision,
  };
}

function draftOperation({ results }) {
  const evidence = results.get('correlate-evidence');
  if (!evidence) throw controllerError('EVIDENCE_INCOMPLETE', 'Status drafting requires correlated evidence.');
  return {
    title: 'Checkout recovery in progress',
    body: `We identified ${evidence.currentReleaseId} as the likely cause of elevated checkout failures and prepared a safe recovery to ${evidence.targetReleaseId}.`,
    effectSummary: `Publish an incident update referencing the verified recovery from ${evidence.currentReleaseId} to ${evidence.targetReleaseId}.`,
  };
}

function plannedArguments(capabilityId, planned, { results }) {
  if (capabilityId !== CAPABILITY.RECOVERY_OPTION_PREPARE) return planned;
  const evidence = results.get('correlate-evidence');
  if (!evidence) throw controllerError('EVIDENCE_INCOMPLETE', 'Recovery preparation requires correlated evidence.');
  return {
    deploymentId: evidence.deploymentId,
    targetReleaseId: evidence.targetReleaseId,
    strategy: 'rollback',
    reason: `Checkout error rate ${evidence.errorRate}% after ${evidence.currentReleaseId}.`,
  };
}

function bindingForNode(plan, node, canonicalArguments) {
  const selected = node.candidates?.[0] ?? node.mapping;
  return {
    planId: plan.id,
    planRevision: plan.revision,
    nodeId: node.id,
    toolOrigin: selected.origin,
    toolName: selected.name,
    toolSchemaFingerprint: selected.schemaFingerprint,
    canonicalCapability: node.capabilityId,
    normalizedArguments: structuredClone(canonicalArguments ?? node.arguments),
    effectSummary: node.effectSummary,
    risk: node.riskLabel ?? node.risk,
  };
}

export function createMissionController({
  documentRef = globalThis.document,
  providerOrigins = RECOVERY_PROVIDER_DESCRIPTORS.map(({ origin }) => origin),
  orchestratorOrigin = documentRef?.location?.origin && documentRef.location.origin !== 'null'
    ? documentRef.location.origin
    : DEFAULT_ORCHESTRATOR_ORIGIN,
  runtimePolicy = 'auto',
  allowTestRuntime = true,
  now = () => new Date(),
  missionIdFactory = defaultMissionIdFactory,
  catalogFactory = createRecoveryProviderCatalog,
} = {}) {
  if (typeof missionIdFactory !== 'function') throw new TypeError('missionIdFactory must be a function.');
  if (typeof catalogFactory !== 'function') throw new TypeError('catalogFactory must be a function.');
  const allowedOrigins = Object.freeze(providerOrigins.map(canonicalOrigin));
  const listeners = new Set();
  let auditTrail = createAuditTrail({ now });
  let client = null;
  let mode = 'uninitialized';
  let catalog = null;
  let normalization = null;
  let discoveredTools = [];
  let discoveredToolDescriptors = [];
  let plan = null;
  let results = new Map();
  let approvals = new Map();
  let plannedGeneration = null;
  let invalidated = false;
  let unsubscribeToolChanges = null;
  let seal = null;
  let activeOperation = null;
  let activeAbortController = null;

  const notify = (event, details, entry) => {
    for (const listener of listeners) listener(Object.freeze({ event, details: structuredClone(details), entry }));
  };
  const record = (event, details = {}) => {
    const entry = auditTrail.append(event, details);
    notify(event, details, entry);
    return entry;
  };

  async function runExclusive(name, operation) {
    if (activeOperation) {
      throw controllerError('MISSION_BUSY', `Cannot start ${name} while ${activeOperation} is still running.`, {
        requestedOperation: name,
        activeOperation,
      });
    }
    const controller = new AbortController();
    activeOperation = name;
    activeAbortController = controller;
    try {
      return await operation(controller.signal);
    } finally {
      if (activeAbortController === controller) activeAbortController = null;
      activeOperation = null;
    }
  }

  async function initialize() {
    if (client) return client;
    const nativeAvailable = Boolean(
      documentRef?.modelContext?.registerTool
      && documentRef.modelContext?.getTools
      && documentRef.modelContext?.executeTool,
    );
    if (runtimePolicy === 'native' || (runtimePolicy === 'auto' && nativeAvailable)) {
      if (!nativeAvailable) {
        throw controllerError('WEBMCP_UNSUPPORTED', 'Native WebMCP is required by this runtime policy.');
      }
      client = createNativeWebMcpClient({ documentRef, allowedOrigins });
      mode = 'native';
    } else {
      if (!allowTestRuntime || runtimePolicy === 'native') {
        throw controllerError('WEBMCP_UNSUPPORTED', 'WebMCP is unavailable and the local verification runtime is disabled.');
      }
      const hub = createInMemoryWebMcpHub();
      const context = hub.createContext(orchestratorOrigin);
      catalog = catalogFactory({ now });
      await registerRecoveryProviderCatalog({ hub, orchestratorOrigin, catalog });
      client = createTestWebMcpClient({ context, allowedOrigins });
      mode = 'test';
    }
    unsubscribeToolChanges = client.subscribe(({ generation }) => {
      if (!plan || plannedGeneration === null) return;
      invalidated = true;
      if (!auditTrail.sealed) record('registry.toolchange', { generation, plannedGeneration });
      activeAbortController?.abort(controllerError('PLAN_INVALIDATED', 'The live WebMCP registry changed during execution.', {
        generation,
        plannedGeneration,
      }));
    });
    record('runtime.ready', { mode, allowedOrigins });
    return client;
  }

  function assertPlanCurrent() {
    if (!plan) throw controllerError('PLAN_MISSING', 'Discover and normalize providers before continuing.');
    if (invalidated || client.generation !== plannedGeneration) {
      throw controllerError('PLAN_INVALIDATED', 'The live WebMCP registry changed after planning.', {
        plannedGeneration,
        currentGeneration: client.generation,
      });
    }
  }

  async function refreshMutationHandle(node) {
    assertPlanCurrent();
    const expectedGeneration = plannedGeneration;
    const selected = node.mapping;
    const freshTools = await client.discover();
    if (invalidated || client.generation !== expectedGeneration) assertPlanCurrent();
    const fresh = freshTools.find((tool) => tool.origin === selected.origin && tool.name === selected.name);
    if (!fresh) {
      throw controllerError('APPROVED_TOOL_MISSING', `Approved tool is no longer registered: ${selected.origin} ${selected.name}`);
    }
    const security = assessToolSecurity(fresh);
    if (security.allowedForScoring === false || security.metadata.quarantined) {
      record('approved_tool.quarantined', {
        nodeId: node.id,
        origin: selected.origin,
        name: selected.name,
        reasonCode: security.metadata.reasonCode,
        evidence: security.metadata.evidence,
      });
      throw controllerError('APPROVED_TOOL_QUARANTINED', 'Approved tool metadata failed the final security scan.', {
        origin: selected.origin,
        name: selected.name,
        reasonCode: security.metadata.reasonCode,
      });
    }
    const schemaFingerprint = fingerprintToolSchema(fresh);
    if (schemaFingerprint !== selected.schemaFingerprint) {
      throw controllerError('APPROVED_TOOL_SCHEMA_CHANGED', 'Approved tool schema changed before execution.', {
        origin: selected.origin,
        name: selected.name,
        approved: selected.schemaFingerprint,
        current: schemaFingerprint,
      });
    }
    node.candidates = [{ ...selected, tool: fresh }];
    assertPlanCurrent();
    return node.candidates[0];
  }

  const services = (signal) => ({
    runtime: client,
    results,
    signal,
    localOperations: {
      'recovery.evidence.correlate': correlationOperation,
      'status.notice.draft': draftOperation,
    },
    resolveArguments: plannedArguments,
    adaptInput(capabilityId, canonicalArguments, { tool }) {
      return buildRecoveryToolInput(capabilityId, tool.inputSchema, canonicalArguments);
    },
    adaptOutput: canonicalizeRecoveryOutput,
    validateOutput: validateRecoveryOutput,
    onAudit(event, details) {
      record(event, details);
    },
  });

  async function discoverAndPlan(objective) {
    await initialize();
    if (plan) throw controllerError('MISSION_ALREADY_STARTED', 'Reset before starting another mission.');
    record('mission.started', { objective });
    discoveredTools = await client.discover();
    normalization = normalizeDiscoveredTools({
      tools: discoveredTools,
      capabilityPack: RECOVERY_CAPABILITIES,
      minimumConfidence: 0.45,
      ambiguityMargin: 0.04,
    });
    const fingerprints = new Map();
    for (const item of normalization.accepted) fingerprints.set(item.tool, item.schemaFingerprint);
    for (const item of normalization.rejected) fingerprints.set(item.tool, item.schemaFingerprint ?? null);
    const quarantinedTools = new Set(normalization.quarantined.map(({ tool }) => tool));
    discoveredToolDescriptors = discoveredTools.map((tool) => toolDescriptor(tool, {
      schemaFingerprint: fingerprints.get(tool) ?? null,
      quarantined: quarantinedTools.has(tool),
    }));
    for (const descriptor of discoveredToolDescriptors) record('tool.discovered', descriptor);
    for (const item of normalization.quarantined) {
      record('tool.quarantined', {
        toolId: toolId(item.tool),
        origin: item.identity.origin,
        name: item.identity.name,
        reasonCode: item.security.metadata?.reasonCode ?? item.security.reasonCode ?? 'TOOL_METADATA_QUARANTINED',
        evidence: item.security.metadata?.evidence ?? item.security.evidence ?? [],
      });
    }
    const missing = normalization.mappings.filter(({ primary }) => !primary).map(({ capabilityId }) => capabilityId);
    if (missing.length) {
      throw controllerError('CAPABILITY_MAPPING_MISSING', `Required capabilities were not mapped: ${missing.join(', ')}`, { missing });
    }
    for (const mapping of normalization.mappings) {
      record('capability.mapped', {
        capabilityId: mapping.capabilityId,
        primary: { origin: mapping.primary.origin, name: mapping.primary.name, confidence: mapping.primary.confidence },
        alternatives: mapping.alternatives.map(({ origin, name, confidence }) => ({ origin, name, confidence })),
      });
    }
    const missionId = validateMissionId(missionIdFactory());
    plan = buildRecoveryPlan({
      id: missionId,
      objective,
      mappings: normalization.mappings,
      argumentsByCapability: DEFAULT_ARGUMENTS,
      deferMutationArguments: true,
      metadata: { runtimeMode: mode, discoveryGeneration: client.generation },
      now: now(),
    });
    plannedGeneration = client.generation;
    record('plan.created', {
      planId: plan.id,
      revision: plan.revision,
      nodeCount: plan.nodes.length,
      mutationArgumentsDeferred: true,
    });
    return snapshot();
  }

  async function runSafe(signal) {
    assertPlanCurrent();
    const outcome = await runPlanUntilBlocked(plan, services(signal));
    results = outcome.results;
    if (outcome.status !== 'approval_required') {
      throw controllerError('SAFE_EXECUTION_INCOMPLETE', `Safe execution stopped in unexpected state: ${outcome.status}`);
    }
    finalizeRecoveryMutationArguments(plan, { results });
    record('plan.mutations_finalized', {
      planId: plan.id,
      revision: plan.revision,
      nodeIds: [APPLY_NODE_ID, PUBLISH_NODE_ID],
      argumentFingerprints: Object.fromEntries([APPLY_NODE_ID, PUBLISH_NODE_ID].map((nodeId) => {
        const node = plan.nodes.find((candidate) => candidate.id === nodeId);
        return [nodeId, sha256Hex(node.arguments)];
      })),
    });
    return snapshot();
  }

  async function approve(scope) {
    assertPlanCurrent();
    if (!Object.hasOwn(MUTATION_NODE_BY_SCOPE, scope)) throw controllerError('APPROVAL_SCOPE_INVALID', `Unknown scope: ${scope}`);
    if (!plan.metadata.mutationArgumentsFinalized) {
      throw controllerError('APPROVAL_NOT_READY', 'Exact mutation arguments must be finalized before approval.');
    }
    const node = plan.nodes.find((candidate) => candidate.id === MUTATION_NODE_BY_SCOPE[scope]);
    await refreshMutationHandle(node);
    const binding = bindingForNode(plan, node, node.arguments);
    const envelope = createApprovalEnvelope(binding, { now: now() });
    approvals.set(node.id, envelope);
    approveNodes(plan, [node.id]);
    record('approval.created', {
      scope,
      nodeId: node.id,
      origin: envelope.toolOrigin,
      tool: envelope.toolName,
      fingerprint: envelope.fingerprint,
      argumentFingerprint: sha256Hex(envelope.normalizedArguments),
      expiresAt: envelope.expiresAt,
    });
    return { envelope: structuredClone(envelope), snapshot: snapshot() };
  }

  async function executeApproved(signal) {
    assertPlanCurrent();
    if (seal) throw controllerError('APPROVAL_REPLAY_BLOCKED', 'The approved mutation set has already been consumed.');
    const mutationNodes = [APPLY_NODE_ID, PUBLISH_NODE_ID].map((nodeId) => plan.nodes.find((node) => node.id === nodeId));
    if (mutationNodes.some((node) => !approvals.has(node.id))) {
      throw controllerError('APPROVAL_REQUIRED', 'Both exact mutation scopes require human approval.');
    }
    for (const node of mutationNodes) await refreshMutationHandle(node);
    assertPlanCurrent();

    const preauthorized = mutationNodes.map((node) => {
      const candidate = node.candidates[0];
      const canonicalArguments = structuredClone(node.arguments);
      const nativeArguments = buildRecoveryToolInput(node.capabilityId, candidate.tool.inputSchema, canonicalArguments);
      return {
        node,
        candidate,
        canonicalArguments,
        nativeArguments,
        expected: bindingForNode(plan, { ...node, candidates: [candidate] }, canonicalArguments),
      };
    });
    assertPlanCurrent();
    const claimReceipts = claimApprovalEnvelopeSet(
      preauthorized.map(({ node, expected }) => ({ envelope: approvals.get(node.id), expected })),
      { now: now() },
    );
    const authorizationByNode = new Map(preauthorized.map((authorization, index) => [
      authorization.node.id,
      { ...authorization, receipt: claimReceipts[index] },
    ]));
    for (const authorization of authorizationByNode.values()) {
      record('approval.claimed', {
        nodeId: authorization.node.id,
        nonce: authorization.receipt.nonce,
        fingerprint: authorization.receipt.fingerprint,
        canonicalArguments: authorization.canonicalArguments,
        nativeArguments: authorization.nativeArguments,
      });
    }

    const executionServices = {
      ...services(signal),
      authorizeMutation({ node, candidate, canonicalArguments, nativeArguments }) {
        assertPlanCurrent();
        const authorization = authorizationByNode.get(node.id);
        if (!authorization
            || authorization.candidate !== candidate
            || sha256Hex(authorization.canonicalArguments) !== sha256Hex(canonicalArguments)
            || sha256Hex(authorization.nativeArguments) !== sha256Hex(nativeArguments)) {
          throw controllerError('APPROVED_EXECUTION_DRIFT', 'Mutation execution drifted from its claimed approval set.', {
            nodeId: node.id,
          });
        }
        return authorization.receipt;
      },
      assertExecutionCurrent({ node, candidate, canonicalArguments, nativeArguments }) {
        assertPlanCurrent();
        const authorization = authorizationByNode.get(node.id);
        if (!authorization
            || authorization.candidate !== candidate
            || sha256Hex(authorization.canonicalArguments) !== sha256Hex(canonicalArguments)
            || sha256Hex(authorization.nativeArguments) !== sha256Hex(nativeArguments)) {
          throw controllerError('APPROVED_EXECUTION_DRIFT', 'Final mutation context no longer matches its claimed approval.', {
            nodeId: node.id,
          });
        }
      },
    };
    try {
      const outcome = await runPlanUntilBlocked(plan, executionServices, { includeApprovedMutations: true });
      results = outcome.results;
      if (!outcome.complete) throw controllerError('MUTATION_EXECUTION_INCOMPLETE', `Approved execution ended in ${outcome.status}.`);
      record('mission.completed', {
        planId: plan.id,
        revision: plan.revision,
        resultNodeIds: mutationNodes.map(({ id }) => id),
      });
      seal = auditTrail.seal();
      return snapshot();
    } catch (error) {
      plan.status = 'failed';
      record('mission.execution_failed', {
        planId: plan.id,
        revision: plan.revision,
        code: error?.code ?? null,
        error: error instanceof Error ? error.message : String(error),
        completedMutationNodeIds: mutationNodes
          .filter(({ status }) => status === 'completed')
          .map(({ id }) => id),
        failedMutationNodeIds: mutationNodes
          .filter(({ status }) => status === 'failed')
          .map(({ id }) => id),
      });
      seal = auditTrail.seal();
      const failedSnapshot = snapshot();
      const failure = error instanceof Error
        ? error
        : controllerError('MUTATION_EXECUTION_FAILED', String(error));
      Object.defineProperty(failure, 'snapshot', { value: failedSnapshot, enumerable: false });
      throw failure;
    }
  }

  function snapshot() {
    const auditEntries = auditTrail.entries();
    return Object.freeze({
      mode,
      providerDescriptors: providerDescriptors(allowedOrigins),
      discoveredTools: discoveredToolDescriptors.map((descriptor) => structuredClone(descriptor)),
      normalization: normalization ? {
        stats: structuredClone(normalization.stats),
        mappings: normalization.mappings.map((mapping) => ({
          capabilityId: mapping.capabilityId,
          primaryToolId: mapping.primary ? toolId(mapping.primary.tool) : null,
          alternativeToolIds: mapping.alternatives.map((candidate) => toolId(candidate.tool)),
          confidence: mapping.primary?.confidence ?? null,
        })),
        quarantined: normalization.quarantined.map((item) => ({
          toolId: toolId(item.tool),
          origin: item.identity.origin,
          name: item.identity.name,
        })),
      } : null,
      plan: plan ? {
        id: plan.id,
        revision: plan.revision,
        status: plan.status,
        mutationArgumentsFinalized: Boolean(plan.metadata.mutationArgumentsFinalized),
        nodes: plan.nodes.map(nodeWithoutHandle),
      } : null,
      results: resultObject(results),
      approvals: Object.fromEntries([...approvals].map(([nodeId, envelope]) => [nodeId, {
        fingerprint: envelope.fingerprint,
        expiresAt: envelope.expiresAt,
      }])),
      audit: auditEntries,
      auditVerified: verifyAuditChain(auditEntries),
      seal: seal ? structuredClone(seal) : null,
      invalidated,
      providerState: catalog?.snapshot?.() ?? null,
    });
  }

  async function reset() {
    if (activeOperation) {
      throw controllerError('MISSION_BUSY', `Cannot reset while ${activeOperation} is still running.`, {
        activeOperation,
      });
    }
    unsubscribeToolChanges?.();
    client?.close?.();
    auditTrail = createAuditTrail({ now });
    client = null;
    mode = 'uninitialized';
    catalog = null;
    normalization = null;
    discoveredTools = [];
    discoveredToolDescriptors = [];
    plan = null;
    results = new Map();
    approvals = new Map();
    plannedGeneration = null;
    invalidated = false;
    unsubscribeToolChanges = null;
    seal = null;
  }

  function dispose() {
    activeAbortController?.abort(controllerError('MISSION_DISPOSED', 'Mission controller was disposed.'));
    unsubscribeToolChanges?.();
    client?.close?.();
    unsubscribeToolChanges = null;
  }

  return Object.freeze({
    initialize: () => runExclusive('initialize', () => initialize()),
    discoverAndPlan: (objective) => runExclusive('discoverAndPlan', () => discoverAndPlan(objective)),
    runSafe: () => runExclusive('runSafe', (signal) => runSafe(signal)),
    approve: (scope) => runExclusive(`approve:${scope}`, () => approve(scope)),
    executeApproved: () => runExclusive('executeApproved', (signal) => executeApproved(signal)),
    reset,
    dispose,
    snapshot,
    subscribe(listener) {
      if (typeof listener !== 'function') throw new TypeError('Mission listener must be a function.');
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    get mode() {
      return mode;
    },
  });
}
