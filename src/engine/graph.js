export const NODE_STATUS = Object.freeze({
  PENDING: 'pending',
  APPROVED: 'approved',
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
  INVALIDATED: 'invalidated',
});

function graphError(code, message, details = {}) {
  const error = new Error(message);
  error.name = 'GraphError';
  error.code = code;
  error.details = details;
  return error;
}

function clone(value) {
  return structuredClone(value);
}

function cloneCandidate(candidate) {
  return {
    ...candidate,
    tool: candidate.tool,
    arguments: clone(candidate.arguments ?? {}),
    evidence: candidate.evidence === undefined ? undefined : clone(candidate.evidence),
  };
}

function cloneNode(node) {
  const { candidates, mapping, alternatives, ...serializable } = node;
  const cloned = clone(serializable);
  if (Array.isArray(candidates)) cloned.candidates = candidates.map(cloneCandidate);
  if (mapping) cloned.mapping = cloneCandidate(mapping);
  if (Array.isArray(alternatives)) cloned.alternatives = alternatives.map(cloneCandidate);
  return cloned;
}

export function validateGraphNodes(nodes) {
  if (!Array.isArray(nodes) || nodes.length === 0) {
    throw graphError('GRAPH_EMPTY', 'A plan requires at least one node.');
  }

  const byId = new Map();
  for (const node of nodes) {
    if (!node?.id || typeof node.id !== 'string') throw graphError('NODE_ID_INVALID', 'Every node requires a string id.');
    if (byId.has(node.id)) throw graphError('NODE_ID_DUPLICATE', `Duplicate plan node: ${node.id}`, { nodeId: node.id });
    byId.set(node.id, node);
  }

  for (const node of nodes) {
    if (!Array.isArray(node.dependencies)) throw graphError('NODE_DEPENDENCIES_INVALID', `Node ${node.id} requires a dependencies array.`);
    for (const dependency of node.dependencies) {
      if (!byId.has(dependency)) {
        throw graphError('NODE_DEPENDENCY_MISSING', `Node ${node.id} depends on missing node ${dependency}.`, {
          nodeId: node.id,
          dependency,
        });
      }
      if (dependency === node.id) throw graphError('GRAPH_CYCLE', `Node ${node.id} depends on itself.`, { nodeId: node.id });
    }
  }

  const visiting = new Set();
  const visited = new Set();
  const visit = (nodeId, path = []) => {
    if (visiting.has(nodeId)) throw graphError('GRAPH_CYCLE', `Plan contains a dependency cycle at ${nodeId}.`, { path: [...path, nodeId] });
    if (visited.has(nodeId)) return;
    visiting.add(nodeId);
    for (const dependency of byId.get(nodeId).dependencies) visit(dependency, [...path, nodeId]);
    visiting.delete(nodeId);
    visited.add(nodeId);
  };
  for (const nodeId of byId.keys()) visit(nodeId);
  return true;
}

export function createPlan({ id, objective, nodes, metadata = {}, now = new Date() }) {
  validateGraphNodes(nodes);
  return {
    id,
    revision: 1,
    objective,
    metadata: clone(metadata),
    nodes: nodes.map((node) => ({
      ...cloneNode(node),
      dependencies: [...node.dependencies],
      status: NODE_STATUS.PENDING,
      result: null,
      error: null,
    })),
    status: 'planned',
    createdAt: now.toISOString(),
    invalidatedAt: null,
    invalidationReason: null,
  };
}

export function runnableNodes(plan, { includeApprovedMutations = false } = {}) {
  const byId = new Map(plan.nodes.map((node) => [node.id, node]));
  return plan.nodes.filter((node) => {
    if (node.status !== NODE_STATUS.PENDING && node.status !== NODE_STATUS.APPROVED) return false;
    if (!node.dependencies.every((id) => byId.get(id)?.status === NODE_STATUS.COMPLETED)) return false;
    if (!node.approvalRequired) return node.status === NODE_STATUS.PENDING;
    return includeApprovedMutations && node.status === NODE_STATUS.APPROVED;
  });
}

export function approveNodes(plan, nodeIds) {
  const requested = new Set(nodeIds);
  for (const node of plan.nodes) {
    if (requested.has(node.id)) {
      if (!node.approvalRequired) throw graphError('APPROVAL_SCOPE_INVALID', `Node ${node.id} is not approval-gated.`, { nodeId: node.id });
      if (node.status !== NODE_STATUS.PENDING) throw graphError('APPROVAL_STATE_INVALID', `Node ${node.id} cannot be approved from ${node.status}.`, { nodeId: node.id, status: node.status });
      node.status = NODE_STATUS.APPROVED;
    }
  }
  const unknown = [...requested].filter((id) => !plan.nodes.some((node) => node.id === id));
  if (unknown.length) throw graphError('APPROVAL_SCOPE_INVALID', `Unknown approval nodes: ${unknown.join(', ')}`, { unknown });
  plan.status = 'approved';
  return plan;
}

export function invalidatePlan(plan, reason, now = new Date()) {
  plan.revision += 1;
  plan.status = 'invalidated';
  plan.invalidatedAt = now.toISOString();
  plan.invalidationReason = reason;
  for (const node of plan.nodes) {
    if (node.status !== NODE_STATUS.COMPLETED) node.status = NODE_STATUS.INVALIDATED;
  }
  return plan;
}

export function planProgress(plan) {
  const completed = plan.nodes.filter((node) => node.status === NODE_STATUS.COMPLETED).length;
  return {
    completed,
    total: plan.nodes.length,
    percent: Math.round((completed / Math.max(1, plan.nodes.length)) * 100),
  };
}
