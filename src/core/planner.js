import { CoreError } from './errors.js';
import { requireIdentity } from './identity.js';
import { canonicalHash, jsonClone, stableStringify } from './serialization.js';
import { assertCapabilitySchemas, assertSchemaValue } from './schema.js';

const NODE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const WORKFLOW_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+\-]{0,199}$/;
const UNSAFE_NODE_KEYS = new Set([
  'code', 'command', 'eval', 'evaluate', 'exec', 'execute', 'function',
  'javascript', 'raw', 'script', 'shell', 'shellcommand', 'source',
]);

export const MAX_PLAN_NODES = 128;
export const MAX_NODE_DEPENDENCIES = 32;
export const MAX_TOTAL_DEPENDENCIES = 1_024;
export const MAX_PLAN_INPUT_BYTES = 512 * 1_024;
export const MAX_PLAN_DEPTH = 32;
export const MAX_PLAN_VALUES = 20_000;

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
    assertPlanInputBounds(operation);

    const nodes = rawNodes.map((rawNode, index) => this.#normalizeNode(rawNode, index, identity));
    const workflowId = requestedWorkflowId === undefined
      ? this.#generatedWorkflowId({ identity, revision, nodes, source })
      : normalizeWorkflowId(requestedWorkflowId);
    assertUniqueNodeIds(nodes);
    assertTotalDependencies(nodes);
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
      id: workflowId,
      revision,
      tenantId: identity.tenantId,
      subjectId: identity.subjectId,
      subject: identity.subjectId,
      state: 'proposed',
      status: 'proposed',
      nodes: orderedNodes,
      edges,
      order,
      readOnly,
      mutating: !readOnly,
      requiresApproval,
    };
    if (source.label !== undefined) plan.label = requireString(source.label, 'label', 300);
    if (source.goal !== undefined) plan.goal = requireString(source.goal, 'goal', 2000);
    if (source.origin !== undefined) plan.origin = requireString(source.origin, 'origin', 2048);
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
    let schemas;
    try {
      schemas = assertCapabilitySchemas({ capability, label: `Capability ${capabilityId}` });
    } catch (error) {
      if (error instanceof CoreError) {
        throw new CoreError('INVALID_PLAN', `Capability ${capabilityId} has invalid schemas`, {
          retryable: false,
          details: { reason: 'CAPABILITY_SCHEMA_INVALID', cause: error.toJSON() },
          cause: error,
        });
      }
      throw new CoreError('INVALID_PLAN', `Capability ${capabilityId} has invalid schemas`, { cause: error });
    }
    const args = rawNode.args ?? rawNode.arguments ?? {};
    if (!args || typeof args !== 'object' || Array.isArray(args)) {
      throw new CoreError('INVALID_PLAN', `Arguments for node ${id} must be an object`);
    }
    // Hash the exact canonical args used in approvals.  Clone now so a caller
    // cannot mutate a plan after it has been proposed.
    const clonedArgs = jsonClone(args);
    assertSchemaValue({
      value: clonedArgs,
      schema: schemas.inputSchema,
      code: 'INVALID_PLAN',
      reason: 'ARGUMENT_SCHEMA_INVALID',
      label: `Arguments for node ${id}`,
      message: `Arguments for node ${id} do not match the capability input schema`,
    });
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
      nodeId: id,
      capabilityId: capability.id,
      capabilityVersion: capability.version,
      capabilityBindingHash: capabilityBindingHash(capability),
      operation: capability.id,
      args: clonedArgs,
      argumentHash: canonicalHash(clonedArgs),
      dependsOn,
      readOnly,
      mutates: !readOnly,
      mode: readOnly ? 'read' : 'mutation',
      kind: readOnly ? 'read' : 'mutation',
      requiresApproval: !readOnly,
    };
    if (adapter !== undefined) {
      node.adapter = adapter;
      node.adapterId = adapter;
    }
    if (origin !== undefined) node.origin = origin;
    if (rawNode.label !== undefined) node.label = requireString(rawNode.label, 'node.label', 300);
    if (rawNode.metadata !== undefined) node.metadata = jsonClone(rawNode.metadata);
    if (rawNode.timeoutMs !== undefined) {
      if (!Number.isInteger(rawNode.timeoutMs) || rawNode.timeoutMs < 1 || rawNode.timeoutMs > 86_400_000) {
        throw new CoreError('INVALID_PLAN', `Node ${id} timeoutMs is invalid`);
      }
      if (!readOnly) {
        throw new CoreError(
          'INVALID_PLAN',
          `Mutation node ${id} cannot use a non-cancelling in-process timeout`,
        );
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
  assertPlanInputBounds(plan);
  if (typeof plan.planHash !== 'string' || !/^[a-f0-9]{64}$/.test(plan.planHash)) {
    throw new CoreError('INVALID_PLAN', 'Plan integrity hash is required');
  }
  if (plan.tenantId !== identity.tenantId || plan.subjectId !== identity.subjectId) {
    throw new CoreError('WORKFLOW_FORBIDDEN', 'Plan identity does not match caller');
  }
  const workflowId = normalizeWorkflowId(plan.workflowId);
  const revision = normalizeRevision(plan.revision);
  if (!Array.isArray(plan.nodes) || plan.nodes.length === 0) throw new CoreError('INVALID_PLAN', 'Plan nodes are required');
  const nodes = plan.nodes.map((node, index) => normalizeStoredNode(node, index));
  assertUniqueNodeIds(nodes);
  assertTotalDependencies(nodes);
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
  if (plan.planHash !== hashPlan(expected)) {
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

/**
 * Hash only the capability fields that affect execution authorization.  The
 * hash is stored on each planned node so a same-version catalog replacement
 * cannot silently change mutability, routing, origin, schemas, or risk after
 * approval.  Display-only fields such as name and description deliberately do
 * not participate in this binding.
 */
export function capabilityBindingHash(capability) {
  if (!capability || typeof capability !== 'object' || Array.isArray(capability)) {
    throw new CoreError('INVALID_CAPABILITY', 'Capability binding must be an object');
  }
  return canonicalHash({
    id: capability.id,
    version: capability.version,
    readOnly: capability.readOnly === true,
    mutates: capability.mutates === undefined ? capability.readOnly !== true : capability.mutates === true,
    requiresApproval: capability.requiresApproval === undefined
      ? capability.readOnly !== true
      : capability.requiresApproval === true,
    adapters: normalizeBindingAdapters(capability.adapters ?? capability.adapter),
    origins: normalizeBindingOrigins(capability.origins ?? capability.origin),
    inputSchema: capability.inputSchema ?? {},
    outputSchema: capability.outputSchema ?? {},
    risk: capability.risk ?? null,
  });
}

function normalizeBindingAdapters(value) {
  const list = value === undefined ? [] : Array.isArray(value) ? value : [value];
  return list.map((entry) => {
    if (typeof entry === 'string') return { id: entry, kind: null, version: null };
    return {
      id: entry?.id ?? entry?.adapterId ?? entry?.name ?? null,
      kind: entry?.kind ?? null,
      version: entry?.version ?? null,
    };
  }).sort((left, right) => left.id.localeCompare(right.id) ||
    String(left.version).localeCompare(String(right.version)) ||
    String(left.kind).localeCompare(String(right.kind)));
}

function normalizeBindingOrigins(value) {
  const list = value === undefined ? [] : Array.isArray(value) ? value : [value];
  return [...new Set(list.filter((entry) => typeof entry === 'string'))].sort((left, right) => left.localeCompare(right));
}

function normalizeStoredNode(rawNode, index) {
  if (!rawNode || typeof rawNode !== 'object' || Array.isArray(rawNode)) throw new CoreError('INVALID_PLAN', `Node ${index} is invalid`);
  for (const key of Object.keys(rawNode)) if (UNSAFE_NODE_KEYS.has(key.toLowerCase())) throw new CoreError('UNSAFE_PLAN', `Node field ${key} is not allowed`);
  // Aliases are accepted only at the untrusted proposal boundary.  Persisted
  // plans are canonical and must contain `dependsOn`; otherwise an attacker
  // who can rewrite/re-hash storage could leave an ignored alias that changes
  // the apparent graph without changing execution order.
  if (Object.prototype.hasOwnProperty.call(rawNode, 'dependencies') || Object.prototype.hasOwnProperty.call(rawNode, 'after')) {
    throw new CoreError('INVALID_PLAN', `Stored node ${rawNode.id ?? index} contains a non-canonical dependency alias`);
  }
  if (typeof rawNode.id !== 'string' || !NODE_ID.test(rawNode.id)) throw new CoreError('INVALID_PLAN', `Node ${index} id is invalid`);
  if (typeof rawNode.capabilityId !== 'string') throw new CoreError('INVALID_PLAN', `Node ${rawNode.id} capabilityId is required`);
  if (typeof rawNode.capabilityVersion !== 'string') throw new CoreError('INVALID_PLAN', `Node ${rawNode.id} capabilityVersion is required`);
  if (typeof rawNode.capabilityBindingHash !== 'string' || !/^[a-f0-9]{64}$/.test(rawNode.capabilityBindingHash)) {
    throw new CoreError('INVALID_PLAN', `Node ${rawNode.id} capability binding hash is required`);
  }
  if (typeof rawNode.readOnly !== 'boolean' || typeof rawNode.mutates !== 'boolean' || rawNode.mutates === rawNode.readOnly) throw new CoreError('INVALID_PLAN', `Node ${rawNode.id} mutability is invalid`);
  if (rawNode.timeoutMs !== undefined) {
    if (!Number.isInteger(rawNode.timeoutMs) || rawNode.timeoutMs < 1 || rawNode.timeoutMs > 86_400_000) {
      throw new CoreError('INVALID_PLAN', `Node ${rawNode.id} timeoutMs is invalid`);
    }
    if (!rawNode.readOnly) {
      throw new CoreError('INVALID_PLAN', `Mutation node ${rawNode.id} cannot use a non-cancelling in-process timeout`);
    }
  }
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
  if (value.length > MAX_NODE_DEPENDENCIES) {
    throw new CoreError('PLAN_LIMIT_EXCEEDED', `Node ${nodeId} exceeds the dependency limit`);
  }
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

function assertTotalDependencies(nodes) {
  const total = nodes.reduce((count, node) => count + node.dependsOn.length, 0);
  if (total > MAX_TOTAL_DEPENDENCIES) {
    throw new CoreError('PLAN_LIMIT_EXCEEDED', 'Plan exceeds the aggregate dependency limit');
  }
}

/**
 * Bound a plan before cloning, hashing, or graph work.  Transport limits alone
 * are insufficient: thousands of tiny nodes fit inside a one-MiB JSON frame
 * and can otherwise amplify into large maps, hashes, and sort work.
 */
export function assertPlanInputBounds(value) {
  const stack = [{ value, depth: 0, path: '$' }];
  let values = 0;
  while (stack.length) {
    const current = stack.pop();
    values += 1;
    if (values > MAX_PLAN_VALUES) {
      throw new CoreError('PLAN_LIMIT_EXCEEDED', 'Plan contains too many JSON values');
    }
    if (current.depth > MAX_PLAN_DEPTH) {
      throw new CoreError('PLAN_LIMIT_EXCEEDED', 'Plan nesting is too deep');
    }
    const item = current.value;
    if (item === null || typeof item !== 'object') continue;
    const prototype = Object.getPrototypeOf(item);
    if (!Array.isArray(item) && prototype !== Object.prototype && prototype !== null) {
      throw new CoreError('INVALID_PLAN', `Plan value at ${current.path} must be plain JSON`);
    }
    const descriptors = Object.getOwnPropertyDescriptors(item);
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (Array.isArray(item) && key === 'length') continue;
      if (!Object.prototype.hasOwnProperty.call(descriptor, 'value') || descriptor.enumerable !== true) {
        throw new CoreError('INVALID_PLAN', `Plan value at ${current.path}.${key} must be plain JSON data`);
      }
      const child = descriptor.value;
      if ((key === 'nodes' || key === 'steps') && Array.isArray(child) && child.length > MAX_PLAN_NODES) {
        throw new CoreError('PLAN_LIMIT_EXCEEDED', `Plan may contain at most ${MAX_PLAN_NODES} nodes`);
      }
      if ((key === 'dependsOn' || key === 'dependencies' || key === 'after') &&
          Array.isArray(child) && child.length > MAX_NODE_DEPENDENCIES) {
        throw new CoreError('PLAN_LIMIT_EXCEEDED', `A node may contain at most ${MAX_NODE_DEPENDENCIES} dependencies`);
      }
      stack.push({ value: child, depth: current.depth + 1, path: `${current.path}.${key}` });
    }
  }
  let serialized;
  try {
    serialized = stableStringify(value);
  } catch (error) {
    if (error instanceof CoreError) throw error;
    throw new CoreError('INVALID_PLAN', 'Plan must be canonical JSON', { cause: error });
  }
  if (Buffer.byteLength(serialized, 'utf8') > MAX_PLAN_INPUT_BYTES) {
    throw new CoreError('PLAN_LIMIT_EXCEEDED', `Plan input exceeds ${MAX_PLAN_INPUT_BYTES} bytes`);
  }
  return true;
}

function normalizeAdapterChoice(value, capability, nodeId) {
  const selected = selectTrustedAdapter(capability.adapters);
  if (value === undefined) return selected?.id;
  const requested = typeof value === 'string' ? value : value?.id ?? value?.adapterId;
  if (typeof requested !== 'string' || !requested) {
    throw new CoreError('INVALID_PLAN', `Node ${nodeId} adapter is invalid`);
  }
  if (!selected) {
    throw new CoreError('ADAPTER_NOT_ALLOWED', `Capability ${capability.id} has no server-approved adapter`);
  }
  if (requested !== selected.id) {
    throw new CoreError(
      'ADAPTER_DOWNGRADE_FORBIDDEN',
      `Node ${nodeId} must use the server-selected adapter ${selected.id}`,
    );
  }
  return selected.id;
}

const ADAPTER_PRIORITY = Object.freeze({
  'structured-api': 0,
  webmcp: 1,
  'dom-accessibility': 2,
  vision: 3,
});

/**
 * Adapter routing is a server-owned security decision.  Catalog order and a
 * client-supplied adapter id must never be able to downgrade a structured
 * route to DOM/vision.  Unknown integration kinds sort after the fixed trust
 * ladder and are selected deterministically by id.
 */
function selectTrustedAdapter(adapters) {
  if (!Array.isArray(adapters) || adapters.length === 0) return undefined;
  return [...adapters].sort((left, right) => {
    const priority = adapterPriority(left) - adapterPriority(right);
    if (priority !== 0) return priority;
    return left.id.localeCompare(right.id) || String(left.version ?? '').localeCompare(String(right.version ?? ''));
  })[0];
}

function adapterPriority(adapter) {
  const explicitKind = normalizeAdapterKind(adapter?.kind);
  if (explicitKind !== undefined) return explicitKind;
  const inferredKind = inferAdapterKind(adapter?.id);
  return inferredKind === undefined ? Number.MAX_SAFE_INTEGER : inferredKind;
}

function normalizeAdapterKind(value) {
  if (typeof value !== 'string') return undefined;
  return ADAPTER_PRIORITY[value.trim().toLowerCase().replace(/[_.\s]+/g, '-')];
}

function inferAdapterKind(value) {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  if (/(?:^|[._:/-])(?:structured|api)(?:$|[._:/-])/.test(normalized)) return ADAPTER_PRIORITY['structured-api'];
  if (/(?:^|[._:/-])webmcp(?:$|[._:/-])/.test(normalized)) return ADAPTER_PRIORITY.webmcp;
  if (/(?:^|[._:/-])(?:dom|accessibility|a11y)(?:$|[._:/-])/.test(normalized)) return ADAPTER_PRIORITY['dom-accessibility'];
  if (/(?:^|[._:/-])vision(?:$|[._:/-])/.test(normalized)) return ADAPTER_PRIORITY.vision;
  return undefined;
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
