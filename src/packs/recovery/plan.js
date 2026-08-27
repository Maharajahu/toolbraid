import { createPlan } from '../../engine/graph.js';
import { stableStringify } from '../../engine/approval.js';
import {
  RECOVERY_CAPABILITIES,
  RECOVERY_CAPABILITY_IDS as CAPABILITY,
  RECOVERY_ONTOLOGY,
  getRecoveryCapability,
} from './ontology.js';

const DEFAULT_OBJECTIVE = 'Restore the affected service safely and prepare an accurate customer update.';
const RECOVERY_MUTATION_CAPABILITIES = new Set([
  CAPABILITY.RECOVERY_OPTION_APPLY,
  CAPABILITY.STATUS_NOTICE_PUBLISH,
]);
const RECOVERY_SAFE_STAGE_NODE_IDS = Object.freeze([
  'read-service-health',
  'read-release-history',
  'read-deployment-history',
  'read-status-notice',
  'correlate-evidence',
  'prepare-recovery-option',
  'draft-status-update',
]);
const RECOVERY_MUTATION_NODE_IDS = Object.freeze({
  [CAPABILITY.RECOVERY_OPTION_APPLY]: 'apply-recovery-option',
  [CAPABILITY.STATUS_NOTICE_PUBLISH]: 'publish-status-update',
});

