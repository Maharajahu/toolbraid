import { CoreError, errorShape } from './errors.js';
import { requireIdentity, sameIdentity, identityKey } from './identity.js';
import { jsonClone, stableStringify } from './serialization.js';
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
 * The in-memory store is useful for local deployments, but it must still have
 * a finite admission budget.  These defaults are deliberately generous enough
 * for normal plans while keeping an accidentally shared process from growing
 * without bound.  Hosts with durable storage should set limits appropriate to
 * that store explicitly.
 */
export const DEFAULT_WORKFLOW_STORE_LIMITS = Object.freeze({
  maxRecords: 10_000,
  maxBytes: 256 * 1024 * 1024,
  maxRecordsPerTenant: 2_000,
  maxBytesPerTenant: 64 * 1024 * 1024,
  maxRecordsPerIdentity: 500,
  maxBytesPerIdentity: 16 * 1024 * 1024,
  maxRecordBytes: 4 * 1024 * 1024,
});

/**
 * Identity-keyed in-memory workflow persistence and state machine.
 *
 * The store never looks up a workflow by id alone.  Every read or write must
 * carry tenantId and subjectId, which prevents accidental cross-tenant access
 * when a caller reuses an id supplied by an untrusted provider.
 */
export class WorkflowStore {
  #records = new Map();
  #recordBytes = new Map();
  #globalBytes = 0;
  #tenantUsage = new Map();
  #identityUsage = new Map();
  #sequence = 0;

  constructor(options = {}) {
    if (!options || typeof options !== 'object' || Array.isArray(options)) throw new CoreError('INVALID_WORKFLOW_STORE', 'Store options must be an object');
    this.clock = typeof options.clock === 'function' ? options.clock : () => new Date().toISOString();
    this.idFactory = typeof options.idFactory === 'function' ? options.idFactory : undefined;
    this.maxHistory = options.maxHistory === undefined ? 500 : normalizePositiveInt(options.maxHistory, 'maxHistory', 10_000);
    this.maxRecords = quotaOption(options, ['maxRecords', 'maxWorkflowRecords'], 'maxRecords', DEFAULT_WORKFLOW_STORE_LIMITS.maxRecords);
    this.maxBytes = quotaOption(options, ['maxBytes', 'maxWorkflowBytes'], 'maxBytes', DEFAULT_WORKFLOW_STORE_LIMITS.maxBytes);
    this.maxRecordsPerTenant = quotaOption(
      options,
      ['maxRecordsPerTenant', 'maxTenantRecords', 'maxWorkflowsPerTenant'],
      'maxRecordsPerTenant',
      DEFAULT_WORKFLOW_STORE_LIMITS.maxRecordsPerTenant,
    );
    this.maxBytesPerTenant = quotaOption(
      options,
      ['maxBytesPerTenant', 'maxTenantBytes', 'maxWorkflowBytesPerTenant'],
      'maxBytesPerTenant',
      DEFAULT_WORKFLOW_STORE_LIMITS.maxBytesPerTenant,
    );
    this.maxRecordsPerIdentity = quotaOption(
      options,
      ['maxRecordsPerIdentity', 'maxIdentityRecords', 'maxWorkflowsPerIdentity'],
      'maxRecordsPerIdentity',
      DEFAULT_WORKFLOW_STORE_LIMITS.maxRecordsPerIdentity,
    );
    this.maxBytesPerIdentity = quotaOption(
      options,
      ['maxBytesPerIdentity', 'maxIdentityBytes', 'maxWorkflowBytesPerIdentity'],
      'maxBytesPerIdentity',
      DEFAULT_WORKFLOW_STORE_LIMITS.maxBytesPerIdentity,
    );
    this.maxRecordBytes = quotaOption(
      options,
      ['maxRecordBytes', 'maxBytesPerRecord', 'maxWorkflowRecordBytes'],
      'maxRecordBytes',
      DEFAULT_WORKFLOW_STORE_LIMITS.maxRecordBytes,
    );
  }

