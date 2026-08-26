import { CoreError, errorShape } from './errors.js';
import { requireIdentity, sameIdentity, identityKey } from './identity.js';
import { jsonClone } from './serialization.js';
import { validatePlan } from './planner.js';

export const WORKFLOW_STATES = Object.freeze([
  'draft', 'proposed', 'running', 'awaiting_approval', 'completed', 'failed', 'cancelled',
]);

export const NODE_STATES = Object.freeze([
  'pending', 'running', 'awaiting_approval', 'completed', 'failed', 'cancelled',
]);

const TRANSITIONS = Object.freeze({
  draft: new Set(['proposed', 'cancelled']),
  proposed: new Set(['running', 'failed', 'cancelled']),
  running: new Set(['awaiting_approval', 'completed', 'failed', 'cancelled']),
  awaiting_approval: new Set(['running', 'failed', 'cancelled']),
  completed: new Set(),
  failed: new Set(),
  cancelled: new Set(),
});

const NODE_TRANSITIONS = Object.freeze({
  pending: new Set(['running', 'awaiting_approval', 'cancelled']),
  running: new Set(['completed', 'failed', 'awaiting_approval', 'cancelled']),
  awaiting_approval: new Set(['running', 'failed', 'cancelled']),
  completed: new Set(),
  failed: new Set(),
  cancelled: new Set(),
});

const WORKFLOW_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+\-]{0,199}$/;

/**
 * Identity-keyed in-memory workflow persistence and state machine.
 *
 * The store never looks up a workflow by id alone.  Every read or write must
 * carry tenantId and subjectId, which prevents accidental cross-tenant access
 * when a caller reuses an id supplied by an untrusted provider.
 */
export class WorkflowStore {
  #records = new Map();
  #sequence = 0;

  constructor(options = {}) {
    if (!options || typeof options !== 'object' || Array.isArray(options)) throw new CoreError('INVALID_WORKFLOW_STORE', 'Store options must be an object');
    this.clock = typeof options.clock === 'function' ? options.clock : () => new Date().toISOString();
    this.idFactory = typeof options.idFactory === 'function' ? options.idFactory : undefined;
    this.maxHistory = options.maxHistory === undefined ? 500 : normalizePositiveInt(options.maxHistory, 'maxHistory', 10_000);
  }