function recoveryPlanError(code, message, details = {}) {
  const error = new Error(message);
  error.name = 'RecoveryPlanError';
  error.code = code;
  error.details = details;
  return error;
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function cloneJson(value, label) {
  if (!isPlainObject(value)) {
    throw recoveryPlanError('RECOVERY_ARGUMENTS_INVALID', `${label} must be a JSON object.`, { label });
  }
  try {
    return JSON.parse(stableStringify(value));
  } catch (cause) {
    if (cause?.code) throw cause;
    throw recoveryPlanError('RECOVERY_ARGUMENTS_INVALID', `${label} must contain JSON-compatible data.`, {
      label,
      cause: String(cause),
    });
  }
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function valueFor(collection, key) {
  if (collection instanceof Map) return collection.get(key);
  if (Array.isArray(collection)) return collection.find((entry) => entry?.capabilityId === key);
  return collection?.[key];
}

function mappingIdentity(rawMapping, capabilityId) {
  if (!rawMapping) {
    throw recoveryPlanError('RECOVERY_MAPPING_MISSING', `No eligible mapping exists for ${capabilityId}.`, { capabilityId });
  }
  const selected = rawMapping.primary ?? rawMapping;
  if (!selected) {
    throw recoveryPlanError('RECOVERY_MAPPING_MISSING', `No eligible mapping exists for ${capabilityId}.`, { capabilityId });
  }
  if (selected.quarantined === true
      || selected.allowedForScoring === false
      || selected.security?.quarantined === true
      || selected.security?.metadata?.quarantined === true) {
    throw recoveryPlanError('RECOVERY_MAPPING_QUARANTINED', `The mapping for ${capabilityId} is quarantined.`, { capabilityId });
  }
  if (rawMapping.capabilityId && rawMapping.capabilityId !== capabilityId) {
    throw recoveryPlanError('RECOVERY_MAPPING_INVALID', `Mapping capability does not match ${capabilityId}.`, {
      capabilityId,
      mappedCapabilityId: rawMapping.capabilityId,
    });
  }

  const tool = selected.tool ?? selected.registeredTool ?? selected;
  const toolOrigin = selected.toolOrigin ?? selected.origin ?? selected.identity?.origin ?? tool.origin;
  const toolName = selected.toolName ?? selected.name ?? selected.identity?.name ?? tool.name;
  const toolSchemaFingerprint = selected.toolSchemaFingerprint
    ?? selected.schemaFingerprint
    ?? tool.toolSchemaFingerprint
    ?? tool.schemaFingerprint;

  let canonicalOrigin = null;
  try {
    canonicalOrigin = typeof toolOrigin === 'string' ? new URL(toolOrigin).origin : null;
  } catch {
    canonicalOrigin = null;
  }
  if (canonicalOrigin !== toolOrigin) {
    throw recoveryPlanError('RECOVERY_MAPPING_INVALID', `Mapping ${capabilityId} has no canonical tool origin.`, { capabilityId });
  }
  if (typeof toolName !== 'string' || toolName.trim() === '') {
    throw recoveryPlanError('RECOVERY_MAPPING_INVALID', `Mapping ${capabilityId} has no tool name.`, { capabilityId });
  }
  if (typeof toolSchemaFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(toolSchemaFingerprint)) {
    throw recoveryPlanError('RECOVERY_MAPPING_INVALID', `Mapping ${capabilityId} has no valid schema fingerprint.`, { capabilityId });
  }

  const descriptor = {
    capabilityId,
    origin: toolOrigin,
    name: toolName,
    schemaFingerprint: toolSchemaFingerprint,
    toolOrigin,
    toolName,
    toolSchemaFingerprint,
    registrationGeneration: selected.registrationGeneration ?? selected.generation ?? null,
    confidence: selected.confidence ?? null,
    evidence: selected.evidence ? structuredClone(selected.evidence) : [],
  };
  const hasLiveTool = selected.tool && typeof selected.tool === 'object';
  return { descriptor, liveTool: hasLiveTool ? selected.tool : null };
}

function requireMappings(mappings) {
  if (!mappings) {
    throw recoveryPlanError('RECOVERY_MAPPING_MISSING', 'Recovery planning requires canonical capability mappings.');
  }
  return Object.fromEntries(RECOVERY_CAPABILITIES.map(({ id }) => {
    const raw = valueFor(mappings, id);
    if (!raw) return [id, mappingIdentity(raw, id)];
    const primary = mappingIdentity(raw, id);
    const alternatives = (raw.alternatives ?? [])
      .map((candidate) => mappingIdentity({ ...candidate, capabilityId: id }, id));
    return [id, { primary, alternatives }];
  }));
}

function exactArguments(argumentsByCapability, capabilityId, { required = false } = {}) {
  const value = valueFor(argumentsByCapability, capabilityId);
  if (value === undefined) {
    if (required) {
      throw recoveryPlanError('RECOVERY_ARGUMENTS_MISSING', `Exact pre-approval arguments are required for ${capabilityId}.`, {
        capabilityId,
      });
    }
    return {};
  }
  return cloneJson(value, `${capabilityId} arguments`);
}

function requireArgument(argumentsObject, capabilityId, field) {
  if (typeof argumentsObject[field] !== 'string' || argumentsObject[field].trim() === '') {
    throw recoveryPlanError('RECOVERY_ARGUMENTS_INCOMPLETE', `${capabilityId} requires exact ${field} before approval.`, {
      capabilityId,
      field,
    });
  }
}

function validateMutationArguments(applyArguments, publishArguments) {
  for (const field of ['recoveryOptionId', 'quoteRevision', 'idempotencyKey']) {
    requireArgument(applyArguments, CAPABILITY.RECOVERY_OPTION_APPLY, field);
  }
  for (const field of ['noticeId', 'noticeRevision', 'body', 'idempotencyKey']) {
    requireArgument(publishArguments, CAPABILITY.STATUS_NOTICE_PUBLISH, field);
  }
}

function toolNode({
  id,
  capabilityId,
  dependencies,
  mapping,
  args,
  explanation,
  effectSummary = null,
  argumentsDeferred = false,
}) {
  const definition = getRecoveryCapability(capabilityId);
  return {
    id,
    type: 'tool',
    kind: 'tool',
    title: definition.title,
    capabilityId,
    dependencies,
    mapping: mapping.primary.descriptor,
    alternatives: mapping.alternatives.map((candidate) => candidate.descriptor),
    arguments: args,
    risk: definition.policy.minimumRisk,
    riskLabel: definition.policy.externalMutation ? 'external-mutation' : definition.policy.minimumRisk === 0 ? 'read-only' : 'reversible-preparation',
    approvalRequired: definition.policy.approvalRequired,
    argumentsDeferred,
    effectSummary,
    explanation,
  };
}

function localNode({ id, title, operation, dependencies, explanation }) {
  return {
    id,
    type: 'local',
    kind: 'local',
    title,
    operation,
    dependencies,
    arguments: {},
    risk: 0,
    riskLabel: 'read-only',
    approvalRequired: false,
    explanation,
  };
}

function freezeMutationArguments(plan) {
  for (const node of plan.nodes) {
    if (!node.approvalRequired) continue;
    deepFreeze(node.arguments);
  }
  return plan;
}

function attachLiveToolHandles(plan, resolvedMappings) {
  for (const node of plan.nodes) {
    if (node.type !== 'tool') continue;
    const resolved = resolvedMappings[node.capabilityId];
    const candidates = [resolved.primary, ...resolved.alternatives];
    const plannedCandidates = [node.mapping, ...(node.alternatives ?? [])];
    for (let index = 0; index < candidates.length; index += 1) {
      if (!candidates[index].liveTool) continue;
      Object.defineProperty(plannedCandidates[index], 'tool', {
        value: candidates[index].liveTool,
        configurable: false,
        enumerable: false,
        writable: false,
      });
    }
  }
  return plan;
}

export function buildRecoveryPlan({
  id = 'production-recovery-plan',
  objective = DEFAULT_OBJECTIVE,
  mappings,
  argumentsByCapability = {},
  effectSummaries = {},
  metadata = {},
  deferMutationArguments = false,
  now = new Date(),
} = {}) {
  if (typeof deferMutationArguments !== 'boolean') {
    throw recoveryPlanError(
      'RECOVERY_OPTION_INVALID',
      'deferMutationArguments must be a boolean.',
      { option: 'deferMutationArguments' },
    );
  }
  const resolvedMappings = requireMappings(mappings);
  const args = Object.fromEntries(RECOVERY_CAPABILITIES.map(({ id: capabilityId }) => [
    capabilityId,
    deferMutationArguments && RECOVERY_MUTATION_CAPABILITIES.has(capabilityId)
      ? {}
      : exactArguments(argumentsByCapability, capabilityId, {
        required: RECOVERY_MUTATION_CAPABILITIES.has(capabilityId),
      }),
  ]));
  if (!deferMutationArguments) {
    validateMutationArguments(args[CAPABILITY.RECOVERY_OPTION_APPLY], args[CAPABILITY.STATUS_NOTICE_PUBLISH]);
  }

  const nodes = [
    toolNode({
      id: 'read-service-health',
      capabilityId: CAPABILITY.SERVICE_HEALTH_READ,
      dependencies: [],
      mapping: resolvedMappings[CAPABILITY.SERVICE_HEALTH_READ],
      args: args[CAPABILITY.SERVICE_HEALTH_READ],
      explanation: 'Collect current impact independently so it can run in the first parallel evidence batch.',
    }),
    toolNode({
      id: 'read-release-history',
      capabilityId: CAPABILITY.RELEASE_HISTORY_READ,
      dependencies: [],
      mapping: resolvedMappings[CAPABILITY.RELEASE_HISTORY_READ],
      args: args[CAPABILITY.RELEASE_HISTORY_READ],
      explanation: 'Collect recent change evidence independently from deployment and health providers.',
    }),
    toolNode({
      id: 'read-deployment-history',
      capabilityId: CAPABILITY.DEPLOYMENT_HISTORY_READ,
      dependencies: [],
      mapping: resolvedMappings[CAPABILITY.DEPLOYMENT_HISTORY_READ],
      args: args[CAPABILITY.DEPLOYMENT_HISTORY_READ],
      explanation: 'Collect the rollout timeline independently for later evidence correlation.',
    }),
    toolNode({
      id: 'read-status-notice',
      capabilityId: CAPABILITY.STATUS_NOTICE_READ,
      dependencies: [],
      mapping: resolvedMappings[CAPABILITY.STATUS_NOTICE_READ],
      args: args[CAPABILITY.STATUS_NOTICE_READ],
      explanation: 'Read the current public message in parallel without changing customer-visible state.',
    }),
    localNode({
      id: 'correlate-evidence',
      title: 'Correlate incident evidence',
      operation: 'recovery.evidence.correlate',
      dependencies: ['read-service-health', 'read-release-history', 'read-deployment-history', 'read-status-notice'],
      explanation: 'Join health, release, deployment, and notice evidence before recommending any action.',
    }),
    toolNode({
      id: 'prepare-recovery-option',
      capabilityId: CAPABILITY.RECOVERY_OPTION_PREPARE,
      dependencies: ['correlate-evidence'],
      mapping: resolvedMappings[CAPABILITY.RECOVERY_OPTION_PREPARE],
      args: args[CAPABILITY.RECOVERY_OPTION_PREPARE],
      explanation: 'Prepare a reversible recovery quote; this node cannot apply it to production.',
    }),
    localNode({
      id: 'draft-status-update',
      title: 'Draft customer update',
      operation: 'status.notice.draft',
      dependencies: ['correlate-evidence'],
      explanation: 'Draft communication from the same correlated evidence without publishing it.',
    }),
    toolNode({
      id: 'apply-recovery-option',
      capabilityId: CAPABILITY.RECOVERY_OPTION_APPLY,
      dependencies: ['prepare-recovery-option'],
      mapping: resolvedMappings[CAPABILITY.RECOVERY_OPTION_APPLY],
      args: args[CAPABILITY.RECOVERY_OPTION_APPLY],
      argumentsDeferred: deferMutationArguments,
      effectSummary: effectSummaries[CAPABILITY.RECOVERY_OPTION_APPLY] ?? 'Apply the exact prepared recovery option to production.',
      explanation: 'External production mutation; blocked until the human approves its exact origin, tool, schema, and arguments.',
    }),
    toolNode({
      id: 'publish-status-update',
      capabilityId: CAPABILITY.STATUS_NOTICE_PUBLISH,
      dependencies: ['draft-status-update', 'apply-recovery-option'],
      mapping: resolvedMappings[CAPABILITY.STATUS_NOTICE_PUBLISH],
      args: args[CAPABILITY.STATUS_NOTICE_PUBLISH],
      argumentsDeferred: deferMutationArguments,
      effectSummary: effectSummaries[CAPABILITY.STATUS_NOTICE_PUBLISH] ?? 'Publish the exact prepared customer status notice.',
      explanation: 'External communication mutation; separately blocked until the human approves the exact message.',
    }),
  ];

  const plan = createPlan({
    id,
    objective,
    nodes,
    metadata: {
      ...structuredClone(metadata),
      packId: RECOVERY_ONTOLOGY.id,
      packVersion: RECOVERY_ONTOLOGY.version,
      requiredCapabilities: RECOVERY_CAPABILITIES.map(({ id: capabilityId }) => capabilityId),
      approvalNodeIds: ['apply-recovery-option', 'publish-status-update'],
      mutationArgumentsDeferred: deferMutationArguments,
      mutationArgumentsFinalized: !deferMutationArguments,
    },
    now,
  });
  attachLiveToolHandles(plan, resolvedMappings);
  return deferMutationArguments ? plan : freezeMutationArguments(plan);
}

function requireRecoveryPlan(plan) {
  if (!plan || typeof plan !== 'object' || plan.metadata?.packId !== RECOVERY_ONTOLOGY.id) {
    throw recoveryPlanError('RECOVERY_PLAN_INVALID', 'Mutation finalization requires a recovery plan.');
  }
  if (plan.metadata.mutationArgumentsDeferred !== true) {
    throw recoveryPlanError(
      'RECOVERY_ARGUMENTS_ALREADY_FINALIZED',
      'This recovery plan does not have deferred mutation arguments.',
      { planId: plan.id },
    );
  }
  return plan;
}

function planNode(plan, nodeId) {
  const node = plan.nodes.find((candidate) => candidate.id === nodeId);
  if (!node) {
    throw recoveryPlanError('RECOVERY_PLAN_INVALID', `Recovery plan is missing node ${nodeId}.`, { nodeId });
  }
  return node;
}

function suppliedResult(results, nodeId) {
  if (!results) return undefined;
  if (results instanceof Map) return results.get(nodeId);
  if (Array.isArray(results)) {
    const entry = results.find((candidate) => candidate?.nodeId === nodeId || candidate?.id === nodeId);
    return entry && Object.hasOwn(entry, 'result') ? entry.result : entry;
  }
  return results[nodeId];
}

function completedResult(plan, results, nodeId) {
  const node = planNode(plan, nodeId);
  if (node.status !== 'completed') {
    throw recoveryPlanError(
      'RECOVERY_FINALIZATION_NOT_READY',
      `Recovery node ${nodeId} must complete before mutation arguments are finalized.`,
      { nodeId, status: node.status },
    );
  }
  const external = suppliedResult(results, nodeId);
  const actual = external === undefined ? node.result : external;
  if (actual === undefined || actual === null) {
    throw recoveryPlanError(
      'RECOVERY_RESULT_MISSING',
      `Recovery node ${nodeId} has no completed result.`,
      { nodeId },
    );
  }
  if (external !== undefined && node.result !== undefined && node.result !== null
      && stableStringify(external) !== stableStringify(node.result)) {
    throw recoveryPlanError(
      'RECOVERY_RESULT_MISMATCH',
      `Supplied result for ${nodeId} does not match the result recorded on the plan.`,
      { nodeId },
    );
  }
  return cloneJson(actual, `${nodeId} result`);
}

function idempotencyKeyFor(plan, capabilityId, suppliedKeys) {
  const nodeId = RECOVERY_MUTATION_NODE_IDS[capabilityId];
  const supplied = valueFor(suppliedKeys, capabilityId);
  const key = supplied ?? `toolbraid:${plan.id}:r${plan.revision}:${nodeId}`;
  requireArgument({ idempotencyKey: key }, capabilityId, 'idempotencyKey');
  return key;
}

export function finalizeRecoveryMutationArguments(plan, {
  results = null,
  idempotencyKeys = {},
  effectSummaries = {},
} = {}) {
  requireRecoveryPlan(plan);

  const safeResults = {};
  for (const nodeId of RECOVERY_SAFE_STAGE_NODE_IDS) {
    safeResults[nodeId] = completedResult(plan, results, nodeId);
  }

  const applyNode = planNode(plan, RECOVERY_MUTATION_NODE_IDS[CAPABILITY.RECOVERY_OPTION_APPLY]);
  const publishNode = planNode(plan, RECOVERY_MUTATION_NODE_IDS[CAPABILITY.STATUS_NOTICE_PUBLISH]);
  for (const node of [applyNode, publishNode]) {
    if (node.status !== 'pending' || node.argumentsDeferred !== true) {
      throw recoveryPlanError(
        'RECOVERY_FINALIZATION_STATE_INVALID',
        `Mutation node ${node.id} must still be pending with deferred arguments.`,
        { nodeId: node.id, status: node.status, argumentsDeferred: node.argumentsDeferred },
      );
    }
  }

  const prepared = safeResults['prepare-recovery-option'];
  const currentNotice = safeResults['read-status-notice'];
  const draft = safeResults['draft-status-update'];

  const applyArguments = {
    recoveryOptionId: prepared.recoveryOptionId,
    quoteRevision: prepared.quoteRevision,
    idempotencyKey: idempotencyKeyFor(plan, CAPABILITY.RECOVERY_OPTION_APPLY, idempotencyKeys),
  };
  if (prepared.preconditions !== undefined) applyArguments.preconditions = prepared.preconditions;

  const publishArguments = {
    noticeId: currentNotice.noticeId,
    noticeRevision: currentNotice.noticeRevision,
    body: draft.body,
    idempotencyKey: idempotencyKeyFor(plan, CAPABILITY.STATUS_NOTICE_PUBLISH, idempotencyKeys),
  };
  if (typeof draft.title === 'string' && draft.title.trim() !== '') publishArguments.title = draft.title;

  validateMutationArguments(applyArguments, publishArguments);
  const finalizedApply = deepFreeze(cloneJson(applyArguments, `${CAPABILITY.RECOVERY_OPTION_APPLY} arguments`));
  const finalizedPublish = deepFreeze(cloneJson(publishArguments, `${CAPABILITY.STATUS_NOTICE_PUBLISH} arguments`));

  applyNode.arguments = finalizedApply;
  applyNode.argumentsDeferred = false;
  publishNode.arguments = finalizedPublish;
  publishNode.argumentsDeferred = false;

  const applyEffectSummary = valueFor(effectSummaries, CAPABILITY.RECOVERY_OPTION_APPLY) ?? prepared.effectSummary;
  const publishEffectSummary = valueFor(effectSummaries, CAPABILITY.STATUS_NOTICE_PUBLISH) ?? draft.effectSummary;
  if (typeof applyEffectSummary === 'string' && applyEffectSummary.trim() !== '') {
    applyNode.effectSummary = applyEffectSummary;
  }
  if (typeof publishEffectSummary === 'string' && publishEffectSummary.trim() !== '') {
    publishNode.effectSummary = publishEffectSummary;
  }

  plan.metadata.mutationArgumentsDeferred = false;
  plan.metadata.mutationArgumentsFinalized = true;
  return plan;
}

export { DEFAULT_OBJECTIVE };
