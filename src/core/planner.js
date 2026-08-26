import { CoreError } from './errors.js';
import { requireIdentity } from './identity.js';
import { canonicalHash, jsonClone } from './serialization.js';

const NODE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const WORKFLOW_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+\-]{0,199}$/;
const UNSAFE_NODE_KEYS = new Set([
  'code', 'command', 'eval', 'evaluate', 'exec', 'execute', 'function',
  'javascript', 'raw', 'script', 'shell', 'shellcommand', 'source',
]);

/**
 * Produces a canonical, deterministic plan from semantic capability nodes.
 * There is no model/tool execution in this module: callers must provide the
 * node graph explicitly and the planner only resolves catalog metadata and
 * validates the DAG.
 */
export class DeterministicPlanner {
  constructor(options = {}) {
    // Accept a catalog directly as a convenience while retaining an options
    // object for future clock/hash policy injection.
    if (options && typeof options.resolve === 'function') options = { catalog: options };
    if (!options || typeof options !== 'object' || !options.catalog || typeof options.catalog.resolve !== 'function') {
      throw new CoreError('INVALID_PLANNER', 'A capability catalog is required');
    }
    this.catalog = options.catalog;
    this.idFactory = typeof options.idFactory === 'function' ? options.idFactory : undefined;
  }

  propose(input) {
    const operation = requireObject(input, 'propose input');
    const identity = requireIdentity(operation);
    const source = operation.plan && typeof operation.plan === 'object' ? operation.plan : operation;
    const requestedWorkflowId = source.workflowId ?? operation.workflowId;
    const revision = normalizeRevision(source.revision ?? operation.revision);
    const rawNodes = source.nodes ?? source.steps;
    if (!Array.isArray(rawNodes) || rawNodes.length === 0) {
      throw new CoreError('INVALID_PLAN', 'A plan must contain at least one node');
    }

    const nodes = rawNodes.map((rawNode, index) => this.#normalizeNode(rawNode, index, identity));
    const workflowId = requestedWorkflowId === undefined
      ? this.#generatedWorkflowId({ identity, revision, nodes, source })
      : normalizeWorkflowId(requestedWorkflowId);
    assertUniqueNodeIds(nodes);
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const edges = [];
    for (const node of nodes) {
      for (const dependency of node.dependsOn) {
        if (!byId.has(dependency)) {
          throw new CoreError('INVALID_PLAN', `Node ${node.id} depends on unknown node ${dependency}`);
        }
        edges.push({ from: dependency, to: node.id });
      }
    }
    const order = topologicalOrder(nodes);
    const orderedNodes = order.map((id) => byId.get(id));
    const readOnly = orderedNodes.every((node) => node.readOnly);
    const requiresApproval = orderedNodes.filter((node) => !node.readOnly).map((node) => node.id);
    const plan = {
      workflowId,
      revision,
      tenantId: identity.tenantId,
      subjectId: identity.subjectId,
      state: 'proposed',
      nodes: orderedNodes,
      edges,
      order,
      readOnly,
      mutating: !readOnly,
      requiresApproval,
    };
    if (source.label !== undefined) plan.label = requireString(source.label, 'label', 300);
    if (source.goal !== undefined) plan.goal = requireString(source.goal, 'goal', 2000);
    if (source.metadata !== undefined) plan.metadata = jsonClone(source.metadata);
    plan.planHash = hashPlan(plan);
    return jsonClone(plan);
  }

  // Aliases make this planner convenient for composition roots while all
  // exported operations retain the one-object contract.
  plan(input) {
    return this.propose(input);
  }

  build(input) {
    return this.propose(input);
  }

  #generatedWorkflowId(input) {
    if (this.idFactory) {
      const value = this.idFactory(input);
      return normalizeWorkflowId(value);
    }
    return `wf-${canonicalHash({
      tenantId: input.identity.tenantId,
      subjectId: input.identity.subjectId,
      revision: input.revision,
      nodes: input.nodes,
      goal: input.source.goal ?? null,
    }).slice(0, 16)}`;
  }

