export const MISSION_PHASES = Object.freeze({
  IDLE: 'idle',
  DISCOVERING: 'discovering',
  MAPPING: 'mapping',
  READING: 'reading',
  PREPARING: 'preparing',
  REVIEW: 'review',
  APPROVED: 'approved',
  EXECUTING: 'executing',
  COMPLETE: 'complete',
});

export const MISSION_EVENTS = Object.freeze({
  START: 'mission.start',
  DISCOVERY_RESULT: 'discovery.result',
  DISCOVERY_COMPLETED: 'discovery.completed',
  TOOL_QUARANTINED: 'tool.quarantined',
  MAPPING_COMPLETED: 'mapping.completed',
  PARALLEL_READS_STARTED: 'reads.parallel.started',
  READ_NODE_COMPLETED: 'read.node.completed',
  READ_NODE_FAILED: 'read.node.failed',
  PROVIDER_SWAPPED: 'provider.swapped',
  PREPARATION_COMPLETED: 'preparation.completed',
  PREPARATION_FAILED: 'preparation.failed',
  NODE_SELECTED: 'node.selected',
  APPLY_APPROVED: 'approval.apply.granted',
  PUBLISH_APPROVED: 'approval.publish.granted',
  PLAN_INVALIDATED: 'plan.invalidated',
  EXECUTION_STARTED: 'execution.started',
  EXECUTION_NODE_COMPLETED: 'execution.node.completed',
  EXECUTION_FAILED: 'execution.failed',
  MISSION_SEALED: 'mission.sealed',
  RESET: 'mission.reset',
});

export const MISSION_NODE_STATUS = Object.freeze({
  PENDING: 'pending',
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
  INVALIDATED: 'invalidated',
});

const APPROVAL_EVENT_SCOPES = Object.freeze({
  [MISSION_EVENTS.APPLY_APPROVED]: 'apply',
  [MISSION_EVENTS.PUBLISH_APPROVED]: 'publish',
});

const EMPTY_ACTIVITY = Object.freeze({
  eventType: null,
  nodeIds: Object.freeze([]),
  edgeIds: Object.freeze([]),
});

export class MissionStateError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'MissionStateError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details = {}) {
  throw new MissionStateError(code, message, details);
}

function clone(value, label = 'Mission state data') {
  try {
    return structuredClone(value);
  } catch (cause) {
    fail('DATA_NOT_CLONEABLE', `${label} must contain structured-cloneable data only.`, {
      cause: cause instanceof Error ? cause.message : String(cause),
    });
  }
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function uniqueStrings(values, label) {
  if (!Array.isArray(values)) fail('CONFIG_INVALID', `${label} must be an array.`);
  const result = [];
  const seen = new Set();
  for (const value of values) {
    if (typeof value !== 'string' || value.trim() === '') {
      fail('CONFIG_INVALID', `${label} must contain non-empty string IDs.`);
    }
    if (seen.has(value)) fail('CONFIG_INVALID', `${label} contains duplicate ID ${value}.`, { id: value });
    seen.add(value);
    result.push(value);
  }
  return result;
}

function assertKnownIds(ids, knownIds, label) {
  for (const id of ids) {
    if (!knownIds.has(id)) fail('CONFIG_INVALID', `${label} references unknown ID ${id}.`, { id });
  }
}

function normalizeNodes(nodes) {
  if (!Array.isArray(nodes) || nodes.length === 0) {
    fail('CONFIG_INVALID', 'Mission Control requires at least one visual node.');
  }
  const seen = new Set();
  return nodes.map((input) => {
    if (!input || typeof input !== 'object' || typeof input.id !== 'string' || input.id.trim() === '') {
      fail('CONFIG_INVALID', 'Every visual node requires a non-empty string id.');
    }
    if (seen.has(input.id)) fail('CONFIG_INVALID', `Duplicate visual node ${input.id}.`, { nodeId: input.id });
    seen.add(input.id);
    const node = clone(input, `Node ${input.id}`);
    return {
      ...node,
      id: input.id,
      status: MISSION_NODE_STATUS.PENDING,
      trackProgress: input.trackProgress !== false,
      error: null,
    };
  });
}

function normalizeEdges(edges, nodeIds) {
  if (!Array.isArray(edges)) fail('CONFIG_INVALID', 'Mission edges must be an array.');
  const seen = new Set();
  return edges.map((input) => {
    if (!input || typeof input !== 'object'
      || typeof input.id !== 'string' || input.id.trim() === ''
      || typeof input.from !== 'string' || typeof input.to !== 'string') {
      fail('CONFIG_INVALID', 'Every visual edge requires string id, from, and to fields.');
    }
    if (seen.has(input.id)) fail('CONFIG_INVALID', `Duplicate visual edge ${input.id}.`, { edgeId: input.id });
    if (!nodeIds.has(input.from) || !nodeIds.has(input.to)) {
      fail('CONFIG_INVALID', `Edge ${input.id} references an unknown visual node.`, {
        edgeId: input.id,
        from: input.from,
        to: input.to,
      });
    }
    seen.add(input.id);
    return clone(input, `Edge ${input.id}`);
  });
}

function normalizeStages(stages, nodeIds) {
  const source = stages ?? {};
  const normalized = {
    discovery: uniqueStrings(source.discovery ?? [], 'stages.discovery'),
    mapping: uniqueStrings(source.mapping ?? [], 'stages.mapping'),
    reads: uniqueStrings(source.reads ?? [], 'stages.reads'),
    review: uniqueStrings(source.review ?? [], 'stages.review'),
  };
  for (const [stage, ids] of Object.entries(normalized)) assertKnownIds(ids, nodeIds, `stages.${stage}`);
  if (normalized.reads.length === 0) fail('CONFIG_INVALID', 'stages.reads requires at least one read node.');
  return normalized;
}

function normalizeApprovalScopes(scopes, nodeIds) {
  const source = scopes ?? {};
  const normalized = {
    apply: uniqueStrings(source.apply ?? [], 'approvalScopes.apply'),
    publish: uniqueStrings(source.publish ?? [], 'approvalScopes.publish'),
  };
  for (const [scope, ids] of Object.entries(normalized)) {
    assertKnownIds(ids, nodeIds, `approvalScopes.${scope}`);
    if (ids.length === 0) fail('CONFIG_INVALID', `approvalScopes.${scope} requires at least one node.`);
  }
  const overlap = normalized.apply.filter((id) => normalized.publish.includes(id));
  if (overlap.length) {
    fail('CONFIG_INVALID', 'Apply and publish approval scopes must remain separate.', { overlappingNodeIds: overlap });
  }
  return normalized;
}

function normalizeMappableNodeIds(value, nodeIds, stages, approvalScopes) {
  const fallback = [...new Set([
    ...stages.reads,
    ...approvalScopes.apply,
    ...approvalScopes.publish,
  ])];
  const result = uniqueStrings(value ?? fallback, 'mappableNodeIds');
  assertKnownIds(result, nodeIds, 'mappableNodeIds');
  return result;
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => [key, canonicalize(value[key])]),
  );
}