  create(input) {
    const operation = requireObject(input, 'create input');
    const identity = requireIdentity(operation);
    const workflowId = normalizeWorkflowId(operation.workflowId ?? this.#newWorkflowId(identity));
    const revision = normalizeRevision(operation.revision);
    const key = workflowKey({ identity, workflowId, revision });
    if (this.#records.has(key)) throw new CoreError('WORKFLOW_CONFLICT', 'Workflow revision already exists');
    const now = this.#now();
    const record = {
      workflowId,
      revision,
      tenantId: identity.tenantId,
      subjectId: identity.subjectId,
      state: 'draft',
      plan: null,
      nodeStates: {},
      awaitingApproval: null,
      result: null,
      error: null,
      history: [{ at: now, type: 'created', state: 'draft' }],
      createdAt: now,
      updatedAt: now,
    };
    this.#records.set(key, record);
    if (operation.plan !== undefined) {
      return this.propose({ identity, workflowId, revision, plan: operation.plan });
    }
    return this.#public(record);
  }

  propose(input) {
    const operation = requireObject(input, 'propose input');
    const identity = requireIdentity(operation);
    const plan = validatePlan({ identity, plan: operation.plan });
    const workflowId = normalizeWorkflowId(operation.workflowId ?? plan.workflowId);
    const revision = normalizeRevision(operation.revision ?? plan.revision);
    if (plan.workflowId !== workflowId || plan.revision !== revision) throw new CoreError('INVALID_WORKFLOW', 'Plan workflow identity does not match request');
    const key = workflowKey({ identity, workflowId, revision });
    let record = this.#records.get(key);
    if (!record) {
      this.create({ identity, workflowId, revision });
      record = this.#records.get(key);
    }
    this.#assertOwner(record, identity);
    if (record.state !== 'draft') throw new CoreError('WORKFLOW_STATE', 'Only draft workflows can be proposed');
    record.plan = jsonClone(plan);
    record.nodeStates = Object.fromEntries(plan.nodes.map((node) => [node.id, {
      nodeId: node.id,
      state: 'pending',
      output: null,
      error: null,
      startedAt: null,
      completedAt: null,
      attempts: 0,
    }]));
    this.#transitionRecord(record, 'proposed', { type: 'proposed' });
    return this.#public(record);
  }

  get(input) {
    const operation = requireObject(input, 'get input');
    const identity = requireIdentity(operation);
    const workflowId = normalizeWorkflowId(operation.workflowId);
    const revision = normalizeRevision(operation.revision);
    const record = this.#records.get(workflowKey({ identity, workflowId, revision }));
    if (!record) throw new CoreError('WORKFLOW_NOT_FOUND', 'Workflow was not found');
    return this.#public(record);
  }

  status(input) {
    return this.get(input);
  }

  list(input) {
    const operation = requireObject(input, 'list input');
    const identity = requireIdentity(operation);
    const records = [];
    for (const record of this.#records.values()) {
      if (record.tenantId === identity.tenantId && record.subjectId === identity.subjectId) records.push(this.#public(record));
    }
    records.sort((left, right) => left.workflowId.localeCompare(right.workflowId) || left.revision - right.revision);
    return { workflows: records };
  }

  transition(input) {
    const operation = requireObject(input, 'transition input');
    const identity = requireIdentity(operation);
    const record = this.#ownedRecord(operation, identity);
    const target = operation.to ?? operation.state;
    if (typeof target !== 'string' || !WORKFLOW_STATES.includes(target)) throw new CoreError('INVALID_WORKFLOW_STATE', 'Unknown workflow state');
    this.#transitionRecord(record, target, {
      type: 'transition',
      reason: operation.reason === undefined ? undefined : requireReason(operation.reason),
    });
    return this.#public(record);
  }

  start(input) {
    const operation = requireObject(input, 'start input');
    return this.transition({ ...operation, to: 'running' });
  }

  markNode(input) {
    const operation = requireObject(input, 'markNode input');
    const identity = requireIdentity(operation);
    const record = this.#ownedRecord(operation, identity);
    if (!['running', 'awaiting_approval'].includes(record.state)) {
      throw new CoreError('WORKFLOW_STATE', 'Nodes can only change while a workflow is running');
    }
    const nodeId = requireNodeId(operation.nodeId);
    const current = record.nodeStates[nodeId];
    if (!current) throw new CoreError('NODE_NOT_FOUND', 'Workflow node was not found');
    const target = operation.state;
    if (typeof target !== 'string' || !NODE_STATES.includes(target)) throw new CoreError('INVALID_NODE_STATE', 'Unknown node state');
    if (!NODE_TRANSITIONS[current.state].has(target)) throw new CoreError('NODE_STATE', `Cannot move node from ${current.state} to ${target}`);
    if (target === 'completed' && operation.output === undefined) {
      // A read-only node can legitimately return null, but completion still
      // needs an explicit output field so accidental omission is detectable.
      throw new CoreError('INVALID_NODE_RESULT', 'Completed nodes require an output value');
    }
    if (operation.output !== undefined) current.output = jsonClone(operation.output);
    if (operation.error !== undefined) current.error = errorShape(operation.error, { code: 'NODE_FAILED', message: 'Node failed' });
    if (target === 'running') {
      current.attempts += 1;
      current.startedAt = this.#now();
      current.error = null;
    }
    if (target === 'completed' || target === 'failed' || target === 'cancelled') current.completedAt = this.#now();
    current.state = target;
    this.#event(record, {
      at: this.#now(),
      type: 'node_state',
      nodeId,
      state: target,
    });
    return this.#public(record);
  }

  awaitApproval(input) {
    const operation = requireObject(input, 'awaitApproval input');
    const identity = requireIdentity(operation);
    const record = this.#ownedRecord(operation, identity);
    if (record.state !== 'running') throw new CoreError('WORKFLOW_STATE', 'Approval can only be requested by a running workflow');
    const nodeId = requireNodeId(operation.nodeId);
    const node = record.plan?.nodes.find((entry) => entry.id === nodeId);
    if (!node) throw new CoreError('NODE_NOT_FOUND', 'Workflow node was not found');
    if (node.readOnly) throw new CoreError('APPROVAL_NOT_REQUIRED', 'Read-only nodes cannot await mutation approval');
    const current = record.nodeStates[nodeId];
    if (!['pending', 'running'].includes(current.state)) throw new CoreError('NODE_STATE', 'Node is not awaiting execution');
    if (current.state === 'running') {
      current.state = 'awaiting_approval';
    } else {
      current.state = 'awaiting_approval';
    }
    record.awaitingApproval = {
      nodeId,
      ...(operation.request === undefined ? {} : jsonClone(operation.request)),
    };
    if (record.state === 'running') this.#transitionRecord(record, 'awaiting_approval', { type: 'approval_required', nodeId });
    else this.#event(record, { at: this.#now(), type: 'approval_required', nodeId });
    return this.#public(record);
  }

  resume(input) {
    const operation = requireObject(input, 'resume input');
    const identity = requireIdentity(operation);
    const record = this.#ownedRecord(operation, identity);
    if (record.state !== 'awaiting_approval') throw new CoreError('WORKFLOW_STATE', 'Workflow is not awaiting approval');
    this.#transitionRecord(record, 'running', { type: 'approval_resumed', nodeId: operation.nodeId });
    record.awaitingApproval = null;
    return this.#public(record);
  }

  complete(input) {
    const operation = requireObject(input, 'complete input');
    const identity = requireIdentity(operation);
    const record = this.#ownedRecord(operation, identity);
    if (record.state !== 'running') throw new CoreError('WORKFLOW_STATE', 'Only running workflows can complete');
    const incomplete = Object.values(record.nodeStates).filter((node) => node.state !== 'completed');
    if (incomplete.length) throw new CoreError('WORKFLOW_INCOMPLETE', 'Cannot complete a workflow with incomplete nodes', { details: { nodes: incomplete.map((node) => node.nodeId) } });
    if (operation.result !== undefined) record.result = jsonClone(operation.result);
    this.#transitionRecord(record, 'completed', { type: 'completed' });
    return this.#public(record);
  }

  fail(input) {
    const operation = requireObject(input, 'fail input');
    const identity = requireIdentity(operation);
    const record = this.#ownedRecord(operation, identity);
    if (['completed', 'failed', 'cancelled'].includes(record.state)) throw new CoreError('WORKFLOW_STATE', 'Workflow is terminal');
    record.error = errorShape(operation.error, { code: 'WORKFLOW_FAILED', message: 'Workflow failed' });
    this.#transitionRecord(record, 'failed', { type: 'failed', error: record.error });
    return this.#public(record);
  }

  cancel(input) {
    const operation = requireObject(input, 'cancel input');
    const identity = requireIdentity(operation);
    const record = this.#ownedRecord(operation, identity);
    if (['completed', 'failed', 'cancelled'].includes(record.state)) throw new CoreError('WORKFLOW_STATE', 'Workflow is terminal');
    this.#transitionRecord(record, 'cancelled', { type: 'cancelled', reason: operation.reason === undefined ? undefined : requireReason(operation.reason) });
    for (const node of Object.values(record.nodeStates)) {
      if (!['completed', 'failed', 'cancelled'].includes(node.state)) node.state = 'cancelled';
    }
    return this.#public(record);
  }

  #ownedRecord(operation, identity) {
    const workflowId = normalizeWorkflowId(operation.workflowId);
    const revision = normalizeRevision(operation.revision);
    const record = this.#records.get(workflowKey({ identity, workflowId, revision }));
    if (!record) throw new CoreError('WORKFLOW_NOT_FOUND', 'Workflow was not found');
    this.#assertOwner(record, identity);
    return record;
  }

  #assertOwner(record, identity) {
    if (!sameIdentity(record, identity)) throw new CoreError('WORKFLOW_FORBIDDEN', 'Workflow is outside the caller identity');
  }

  #transitionRecord(record, target, event) {
    if (!WORKFLOW_STATES.includes(target)) throw new CoreError('INVALID_WORKFLOW_STATE', 'Unknown workflow state');
    if (record.state === target) return;
    if (!TRANSITIONS[record.state]?.has(target)) throw new CoreError('WORKFLOW_STATE', `Cannot move workflow from ${record.state} to ${target}`);
    if (target === 'proposed' && !record.plan) throw new CoreError('INVALID_WORKFLOW', 'A proposed workflow requires a plan');
    if (target === 'completed') {
      const incomplete = Object.values(record.nodeStates).some((node) => node.state !== 'completed');
      if (incomplete) throw new CoreError('WORKFLOW_INCOMPLETE', 'All nodes must complete before workflow completion');
    }
    const from = record.state;
    record.state = target;
    this.#event(record, { at: this.#now(), ...event, from, state: target });
  }

  #event(record, event) {
    const clean = {};
    for (const [key, value] of Object.entries(event)) {
      if (value !== undefined) clean[key] = jsonClone(value);
    }
    record.history.push(clean);
    if (record.history.length > this.maxHistory) record.history.splice(0, record.history.length - this.maxHistory);
    record.updatedAt = clean.at ?? this.#now();
  }

  #public(record) {
    return jsonClone(record);
  }

  #now() {
    const value = typeof this.clock === 'function' ? this.clock() : this.clock;
    if (value instanceof Date) return value.toISOString();
    if (typeof value === 'number' && Number.isFinite(value)) return new Date(value).toISOString();
    if (typeof value === 'string' && value.length) return value;
    throw new CoreError('INVALID_CLOCK', 'Workflow clock must return a timestamp');
  }

  #newWorkflowId(identity) {
    if (this.idFactory) return this.idFactory({ identity, sequence: this.#sequence + 1 });
    this.#sequence += 1;
    return `wf-${this.#sequence}`;
  }
}

export function workflowKey(input) {
  const operation = requireObject(input, 'workflowKey input');
  const identity = requireIdentity(operation.identity ?? operation);
  const workflowId = normalizeWorkflowId(operation.workflowId);
  const revision = normalizeRevision(operation.revision);
  return `${identityKey(identity)}:${encodeURIComponent(workflowId)}:${revision}`;
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

function requireNodeId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) throw new CoreError('INVALID_NODE', 'nodeId is invalid');
  return value;
}

function requireReason(value) {
  if (typeof value !== 'string' || value.length > 500) throw new CoreError('INVALID_INPUT', 'reason must be a string');
  return value;
}

function normalizePositiveInt(value, field, max) {
  if (!Number.isInteger(value) || value < 1 || value > max) throw new CoreError('INVALID_INPUT', `${field} must be a positive integer`);
  return value;
}

function requireObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CoreError('INVALID_INPUT', `${label} must be an object`);
  return value;
}