  #normalizeNode(rawNode, index, identity) {
    if (!rawNode || typeof rawNode !== 'object' || Array.isArray(rawNode)) {
      throw new CoreError('INVALID_PLAN', `Node ${index} must be an object`);
    }
    for (const key of Object.keys(rawNode)) {
      if (UNSAFE_NODE_KEYS.has(key.toLowerCase())) {
        throw new CoreError('UNSAFE_PLAN', `Node field ${key} is not allowed`);
      }
    }
    const id = rawNode.id ?? rawNode.nodeId;
    if (typeof id !== 'string' || !NODE_ID.test(id)) {
      throw new CoreError('INVALID_PLAN', `Node ${index} has an invalid id`);
    }
    const capabilityId = rawNode.capabilityId ?? rawNode.capability ?? rawNode.tool;
    if (typeof capabilityId !== 'string') {
      throw new CoreError('INVALID_PLAN', `Node ${id} must name a capabilityId`);
    }
    const version = rawNode.capabilityVersion ?? rawNode.version;
    let capability;
    try {
      capability = this.catalog.resolve({
        identity,
        capabilityId,
        ...(version === undefined ? {} : { version }),
      });
    } catch (error) {
      if (error instanceof CoreError) throw error;
      throw new CoreError('CAPABILITY_NOT_FOUND', `Capability ${capabilityId} could not be resolved`, { cause: error });
    }
    const args = rawNode.args ?? rawNode.arguments ?? {};
    if (!args || typeof args !== 'object' || Array.isArray(args)) {
      throw new CoreError('INVALID_PLAN', `Arguments for node ${id} must be an object`);
    }
    // Hash the exact canonical args used in approvals.  Clone now so a caller
    // cannot mutate a plan after it has been proposed.
    const clonedArgs = jsonClone(args);
    const dependsOn = normalizeDependencies(rawNode.dependsOn ?? rawNode.dependencies ?? rawNode.after, id);
    const readOnly = capability.readOnly;
    if (rawNode.readOnly !== undefined && rawNode.readOnly !== readOnly) {
      throw new CoreError('INVALID_PLAN', `Node ${id} readOnly disagrees with capability`);
    }
    if (rawNode.mutates !== undefined && rawNode.mutates !== !readOnly) {
      throw new CoreError('INVALID_PLAN', `Node ${id} mutates disagrees with capability`);
    }
    const adapter = normalizeAdapterChoice(rawNode.adapter ?? rawNode.adapterId, capability, id);
    const origin = normalizeOriginChoice(rawNode.origin, capability, id);
    const node = {
      id,
      capabilityId: capability.id,
      capabilityVersion: capability.version,
      args: clonedArgs,
      argumentHash: canonicalHash(clonedArgs),
      dependsOn,
      readOnly,
      mutates: !readOnly,
    };
    if (adapter !== undefined) node.adapter = adapter;
    if (origin !== undefined) node.origin = origin;
    if (rawNode.label !== undefined) node.label = requireString(rawNode.label, 'node.label', 300);
    if (rawNode.metadata !== undefined) node.metadata = jsonClone(rawNode.metadata);
    if (rawNode.timeoutMs !== undefined) {
      if (!Number.isInteger(rawNode.timeoutMs) || rawNode.timeoutMs < 1 || rawNode.timeoutMs > 86_400_000) {
        throw new CoreError('INVALID_PLAN', `Node ${id} timeoutMs is invalid`);
      }
      node.timeoutMs = rawNode.timeoutMs;
    }
    return node;
  }
}

export function validatePlan(input) {
  const operation = requireObject(input, 'validatePlan input');
  const identity = requireIdentity(operation);
  const plan = operation.plan;
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) throw new CoreError('INVALID_PLAN', 'plan must be an object');
  if (plan.tenantId !== identity.tenantId || plan.subjectId !== identity.subjectId) {
    throw new CoreError('WORKFLOW_FORBIDDEN', 'Plan identity does not match caller');
  }
  const workflowId = normalizeWorkflowId(plan.workflowId);
  const revision = normalizeRevision(plan.revision);
  if (!Array.isArray(plan.nodes) || plan.nodes.length === 0) throw new CoreError('INVALID_PLAN', 'Plan nodes are required');
  const nodes = plan.nodes.map((node, index) => normalizeStoredNode(node, index));
  assertUniqueNodeIds(nodes);
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const edges = [];
  for (const node of nodes) {
    for (const dependency of node.dependsOn) {
      if (!byId.has(dependency)) throw new CoreError('INVALID_PLAN', `Node ${node.id} depends on unknown node ${dependency}`);
      edges.push({ from: dependency, to: node.id });
    }
  }
  const order = topologicalOrder(nodes);
  const expected = {
    ...plan,
    workflowId,
    revision,
    nodes,
    edges,
    order,
    readOnly: nodes.every((node) => node.readOnly),
    mutating: nodes.some((node) => !node.readOnly),
    requiresApproval: nodes.filter((node) => !node.readOnly).map((node) => node.id),
  };
  if (plan.planHash !== undefined && plan.planHash !== hashPlan(expected)) {
    throw new CoreError('INVALID_PLAN', 'Plan hash does not match contents');
  }
  return jsonClone({ ...expected, planHash: hashPlan(expected) });
}

export function hashPlan(plan) {
  const copy = { ...plan };
  delete copy.planHash;
  delete copy.state;
  return canonicalHash(copy);
}