function nodeById(state, nodeId) {
  return state.nodes.find((node) => node.id === nodeId) ?? null;
}

function requireNode(state, nodeId, label = 'nodeId') {
  if (typeof nodeId !== 'string' || !nodeById(state, nodeId)) {
    fail('NODE_UNKNOWN', `${label} must identify a visual node.`, { nodeId });
  }
  return nodeById(state, nodeId);
}

function toolById(state, toolId) {
  return state.discovery.tools.find((tool) => tool.id === toolId) ?? null;
}

function requireTool(state, toolId, label = 'toolId') {
  if (typeof toolId !== 'string' || !toolById(state, toolId)) {
    fail('TOOL_UNKNOWN', `${label} must identify a discovered tool.`, { toolId });
  }
  return toolById(state, toolId);
}

function setNodeStatus(state, nodeIds, status, error = null) {
  const requested = new Set(nodeIds);
  for (const node of state.nodes) {
    if (!requested.has(node.id)) continue;
    node.status = status;
    node.error = error;
  }
}

function explicitOrDerivedEdges(state, event, nodeIds, direction) {
  if (event.activeEdgeIds !== undefined) {
    const requested = uniqueStrings(event.activeEdgeIds, 'event.activeEdgeIds');
    const known = new Set(state.edges.map((edge) => edge.id));
    for (const edgeId of requested) {
      if (!known.has(edgeId)) fail('EDGE_UNKNOWN', `Unknown active edge ${edgeId}.`, { edgeId });
    }
    return requested.sort();
  }
  const activeNodes = new Set(nodeIds);
  return state.edges
    .filter((edge) => direction === 'outgoing' ? activeNodes.has(edge.from) : activeNodes.has(edge.to))
    .map((edge) => edge.id)
    .sort();
}

function setActivity(state, event, nodeIds = [], direction = 'incoming') {
  const normalizedNodeIds = [...new Set(nodeIds)].sort();
  state.activity = {
    eventType: event.type,
    nodeIds: normalizedNodeIds,
    edgeIds: explicitOrDerivedEdges(state, event, normalizedNodeIds, direction),
  };
}

function assertPhase(state, event, allowed) {
  if (!allowed.includes(state.phase)) {
    fail('INVALID_TRANSITION', `${event.type} is not allowed while the mission is ${state.phase}.`, {
      eventType: event.type,
      phase: state.phase,
      allowedPhases: allowed,
    });
  }
}

function normalizeDiscoveredTools(tools) {
  if (!Array.isArray(tools) || tools.length === 0) {
    fail('DISCOVERY_RESULT_INVALID', 'A discovery result requires at least one tool descriptor.');
  }
  const seen = new Set();
  return tools.map((tool) => {
    if (!tool || typeof tool !== 'object' || typeof tool.id !== 'string' || tool.id.trim() === '') {
      fail('DISCOVERY_RESULT_INVALID', 'Every discovered tool requires a non-empty string id.');
    }
    if (seen.has(tool.id)) fail('DISCOVERY_RESULT_INVALID', `Duplicate discovered tool ${tool.id}.`, { toolId: tool.id });
    seen.add(tool.id);
    return clone(tool, `Discovered tool ${tool.id}`);
  });
}