  create(input) {
    const operation = requireObject(input, 'create input');
    const identity = requireIdentity(operation);
    // Validate a supplied plan before allocating or retaining a draft.  In
    // particular, create({ plan }) must be atomic: an invalid or over-quota
    // proposal cannot leave behind a draft that consumes the caller's quota.
    const plan = operation.plan === undefined
      ? undefined
      : validatePlan({ identity, plan: operation.plan });
    const workflowId = normalizeWorkflowId(operation.workflowId ?? plan?.workflowId ?? this.#newWorkflowId(identity));
    const revision = normalizeRevision(operation.revision ?? plan?.revision);
    if (plan && (plan.workflowId !== workflowId || plan.revision !== revision)) {
      throw new CoreError('INVALID_WORKFLOW', 'Plan workflow identity does not match request');
    }
    const key = workflowKey({ identity, workflowId, revision });
    if (this.#records.has(key)) throw new CoreError('WORKFLOW_CONFLICT', 'Workflow revision already exists');
    let candidate = this.#newRecord({ identity, workflowId, revision });
    if (plan) candidate = this.#proposedRecord(candidate, plan);
    const stored = this.#commit(key, undefined, candidate);
    return this.#public(stored);
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
      record = this.#newRecord({ identity, workflowId, revision });
      const candidate = this.#proposedRecord(record, plan);
      const stored = this.#commit(key, undefined, candidate);
      return this.#public(stored);
    }
    this.#assertOwner(record, identity);
    if (record.state !== 'draft') throw new CoreError('WORKFLOW_STATE', 'Only draft workflows can be proposed');
    const candidate = this.#proposedRecord(record, plan);
    const stored = this.#commit(key, record, candidate);
    return this.#public(stored);
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
    const key = workflowKey({ identity, workflowId: record.workflowId, revision: record.revision });
    const target = operation.to ?? operation.state;
    if (typeof target !== 'string' || !WORKFLOW_STATES.includes(target)) throw new CoreError('INVALID_WORKFLOW_STATE', 'Unknown workflow state');
    const candidate = jsonClone(record);
    this.#transitionRecord(candidate, target, {
      type: 'transition',
      reason: operation.reason === undefined ? undefined : requireReason(operation.reason),
    });
    const stored = this.#commit(key, record, candidate);
    return this.#public(stored);
  }

  start(input) {
    const operation = requireObject(input, 'start input');
    return this.transition({ ...operation, to: 'running' });
  }

  markNode(input) {
    const operation = requireObject(input, 'markNode input');
    const identity = requireIdentity(operation);
    const record = this.#ownedRecord(operation, identity);
    const key = workflowKey({ identity, workflowId: record.workflowId, revision: record.revision });
    if (!['running', 'awaiting_approval'].includes(record.state)) {
      throw new CoreError('WORKFLOW_STATE', 'Nodes can only change while a workflow is running');
    }
    const nodeId = requireNodeId(operation.nodeId);
    const candidate = jsonClone(record);
    const current = candidate.nodeStates[nodeId];
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
    this.#event(candidate, {
      at: this.#now(),
      type: 'node_state',
      nodeId,
      state: target,
    });
    const stored = this.#commit(key, record, candidate);
    return this.#public(stored);
  }

  awaitApproval(input) {
    const operation = requireObject(input, 'awaitApproval input');
    const identity = requireIdentity(operation);
    const record = this.#ownedRecord(operation, identity);
    const key = workflowKey({ identity, workflowId: record.workflowId, revision: record.revision });
    if (record.state !== 'running') throw new CoreError('WORKFLOW_STATE', 'Approval can only be requested by a running workflow');
    const nodeId = requireNodeId(operation.nodeId);
    const node = record.plan?.nodes.find((entry) => entry.id === nodeId);
    if (!node) throw new CoreError('NODE_NOT_FOUND', 'Workflow node was not found');
    if (node.readOnly) throw new CoreError('APPROVAL_NOT_REQUIRED', 'Read-only nodes cannot await mutation approval');
    const candidate = jsonClone(record);
    const current = candidate.nodeStates[nodeId];
    if (!['pending', 'running', 'awaiting_approval'].includes(current.state)) throw new CoreError('NODE_STATE', 'Node is not awaiting execution');
    current.state = 'awaiting_approval';
    candidate.awaitingApproval = {
      nodeId,
      ...(operation.request === undefined ? {} : jsonClone(operation.request)),
    };
    if (candidate.state === 'running') this.#transitionRecord(candidate, 'awaiting_approval', { type: 'approval_required', nodeId });
    else this.#event(candidate, { at: this.#now(), type: 'approval_required', nodeId });
    const stored = this.#commit(key, record, candidate);
    return this.#public(stored);
  }

  resume(input) {
    const operation = requireObject(input, 'resume input');
    const identity = requireIdentity(operation);
    const record = this.#ownedRecord(operation, identity);
    const key = workflowKey({ identity, workflowId: record.workflowId, revision: record.revision });
    if (record.state !== 'awaiting_approval') throw new CoreError('WORKFLOW_STATE', 'Workflow is not awaiting approval');
    const nodeId = requireNodeId(operation.nodeId);
    if (record.awaitingApproval?.nodeId !== nodeId || record.nodeStates[nodeId]?.state !== 'awaiting_approval') {
      throw new CoreError('APPROVAL_BINDING_MISMATCH', 'Approval does not match the node awaiting approval');
    }
    const candidate = jsonClone(record);
    this.#transitionRecord(candidate, 'running', { type: 'approval_resumed', nodeId });
    candidate.awaitingApproval = null;
    const stored = this.#commit(key, record, candidate);
    return this.#public(stored);
  }

  complete(input) {
    const operation = requireObject(input, 'complete input');
    const identity = requireIdentity(operation);
    const record = this.#ownedRecord(operation, identity);
    const key = workflowKey({ identity, workflowId: record.workflowId, revision: record.revision });
    if (record.state !== 'running') throw new CoreError('WORKFLOW_STATE', 'Only running workflows can complete');
    const candidate = jsonClone(record);
    const incomplete = Object.values(candidate.nodeStates).filter((node) => node.state !== 'completed');
    if (incomplete.length) throw new CoreError('WORKFLOW_INCOMPLETE', 'Cannot complete a workflow with incomplete nodes', { details: { nodes: incomplete.map((node) => node.nodeId) } });
    if (operation.result !== undefined) candidate.result = jsonClone(operation.result);
    this.#transitionRecord(candidate, 'completed', { type: 'completed' });
    const stored = this.#commit(key, record, candidate);
    return this.#public(stored);
  }

  fail(input) {
    const operation = requireObject(input, 'fail input');
    const identity = requireIdentity(operation);
    const record = this.#ownedRecord(operation, identity);
    const key = workflowKey({ identity, workflowId: record.workflowId, revision: record.revision });
    if (['completed', 'failed', 'cancelled'].includes(record.state)) throw new CoreError('WORKFLOW_STATE', 'Workflow is terminal');
    const candidate = jsonClone(record);
    candidate.error = errorShape(operation.error, { code: 'WORKFLOW_FAILED', message: 'Workflow failed' });
    this.#transitionRecord(candidate, 'failed', { type: 'failed', error: candidate.error });
    const stored = this.#commit(key, record, candidate);
    return this.#public(stored);
  }

  cancel(input) {
    const operation = requireObject(input, 'cancel input');
    const identity = requireIdentity(operation);
    const record = this.#ownedRecord(operation, identity);
    const key = workflowKey({ identity, workflowId: record.workflowId, revision: record.revision });
    if (['completed', 'failed', 'cancelled'].includes(record.state)) throw new CoreError('WORKFLOW_STATE', 'Workflow is terminal');
    const candidate = jsonClone(record);
    this.#transitionRecord(candidate, 'cancelled', { type: 'cancelled', reason: operation.reason === undefined ? undefined : requireReason(operation.reason) });
    for (const node of Object.values(candidate.nodeStates)) {
      if (!['completed', 'failed', 'cancelled'].includes(node.state)) node.state = 'cancelled';
    }
    const stored = this.#commit(key, record, candidate);
    return this.#public(stored);
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

  #newRecord({ identity, workflowId, revision }) {
    const now = this.#now();
    return {
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
  }

  #proposedRecord(record, plan) {
    const candidate = jsonClone(record);
    candidate.plan = jsonClone(plan);
    candidate.nodeStates = Object.fromEntries(plan.nodes.map((node) => [node.id, {
      nodeId: node.id,
      state: 'pending',
      output: null,
      error: null,
      startedAt: null,
      completedAt: null,
      attempts: 0,
    }]));
    this.#transitionRecord(candidate, 'proposed', { type: 'proposed' });
    return candidate;
  }

  /**
   * Commit only a detached, quota-checked candidate.  All public mutators
   * construct a candidate first, so a quota failure leaves the prior record,
   * counters, and history untouched.
   */
  #commit(key, previous, candidate) {
    const clean = jsonClone(candidate);
    const bytes = serializedBytes(clean);
    const existing = this.#records.has(key);
    const previousBytes = existing
      ? this.#recordBytes.get(key) ?? serializedBytes(previous)
      : 0;
    const deltaBytes = bytes - previousBytes;
    this.#assertQuota(clean, bytes, deltaBytes, existing);

    this.#records.set(key, clean);
    this.#recordBytes.set(key, bytes);
    this.#globalBytes += deltaBytes;
    this.#adjustUsage(this.#tenantUsage, clean.tenantId, existing ? 0 : 1, deltaBytes);
    this.#adjustUsage(this.#identityUsage, identityKey(clean), existing ? 0 : 1, deltaBytes);
    return clean;
  }

  #assertQuota(record, bytes, deltaBytes, existing) {
    if (bytes > this.maxRecordBytes) {
      throw new CoreError('WORKFLOW_QUOTA_EXCEEDED', 'Workflow record exceeds its byte limit', {
        details: { scope: 'record.bytes', limit: this.maxRecordBytes, requested: bytes },
      });
    }
    if (!existing && this.#records.size + 1 > this.maxRecords) {
      throw new CoreError('WORKFLOW_QUOTA_EXCEEDED', 'Global workflow record limit reached', {
        details: { scope: 'global.records', limit: this.maxRecords, current: this.#records.size, requested: this.#records.size + 1 },
      });
    }
    if (this.#globalBytes + deltaBytes > this.maxBytes) {
      throw new CoreError('WORKFLOW_QUOTA_EXCEEDED', 'Global workflow byte limit reached', {
        details: { scope: 'global.bytes', limit: this.maxBytes, current: this.#globalBytes, requested: this.#globalBytes + deltaBytes },
      });
    }

    const tenant = this.#tenantUsage.get(record.tenantId) ?? EMPTY_USAGE;
    if (!existing && tenant.records + 1 > this.maxRecordsPerTenant) {
      throw new CoreError('WORKFLOW_QUOTA_EXCEEDED', 'Tenant workflow record limit reached', {
        details: { scope: 'tenant.records', tenantId: record.tenantId, limit: this.maxRecordsPerTenant, current: tenant.records, requested: tenant.records + 1 },
      });
    }
    if (tenant.bytes + deltaBytes > this.maxBytesPerTenant) {
      throw new CoreError('WORKFLOW_QUOTA_EXCEEDED', 'Tenant workflow byte limit reached', {
        details: { scope: 'tenant.bytes', tenantId: record.tenantId, limit: this.maxBytesPerTenant, current: tenant.bytes, requested: tenant.bytes + deltaBytes },
      });
    }

    const identity = identityKey(record);
    const owner = this.#identityUsage.get(identity) ?? EMPTY_USAGE;
    if (!existing && owner.records + 1 > this.maxRecordsPerIdentity) {
      throw new CoreError('WORKFLOW_QUOTA_EXCEEDED', 'Identity workflow record limit reached', {
        details: { scope: 'identity.records', limit: this.maxRecordsPerIdentity, current: owner.records, requested: owner.records + 1 },
      });
    }
    if (owner.bytes + deltaBytes > this.maxBytesPerIdentity) {
      throw new CoreError('WORKFLOW_QUOTA_EXCEEDED', 'Identity workflow byte limit reached', {
        details: { scope: 'identity.bytes', limit: this.maxBytesPerIdentity, current: owner.bytes, requested: owner.bytes + deltaBytes },
      });
    }
  }

  #adjustUsage(map, key, recordDelta, byteDelta) {
    const current = map.get(key) ?? { records: 0, bytes: 0 };
    map.set(key, {
      records: current.records + recordDelta,
      bytes: current.bytes + byteDelta,
    });
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

function quotaOption(options, names, field, fallback) {
  const supplied = names.find((name) => options[name] !== undefined);
  const value = supplied === undefined ? fallback : options[supplied];
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new CoreError('INVALID_WORKFLOW_STORE', `${field} must be a positive safe integer`);
  }
  return value;
}

function serializedBytes(value) {
  return Buffer.byteLength(stableStringify(value), 'utf8');
}

const EMPTY_USAGE = Object.freeze({ records: 0, bytes: 0 });

function requireObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CoreError('INVALID_INPUT', `${label} must be an object`);
  return value;
}