function normalizeStoredNode(rawNode, index) {
  if (!rawNode || typeof rawNode !== 'object' || Array.isArray(rawNode)) throw new CoreError('INVALID_PLAN', `Node ${index} is invalid`);
  for (const key of Object.keys(rawNode)) if (UNSAFE_NODE_KEYS.has(key.toLowerCase())) throw new CoreError('UNSAFE_PLAN', `Node field ${key} is not allowed`);
  if (typeof rawNode.id !== 'string' || !NODE_ID.test(rawNode.id)) throw new CoreError('INVALID_PLAN', `Node ${index} id is invalid`);
  if (typeof rawNode.capabilityId !== 'string') throw new CoreError('INVALID_PLAN', `Node ${rawNode.id} capabilityId is required`);
  if (typeof rawNode.capabilityVersion !== 'string') throw new CoreError('INVALID_PLAN', `Node ${rawNode.id} capabilityVersion is required`);
  if (typeof rawNode.readOnly !== 'boolean' || typeof rawNode.mutates !== 'boolean' || rawNode.mutates === rawNode.readOnly) throw new CoreError('INVALID_PLAN', `Node ${rawNode.id} mutability is invalid`);
  const args = rawNode.args;
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new CoreError('INVALID_PLAN', `Node ${rawNode.id} args are invalid`);
  const cloned = jsonClone(args);
  const argumentHash = canonicalHash(cloned);
  if (rawNode.argumentHash !== undefined && rawNode.argumentHash !== argumentHash) throw new CoreError('INVALID_PLAN', `Node ${rawNode.id} argument hash is invalid`);
  return {
    ...jsonClone(rawNode),
    args: cloned,
    argumentHash,
    dependsOn: normalizeDependencies(rawNode.dependsOn, rawNode.id),
  };
}

function topologicalOrder(nodes) {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const indegree = new Map(nodes.map((node) => [node.id, node.dependsOn.length]));
  const children = new Map(nodes.map((node) => [node.id, []]));
  for (const node of nodes) for (const dependency of node.dependsOn) {
    if (!byId.has(dependency)) throw new CoreError('INVALID_PLAN', `Unknown dependency ${dependency}`);
    children.get(dependency).push(node.id);
  }
  for (const list of children.values()) list.sort(compareIds);
  const ready = [...indegree.entries()].filter(([, value]) => value === 0).map(([id]) => id).sort(compareIds);
  const order = [];
  while (ready.length) {
    const id = ready.shift();
    order.push(id);
    for (const child of children.get(id)) {
      const next = indegree.get(child) - 1;
      indegree.set(child, next);
      if (next === 0) {
        ready.push(child);
        ready.sort(compareIds);
      }
    }
  }
  if (order.length !== nodes.length) throw new CoreError('PLAN_CYCLE', 'Plan dependencies contain a cycle');
  return order;
}

function assertUniqueNodeIds(nodes) {
  const ids = new Set();
  for (const node of nodes) {
    if (ids.has(node.id)) throw new CoreError('INVALID_PLAN', `Duplicate node id ${node.id}`);
    ids.add(node.id);
  }
}

function normalizeDependencies(value, nodeId) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new CoreError('INVALID_PLAN', `Node ${nodeId} dependencies must be an array`);
  const result = [];
  for (const dependency of value) {
    if (typeof dependency !== 'string' || !NODE_ID.test(dependency) || dependency === nodeId) {
      throw new CoreError('INVALID_PLAN', `Node ${nodeId} has an invalid dependency`);
    }
    if (result.includes(dependency)) throw new CoreError('INVALID_PLAN', `Node ${nodeId} repeats a dependency`);
    result.push(dependency);
  }
  return result.sort(compareIds);
}

function normalizeAdapterChoice(value, capability, nodeId) {
  if (value === undefined) return capability.adapters[0]?.id;
  const adapter = typeof value === 'string' ? value : value?.id ?? value?.adapterId;
  if (typeof adapter !== 'string' || !adapter) throw new CoreError('INVALID_PLAN', `Node ${nodeId} adapter is invalid`);
  if (capability.adapters.length && !capability.adapters.some((entry) => entry.id === adapter)) {
    throw new CoreError('ADAPTER_NOT_ALLOWED', `Adapter ${adapter} is not allowed for node ${nodeId}`);
  }
  return adapter;
}

function normalizeOriginChoice(value, capability, nodeId) {
  if (value === undefined) return capability.origins[0];
  if (typeof value !== 'string' || !value) throw new CoreError('INVALID_PLAN', `Node ${nodeId} origin is invalid`);
  if (capability.origins.length && !capability.origins.includes(value)) {
    throw new CoreError('ORIGIN_NOT_ALLOWED', `Origin ${value} is not allowed for node ${nodeId}`);
  }
  return value;
}

function normalizeWorkflowId(value) {
  if (typeof value !== 'string' || !WORKFLOW_ID.test(value)) throw new CoreError('INVALID_WORKFLOW', 'workflowId is invalid');
  return value;
}

function normalizeRevision(value) {
  const revision = value ?? 1;
  if (!Number.isInteger(revision) || revision < 1 || revision > 2_147_483_647) throw new CoreError('INVALID_WORKFLOW', 'revision must be a positive integer');
  return revision;
}

function requireString(value, field, max) {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) throw new CoreError('INVALID_PLAN', `${field} is invalid`);
  return value;
}

function compareIds(left, right) {
  return left.localeCompare(right);
}

function requireObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CoreError('INVALID_INPUT', `${label} must be an object`);
  return value;
}