function normalizeMappingRecord(state, nodeId, record) {
  requireNode(state, nodeId, 'mapping nodeId');
  if (!state.config.mappableNodeIds.includes(nodeId)) {
    fail('MAPPING_INVALID', `Node ${nodeId} is not declared mappable.`, { nodeId });
  }
  if (!record || typeof record !== 'object' || typeof record.primaryToolId !== 'string') {
    fail('MAPPING_INVALID', `Node ${nodeId} requires a primaryToolId.`, { nodeId });
  }
  requireTool(state, record.primaryToolId, 'primaryToolId');
  if (state.quarantine[record.primaryToolId]) {
    fail('MAPPING_QUARANTINED', `Node ${nodeId} cannot map to quarantined tool ${record.primaryToolId}.`, {
      nodeId,
      toolId: record.primaryToolId,
    });
  }
  const alternatives = uniqueStrings(record.alternativeToolIds ?? [], `${nodeId}.alternativeToolIds`);
  for (const toolId of alternatives) {
    requireTool(state, toolId, 'alternativeToolId');
    if (toolId === record.primaryToolId) {
      fail('MAPPING_INVALID', `Node ${nodeId} repeats its primary tool as an alternative.`, { nodeId, toolId });
    }
    if (state.quarantine[toolId]) {
      fail('MAPPING_QUARANTINED', `Node ${nodeId} cannot retain quarantined alternative ${toolId}.`, {
        nodeId,
        toolId,
      });
    }
  }
  return {
    primaryToolId: record.primaryToolId,
    alternativeToolIds: alternatives,
  };
}

function normalizeMappings(state, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    fail('MAPPING_INVALID', 'mapping.completed requires a node-keyed mappings object.');
  }
  const suppliedIds = Object.keys(input).sort();
  const requiredIds = [...state.config.mappableNodeIds].sort();
  const missing = requiredIds.filter((id) => !suppliedIds.includes(id));
  const unexpected = suppliedIds.filter((id) => !requiredIds.includes(id));
  if (missing.length || unexpected.length) {
    fail('MAPPING_INCOMPLETE', 'Mappings must cover every declared mappable node exactly once.', { missing, unexpected });
  }
  return Object.fromEntries(requiredIds.map((nodeId) => [nodeId, normalizeMappingRecord(state, nodeId, input[nodeId])]));
}

function mappingHasQuarantinedTool(state, nodeIds = state.config.mappableNodeIds) {
  return nodeIds.some((nodeId) => {
    const mapping = state.mappings[nodeId];
    return mapping && (state.quarantine[mapping.primaryToolId]
      || mapping.alternativeToolIds.some((toolId) => state.quarantine[toolId]));
  });
}

function allApprovalScopesGranted(state) {
  return Object.values(state.approvals).every((approval) => approval.granted);
}

function approvalDetails(event, scope, nodeIds) {
  return {
    scope,
    nodeIds: [...nodeIds].sort(),
    approvalId: typeof event.approvalId === 'string' ? event.approvalId : null,
  };
}

function resetOperationalState(state, { keepDiscovery = false } = {}) {
  setNodeStatus(state, state.nodes.map((node) => node.id), MISSION_NODE_STATUS.PENDING);
  state.discovery = keepDiscovery
    ? state.discovery
    : { generation: 0, tools: [], completed: false };
  state.quarantine = keepDiscovery ? state.quarantine : {};
  state.mappings = {};
  state.providerSwaps = [];
  state.selectedNodeId = null;
  state.approvals = {
    apply: { granted: false, approvalId: null, revision: null },
    publish: { granted: false, approvalId: null, revision: null },
  };
  state.execution = { nodeIds: [], completedNodeIds: [], failure: null };
  state.completion = null;
  state.activity = clone(EMPTY_ACTIVITY);
}

function auditDetailsFor(event, details) {
  if (details !== undefined) return canonicalize(details);
  return canonicalize({});
}

function appendAudit(state, event, phaseFrom, details) {
  state.audit.push({
    sequence: state.audit.length + 1,
    type: event.type,
    phaseFrom,
    phaseTo: state.phase,
    revision: state.revision,
    details: auditDetailsFor(event, details),
  });
}

export function createMissionState({
  missionId = 'mission-control',
  objective = '',
  nodes,
  edges = [],
  stages,
  approvalScopes,
  mappableNodeIds,
  metadata = {},
} = {}) {
  if (typeof missionId !== 'string' || missionId.trim() === '') fail('CONFIG_INVALID', 'missionId is required.');
  if (typeof objective !== 'string') fail('CONFIG_INVALID', 'objective must be a string.');
  const normalizedNodes = normalizeNodes(nodes);
  const nodeIds = new Set(normalizedNodes.map((node) => node.id));
  const normalizedStages = normalizeStages(stages, nodeIds);
  const normalizedScopes = normalizeApprovalScopes(approvalScopes, nodeIds);
  const state = {
    missionId,
    objective,
    metadata: clone(metadata, 'Mission metadata'),
    phase: MISSION_PHASES.IDLE,
    revision: 1,
    nodes: normalizedNodes,
    edges: normalizeEdges(edges, nodeIds),
    config: {
      stages: normalizedStages,
      approvalScopes: normalizedScopes,
      mappableNodeIds: normalizeMappableNodeIds(mappableNodeIds, nodeIds, normalizedStages, normalizedScopes),
    },
    discovery: { generation: 0, tools: [], completed: false },
    quarantine: {},
    mappings: {},
    providerSwaps: [],
    selectedNodeId: null,
    approvals: {
      apply: { granted: false, approvalId: null, revision: null },
      publish: { granted: false, approvalId: null, revision: null },
    },
    execution: { nodeIds: [], completedNodeIds: [], failure: null },
    completion: null,
    activity: clone(EMPTY_ACTIVITY),
    audit: [],
  };
  return deepFreeze(state);
}

export function transitionMission(currentState, event) {
  if (!currentState || typeof currentState !== 'object') fail('STATE_INVALID', 'A mission state is required.');
  if (!event || typeof event.type !== 'string') fail('EVENT_INVALID', 'A mission event requires a type.');
  const state = clone(currentState);
  const phaseFrom = state.phase;
  let details;

  switch (event.type) {
    case MISSION_EVENTS.START: {
      assertPhase(state, event, [MISSION_PHASES.IDLE]);
      state.phase = MISSION_PHASES.DISCOVERING;
      setNodeStatus(state, state.config.stages.discovery, MISSION_NODE_STATUS.RUNNING);
      setActivity(state, event, state.config.stages.discovery, 'incoming');
      details = { objective: state.objective };
      break;
    }

    case MISSION_EVENTS.DISCOVERY_RESULT: {
      assertPhase(state, event, [MISSION_PHASES.DISCOVERING]);
      const discovered = normalizeDiscoveredTools(event.tools);
      const existing = new Set(state.discovery.tools.map((tool) => tool.id));
      const duplicate = discovered.find((tool) => existing.has(tool.id));
      if (duplicate) fail('DISCOVERY_RESULT_INVALID', `Tool ${duplicate.id} was already discovered.`, { toolId: duplicate.id });
      state.discovery.tools.push(...discovered);
      state.discovery.generation = Number.isSafeInteger(event.generation)
        ? event.generation
        : state.discovery.generation + 1;
      setActivity(state, event, event.nodeIds ?? [], 'outgoing');
      details = { generation: state.discovery.generation, toolIds: discovered.map((tool) => tool.id).sort() };
      break;
    }

    case MISSION_EVENTS.DISCOVERY_COMPLETED: {
      assertPhase(state, event, [MISSION_PHASES.DISCOVERING]);
      if (state.discovery.tools.length === 0) fail('DISCOVERY_EMPTY', 'Discovery cannot complete without eligible tool descriptors.');
      state.discovery.completed = true;
      setNodeStatus(state, state.config.stages.discovery, MISSION_NODE_STATUS.COMPLETED);
      setNodeStatus(state, state.config.stages.mapping, MISSION_NODE_STATUS.RUNNING);
      state.phase = MISSION_PHASES.MAPPING;
      setActivity(state, event, state.config.stages.mapping, 'incoming');
      details = { discoveredToolCount: state.discovery.tools.length, generation: state.discovery.generation };
      break;
    }

    case MISSION_EVENTS.TOOL_QUARANTINED: {
      assertPhase(state, event, [
        MISSION_PHASES.DISCOVERING,
        MISSION_PHASES.MAPPING,
        MISSION_PHASES.READING,
        MISSION_PHASES.PREPARING,
        MISSION_PHASES.REVIEW,
        MISSION_PHASES.APPROVED,
        MISSION_PHASES.EXECUTING,
      ]);
      requireTool(state, event.toolId);
      if (state.quarantine[event.toolId]) {
        fail('TOOL_ALREADY_QUARANTINED', `Tool ${event.toolId} is already quarantined.`, { toolId: event.toolId });
      }
      if (typeof event.reason !== 'string' || event.reason.trim() === '') {
        fail('QUARANTINE_REASON_REQUIRED', 'A deterministic quarantine reason is required.');
      }
      state.quarantine[event.toolId] = { reason: event.reason, sequence: state.audit.length + 1 };
      const affectedNodeIds = Object.entries(state.mappings)
        .filter(([, mapping]) => mapping.primaryToolId === event.toolId || mapping.alternativeToolIds.includes(event.toolId))
        .map(([nodeId]) => nodeId)
        .sort();
      for (const nodeId of affectedNodeIds) {
        const mapping = state.mappings[nodeId];
        if (mapping.primaryToolId !== event.toolId) continue;
        const node = nodeById(state, nodeId);
        if (node && node.status !== MISSION_NODE_STATUS.COMPLETED) {
          node.status = MISSION_NODE_STATUS.FAILED;
          node.error = 'mapped tool quarantined';
        }
      }
      let automaticInvalidation = false;
      if (affectedNodeIds.length && [MISSION_PHASES.APPROVED, MISSION_PHASES.EXECUTING].includes(state.phase)) {
        automaticInvalidation = true;
        state.revision += 1;
        resetOperationalState(state, { keepDiscovery: true });
        setNodeStatus(state, state.config.stages.discovery, MISSION_NODE_STATUS.COMPLETED);
        setNodeStatus(state, state.config.stages.mapping, MISSION_NODE_STATUS.RUNNING);
        state.phase = MISSION_PHASES.MAPPING;
      }
      setActivity(state, event, affectedNodeIds, 'incoming');
      details = { toolId: event.toolId, reason: event.reason, affectedNodeIds, automaticInvalidation };
      break;
    }

    case MISSION_EVENTS.MAPPING_COMPLETED: {
      assertPhase(state, event, [MISSION_PHASES.MAPPING]);
      state.mappings = normalizeMappings(state, event.mappings);
      setNodeStatus(state, state.config.stages.mapping, MISSION_NODE_STATUS.COMPLETED);
      setActivity(state, event, state.config.mappableNodeIds, 'incoming');
      details = {
        mappings: Object.fromEntries(Object.entries(state.mappings).map(([nodeId, mapping]) => [nodeId, mapping.primaryToolId])),
      };
      break;
    }

    case MISSION_EVENTS.PARALLEL_READS_STARTED: {
      assertPhase(state, event, [MISSION_PHASES.MAPPING]);
      if (Object.keys(state.mappings).length !== state.config.mappableNodeIds.length) {
        fail('MAPPING_INCOMPLETE', 'Parallel reads require a complete mapping set.');
      }
      if (mappingHasQuarantinedTool(state, state.config.stages.reads)) {
        fail('MAPPING_QUARANTINED', 'Parallel reads cannot start with quarantined mappings.');
      }
      setNodeStatus(state, state.config.stages.reads, MISSION_NODE_STATUS.RUNNING);
      state.phase = MISSION_PHASES.READING;
      setActivity(state, event, state.config.stages.reads, 'incoming');
      details = { nodeIds: [...state.config.stages.reads].sort() };
      break;
    }

    case MISSION_EVENTS.READ_NODE_COMPLETED: {
      assertPhase(state, event, [MISSION_PHASES.READING]);
      const node = requireNode(state, event.nodeId);
      if (!state.config.stages.reads.includes(node.id)) {
        fail('READ_NODE_INVALID', `Node ${node.id} is not a parallel read node.`, { nodeId: node.id });
      }
      if (node.status !== MISSION_NODE_STATUS.RUNNING) {
        fail('READ_NODE_STATE_INVALID', `Read node ${node.id} cannot complete from ${node.status}.`, {
          nodeId: node.id,
          status: node.status,
        });
      }
      node.status = MISSION_NODE_STATUS.COMPLETED;
      node.error = null;
      const allReadsComplete = state.config.stages.reads.every(
        (nodeId) => nodeById(state, nodeId).status === MISSION_NODE_STATUS.COMPLETED,
      );
      if (allReadsComplete) {
        setNodeStatus(state, state.config.stages.review, MISSION_NODE_STATUS.RUNNING);
        state.phase = MISSION_PHASES.PREPARING;
      }
      setActivity(state, event, [node.id], 'outgoing');
      details = { nodeId: node.id, allReadsComplete };
      break;
    }

    case MISSION_EVENTS.PREPARATION_COMPLETED: {
      assertPhase(state, event, [MISSION_PHASES.PREPARING]);
      setNodeStatus(state, state.config.stages.review, MISSION_NODE_STATUS.COMPLETED);
      state.phase = MISSION_PHASES.REVIEW;
      setActivity(state, event, state.config.stages.review, 'outgoing');
      details = {
        nodeIds: [...state.config.stages.review].sort(),
        planRevision: event.planRevision ?? null,
      };
      break;
    }

    case MISSION_EVENTS.PREPARATION_FAILED: {
      assertPhase(state, event, [MISSION_PHASES.PREPARING]);
      const message = typeof event.error === 'string' && event.error.trim()
        ? event.error
        : 'recovery preparation failed';
      setNodeStatus(state, state.config.stages.review, MISSION_NODE_STATUS.FAILED, message);
      setActivity(state, event, state.config.stages.review, 'incoming');
      details = { error: message, resetRequired: true };
      break;
    }

    case MISSION_EVENTS.READ_NODE_FAILED: {
      assertPhase(state, event, [MISSION_PHASES.READING]);
      const node = requireNode(state, event.nodeId);
      if (!state.config.stages.reads.includes(node.id)) {
        fail('READ_NODE_INVALID', `Node ${node.id} is not a parallel read node.`, { nodeId: node.id });
      }
      if (node.status !== MISSION_NODE_STATUS.RUNNING) {
        fail('READ_NODE_STATE_INVALID', `Read node ${node.id} cannot fail from ${node.status}.`, {
          nodeId: node.id,
          status: node.status,
        });
      }
      const message = typeof event.error === 'string' && event.error.trim() ? event.error : 'provider read failed';
      node.status = MISSION_NODE_STATUS.FAILED;
      node.error = message;
      setActivity(state, event, [node.id], 'incoming');
      details = { nodeId: node.id, error: message };
      break;
    }

    case MISSION_EVENTS.PROVIDER_SWAPPED: {
      assertPhase(state, event, [MISSION_PHASES.READING]);
      const node = requireNode(state, event.nodeId);
      if (!state.config.stages.reads.includes(node.id)) {
        fail('PROVIDER_SWAP_FORBIDDEN', 'Provider substitution is allowed only for read nodes.', { nodeId: node.id });
      }
      const mapping = state.mappings[node.id];
      if (!mapping) fail('MAPPING_INVALID', `Read node ${node.id} has no mapping.`, { nodeId: node.id });
      if (node.status !== MISSION_NODE_STATUS.FAILED) {
        fail('PROVIDER_SWAP_FORBIDDEN', `Read node ${node.id} must fail before provider substitution.`, {
          nodeId: node.id,
          status: node.status,
        });
      }
      if (mapping.primaryToolId !== event.fromToolId) {
        fail('PROVIDER_SWAP_STALE', 'Provider substitution does not match the current primary tool.', {
          expected: mapping.primaryToolId,
          received: event.fromToolId,
        });
      }
      if (!mapping.alternativeToolIds.includes(event.toToolId)) {
        fail('PROVIDER_SWAP_FORBIDDEN', `Tool ${event.toToolId} is not an eligible mapped alternative.`, {
          nodeId: node.id,
          toolId: event.toToolId,
        });
      }
      requireTool(state, event.toToolId, 'toToolId');
      if (state.quarantine[event.toToolId]) {
        fail('MAPPING_QUARANTINED', `Cannot substitute quarantined tool ${event.toToolId}.`, { toolId: event.toToolId });
      }
      mapping.primaryToolId = event.toToolId;
      mapping.alternativeToolIds = [event.fromToolId, ...mapping.alternativeToolIds.filter((id) => id !== event.toToolId)];
      node.status = MISSION_NODE_STATUS.RUNNING;
      node.error = null;
      const swap = {
        sequence: state.providerSwaps.length + 1,
        nodeId: node.id,
        fromToolId: event.fromToolId,
        toToolId: event.toToolId,
        reason: typeof event.reason === 'string' ? event.reason : null,
      };
      state.providerSwaps.push(swap);
      setActivity(state, event, [node.id], 'incoming');
      details = swap;
      break;
    }

    case MISSION_EVENTS.NODE_SELECTED: {
      assertPhase(state, event, [
        MISSION_PHASES.DISCOVERING,
        MISSION_PHASES.MAPPING,
        MISSION_PHASES.READING,
        MISSION_PHASES.PREPARING,
        MISSION_PHASES.REVIEW,
        MISSION_PHASES.APPROVED,
        MISSION_PHASES.EXECUTING,
        MISSION_PHASES.COMPLETE,
      ]);
      const node = requireNode(state, event.nodeId);
      state.selectedNodeId = node.id;
      setActivity(state, event, [], 'incoming');
      details = { nodeId: node.id };
      break;
    }

    case MISSION_EVENTS.APPLY_APPROVED:
    case MISSION_EVENTS.PUBLISH_APPROVED: {
      assertPhase(state, event, [MISSION_PHASES.REVIEW]);
      const scope = APPROVAL_EVENT_SCOPES[event.type];
      const scopeNodeIds = state.config.approvalScopes[scope];
      if (state.approvals[scope].granted) {
        fail('APPROVAL_DUPLICATE', `${scope} was already approved.`, { scope });
      }
      if (mappingHasQuarantinedTool(state, scopeNodeIds)) {
        fail('APPROVAL_MAPPING_INVALID', `${scope} cannot be approved while its mapping is quarantined.`, { scope });
      }
      if (event.nodeIds !== undefined) {
        const received = uniqueStrings(event.nodeIds, 'event.nodeIds').sort();
        const expected = [...scopeNodeIds].sort();
        if (JSON.stringify(received) !== JSON.stringify(expected)) {
          fail('APPROVAL_SCOPE_INVALID', `${scope} approval must bind its exact node scope.`, { expected, received });
        }
      }
      state.approvals[scope] = {
        granted: true,
        approvalId: typeof event.approvalId === 'string' ? event.approvalId : null,
        revision: state.revision,
      };
      if (allApprovalScopesGranted(state)) state.phase = MISSION_PHASES.APPROVED;
      setActivity(state, event, scopeNodeIds, 'incoming');
      details = approvalDetails(event, scope, scopeNodeIds);
      break;
    }

    case MISSION_EVENTS.PLAN_INVALIDATED: {
      assertPhase(state, event, [
        MISSION_PHASES.DISCOVERING,
        MISSION_PHASES.MAPPING,
        MISSION_PHASES.READING,
        MISSION_PHASES.PREPARING,
        MISSION_PHASES.REVIEW,
        MISSION_PHASES.APPROVED,
        MISSION_PHASES.EXECUTING,
      ]);
      if (typeof event.reason !== 'string' || event.reason.trim() === '') {
        fail('INVALIDATION_REASON_REQUIRED', 'Plan invalidation requires a deterministic reason.');
      }
      const rediscover = event.restartAt === MISSION_PHASES.DISCOVERING;
      if (event.restartAt !== undefined && ![MISSION_PHASES.DISCOVERING, MISSION_PHASES.MAPPING].includes(event.restartAt)) {
        fail('INVALIDATION_TARGET_INVALID', 'restartAt must be discovering or mapping.');
      }
      state.revision += 1;
      resetOperationalState(state, { keepDiscovery: !rediscover });
      if (rediscover) {
        state.phase = MISSION_PHASES.DISCOVERING;
        setNodeStatus(state, state.config.stages.discovery, MISSION_NODE_STATUS.RUNNING);
        setActivity(state, event, state.config.stages.discovery, 'incoming');
      } else {
        if (!state.discovery.completed) fail('INVALIDATION_TARGET_INVALID', 'Cannot restart mapping before discovery completes.');
        state.phase = MISSION_PHASES.MAPPING;
        setNodeStatus(state, state.config.stages.discovery, MISSION_NODE_STATUS.COMPLETED);
        setNodeStatus(state, state.config.stages.mapping, MISSION_NODE_STATUS.RUNNING);
        setActivity(state, event, state.config.stages.mapping, 'incoming');
      }
      details = { reason: event.reason, restartAt: state.phase };
      break;
    }

    case MISSION_EVENTS.EXECUTION_STARTED: {
      assertPhase(state, event, [MISSION_PHASES.APPROVED]);
      if (!allApprovalScopesGranted(state)) fail('EXECUTION_NOT_APPROVED', 'Execution requires separate apply and publish approvals.');
      if (Object.values(state.approvals).some((approval) => approval.revision !== state.revision)) {
        fail('EXECUTION_APPROVAL_STALE', 'Execution approvals do not bind the current plan revision.');
      }
      const expected = [...new Set([
        ...state.config.approvalScopes.apply,
        ...state.config.approvalScopes.publish,
      ])].sort();
      const nodeIds = event.nodeIds === undefined
        ? expected
        : uniqueStrings(event.nodeIds, 'event.nodeIds').sort();
      if (JSON.stringify(nodeIds) !== JSON.stringify(expected)) {
        fail('EXECUTION_SCOPE_INVALID', 'Execution must use the exact separately approved node set.', { expected, received: nodeIds });
      }
      if (mappingHasQuarantinedTool(state, nodeIds)) {
        fail('EXECUTION_MAPPING_INVALID', 'Execution cannot use a quarantined tool mapping.');
      }
      setNodeStatus(state, nodeIds, MISSION_NODE_STATUS.RUNNING);
      state.execution = { nodeIds, completedNodeIds: [], failure: null };
      state.phase = MISSION_PHASES.EXECUTING;
      setActivity(state, event, nodeIds, 'incoming');
      details = { nodeIds };
      break;
    }

    case MISSION_EVENTS.MISSION_SEALED: {
      const kind = event.kind;
      if (!['read-only', 'security'].includes(kind)) {
        fail('MISSION_COMPLETION_INVALID', 'A non-mutating mission must declare read-only or security completion.');
      }
      const expectedPhase = kind === 'read-only' ? MISSION_PHASES.PREPARING : MISSION_PHASES.MAPPING;
      assertPhase(state, event, [expectedPhase]);
      if (typeof event.sealHash !== 'string' || !/^[a-f0-9]{64}$/.test(event.sealHash)) {
        fail('MISSION_SEAL_INVALID', 'Non-mutating completion requires a verified SHA-256 audit seal.');
      }
      for (const node of state.nodes) {
        if (node.status === MISSION_NODE_STATUS.RUNNING) node.status = MISSION_NODE_STATUS.PENDING;
      }
      state.phase = MISSION_PHASES.COMPLETE;
      state.completion = {
        kind,
        sealHash: event.sealHash,
        resultNodeIds: event.resultNodeIds === undefined
          ? []
          : uniqueStrings(event.resultNodeIds, 'event.resultNodeIds'),
      };
      setActivity(state, event, state.completion.resultNodeIds, 'outgoing');
      details = clone(state.completion, 'Mission completion');
      break;
    }

    case MISSION_EVENTS.EXECUTION_NODE_COMPLETED: {
      assertPhase(state, event, [MISSION_PHASES.EXECUTING]);
      const node = requireNode(state, event.nodeId);
      if (!state.execution.nodeIds.includes(node.id) || node.status !== MISSION_NODE_STATUS.RUNNING) {
        fail('EXECUTION_NODE_STATE_INVALID', `Execution node ${node.id} cannot complete from ${node.status}.`, {
          nodeId: node.id,
          status: node.status,
        });
      }
      node.status = MISSION_NODE_STATUS.COMPLETED;
      node.error = null;
      state.execution.completedNodeIds.push(node.id);
      const complete = state.execution.nodeIds.every(
        (nodeId) => nodeById(state, nodeId).status === MISSION_NODE_STATUS.COMPLETED,
      );
      if (complete) {
        state.phase = MISSION_PHASES.COMPLETE;
        state.completion = { kind: 'mutations', sealHash: null, resultNodeIds: [...state.execution.completedNodeIds] };
      }
      setActivity(state, event, [node.id], 'outgoing');
      details = { nodeId: node.id, complete };
      break;
    }

    case MISSION_EVENTS.EXECUTION_FAILED: {
      assertPhase(state, event, [MISSION_PHASES.EXECUTING]);
      const node = requireNode(state, event.nodeId);
      if (!state.execution.nodeIds.includes(node.id) || node.status !== MISSION_NODE_STATUS.RUNNING) {
        fail('EXECUTION_NODE_STATE_INVALID', `Execution node ${node.id} cannot fail from ${node.status}.`, {
          nodeId: node.id,
          status: node.status,
        });
      }
      const message = typeof event.error === 'string' && event.error.trim() ? event.error : 'execution failed';
      node.status = MISSION_NODE_STATUS.FAILED;
      node.error = message;
      state.execution.failure = { nodeId: node.id, error: message };
      state.approvals = {
        apply: { granted: false, approvalId: null, revision: null },
        publish: { granted: false, approvalId: null, revision: null },
      };
      for (const nodeId of state.execution.nodeIds) {
        const candidate = nodeById(state, nodeId);
        if (candidate.status === MISSION_NODE_STATUS.RUNNING) candidate.status = MISSION_NODE_STATUS.PENDING;
      }
      state.phase = MISSION_PHASES.REVIEW;
      setActivity(state, event, [node.id], 'incoming');
      details = { nodeId: node.id, error: message, approvalsCleared: true };
      break;
    }

    case MISSION_EVENTS.RESET: {
      assertPhase(state, event, [
        MISSION_PHASES.DISCOVERING,
        MISSION_PHASES.MAPPING,
        MISSION_PHASES.READING,
        MISSION_PHASES.PREPARING,
        MISSION_PHASES.REVIEW,
        MISSION_PHASES.APPROVED,
        MISSION_PHASES.EXECUTING,
        MISSION_PHASES.COMPLETE,
      ]);
      state.revision += 1;
      resetOperationalState(state);
      state.phase = MISSION_PHASES.IDLE;
      details = { resetToRevision: state.revision };
      break;
    }

    default:
      fail('EVENT_UNKNOWN', `Unknown mission event: ${event.type}`, { eventType: event.type });
  }

  appendAudit(state, event, phaseFrom, details);
  return deepFreeze(state);
}

export function reduceMissionEvents(initialState, events) {
  if (!Array.isArray(events)) fail('EVENT_INVALID', 'events must be an array.');
  return events.reduce((state, event) => transitionMission(state, event), initialState);
}

export function selectActiveEdgeIds(state) {
  return [...(state?.activity?.edgeIds ?? [])].sort();
}

export function selectMissionProgress(state) {
  const tracked = state.nodes.filter((node) => node.trackProgress !== false);
  const completed = tracked.filter((node) => node.status === MISSION_NODE_STATUS.COMPLETED).length;
  const failed = tracked.filter((node) => node.status === MISSION_NODE_STATUS.FAILED).length;
  const running = tracked.filter((node) => node.status === MISSION_NODE_STATUS.RUNNING).length;
  return {
    completed,
    failed,
    running,
    total: tracked.length,
    percent: Math.round((completed / Math.max(1, tracked.length)) * 100),
    phase: state.phase,
  };
}

export function selectAllowedActions(state) {
  const base = [MISSION_EVENTS.NODE_SELECTED, MISSION_EVENTS.RESET];
  switch (state.phase) {
    case MISSION_PHASES.IDLE:
      return [MISSION_EVENTS.START];
    case MISSION_PHASES.DISCOVERING:
      return [
        MISSION_EVENTS.DISCOVERY_RESULT,
        MISSION_EVENTS.DISCOVERY_COMPLETED,
        MISSION_EVENTS.TOOL_QUARANTINED,
        MISSION_EVENTS.PLAN_INVALIDATED,
        ...base,
      ].filter((type) => type !== MISSION_EVENTS.NODE_SELECTED || state.nodes.length > 0);
    case MISSION_PHASES.MAPPING:
      return [
        Object.keys(state.mappings).length === state.config.mappableNodeIds.length
          ? MISSION_EVENTS.PARALLEL_READS_STARTED
          : MISSION_EVENTS.MAPPING_COMPLETED,
        MISSION_EVENTS.TOOL_QUARANTINED,
        MISSION_EVENTS.PLAN_INVALIDATED,
        ...base,
      ];
    case MISSION_PHASES.READING: {
      const actions = [
        MISSION_EVENTS.READ_NODE_COMPLETED,
        MISSION_EVENTS.READ_NODE_FAILED,
        MISSION_EVENTS.TOOL_QUARANTINED,
        MISSION_EVENTS.PLAN_INVALIDATED,
        ...base,
      ];
      const canSwap = state.config.stages.reads.some((nodeId) => {
        const node = nodeById(state, nodeId);
        const mapping = state.mappings[nodeId];
        return node.status === MISSION_NODE_STATUS.FAILED
          && mapping?.alternativeToolIds.some((toolId) => !state.quarantine[toolId]);
      });
      if (canSwap) actions.push(MISSION_EVENTS.PROVIDER_SWAPPED);
      return [...new Set(actions)];
    }
    case MISSION_PHASES.PREPARING: {
      const preparationFailed = state.config.stages.review.some(
        (nodeId) => nodeById(state, nodeId)?.status === MISSION_NODE_STATUS.FAILED,
      );
      return [
        ...(preparationFailed ? [] : [MISSION_EVENTS.PREPARATION_COMPLETED, MISSION_EVENTS.PREPARATION_FAILED]),
        MISSION_EVENTS.NODE_SELECTED,
        MISSION_EVENTS.RESET,
      ];
    }
    case MISSION_PHASES.REVIEW: {
      const actions = [MISSION_EVENTS.TOOL_QUARANTINED, MISSION_EVENTS.PLAN_INVALIDATED, ...base];
      if (!state.approvals.apply.granted
        && !mappingHasQuarantinedTool(state, state.config.approvalScopes.apply)) {
        actions.push(MISSION_EVENTS.APPLY_APPROVED);
      }
      if (!state.approvals.publish.granted
        && !mappingHasQuarantinedTool(state, state.config.approvalScopes.publish)) {
        actions.push(MISSION_EVENTS.PUBLISH_APPROVED);
      }
      return actions;
    }
    case MISSION_PHASES.APPROVED:
      return [MISSION_EVENTS.EXECUTION_STARTED, MISSION_EVENTS.TOOL_QUARANTINED, MISSION_EVENTS.PLAN_INVALIDATED, ...base];
    case MISSION_PHASES.EXECUTING:
      return [
        MISSION_EVENTS.EXECUTION_NODE_COMPLETED,
        MISSION_EVENTS.EXECUTION_FAILED,
        MISSION_EVENTS.TOOL_QUARANTINED,
        MISSION_EVENTS.PLAN_INVALIDATED,
        ...base,
      ];
    case MISSION_PHASES.COMPLETE:
      return base;
    default:
      return [];
  }
}

export const createInitialMissionState = createMissionState;
export const missionReducer = transitionMission;
