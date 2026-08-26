import { createHash } from 'node:crypto';

import {
  FIXTURE_IDS,
  createFixtureDependencies,
} from './fixtures.js';

/** The only names that may be exposed through the MCP transport. */
export const PUBLIC_TOOL_NAMES = Object.freeze([
  'capabilities.search',
  'capabilities.describe',
  'plan.propose',
  'workflow.execute',
  'workflow.status',
  'workflow.replay_readonly',
]);

/**
 * MCP-facing metadata.  Schemas are intentionally conservative: the runtime
 * does the same validation for direct calls, so transport choice cannot become
 * a policy bypass.
 */
export const PUBLIC_TOOL_DEFINITIONS = Object.freeze([
  Object.freeze({
    name: 'capabilities.search',
    description: 'Search semantic capabilities available to an explicit tenant and subject.',
    inputSchema: {
      type: 'object',
      properties: {
        tenantId: { type: 'string' },
        subject: { type: 'string' },
        origin: { type: 'string' },
        query: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 100 },
      },
      required: ['tenantId', 'subject'],
      additionalProperties: false,
    },
  }),
  Object.freeze({
    name: 'capabilities.describe',
    description: 'Describe one semantic capability for an explicit tenant and subject.',
    inputSchema: {
      type: 'object',
      properties: {
        tenantId: { type: 'string' },
        subject: { type: 'string' },
        origin: { type: 'string' },
        capabilityId: { type: 'string' },
        id: { type: 'string' },
      },
      required: ['tenantId', 'subject'],
      additionalProperties: false,
    },
  }),
  Object.freeze({
    name: 'plan.propose',
    description: 'Create a reviewable workflow plan from semantic capabilities.',
    inputSchema: {
      type: 'object',
      properties: {
        tenantId: { type: 'string' },
        subject: { type: 'string' },
        origin: { type: 'string' },
        request: { type: 'object' },
        goal: { type: 'string' },
        nodes: { type: 'array' },
      },
      required: ['tenantId', 'subject'],
      additionalProperties: true,
    },
  }),
  Object.freeze({
    name: 'workflow.execute',
    description: 'Execute safe nodes and continue an approved workflow.',
    inputSchema: {
      type: 'object',
      properties: {
        tenantId: { type: 'string' },
        subject: { type: 'string' },
        workflowId: { type: 'string' },
        id: { type: 'string' },
        revision: { type: 'integer' },
      },
      required: ['tenantId', 'subject'],
      additionalProperties: true,
    },
  }),
  Object.freeze({
    name: 'workflow.status',
    description: 'Read workflow state and recorded outputs.',
    inputSchema: {
      type: 'object',
      properties: {
        tenantId: { type: 'string' },
        subject: { type: 'string' },
        workflowId: { type: 'string' },
        id: { type: 'string' },
      },
      required: ['tenantId', 'subject'],
      additionalProperties: true,
    },
  }),
  Object.freeze({
    name: 'workflow.replay_readonly',
    description: 'Replay only recorded read-only workflow nodes.',
    inputSchema: {
      type: 'object',
      properties: {
        tenantId: { type: 'string' },
        subject: { type: 'string' },
        workflowId: { type: 'string' },
        id: { type: 'string' },
      },
      required: ['tenantId', 'subject'],
      additionalProperties: true,
    },
  }),
]);

const PUBLIC_TOOL_SET = new Set(PUBLIC_TOOL_NAMES);
const UNSAFE_CAPABILITY_WORDS = /(?:^|[._:/-])(click|shell|exec|execute|javascript|eval|raw|cookie|filesystem|fs)(?:$|[._:/-])/i;
const SECRET_KEY = /(?:authorization|cookie|password|passwd|secret|token|api[_-]?key|private[_-]?key|credential|session)/i;

/**
 * Error type used at the composition boundary.  It deliberately has no stack
 * or provider details in toJSON(), keeping protocol responses JSON-safe.
 */
export class RuntimeError extends Error {
  constructor(code, message, options = {}) {
    super(String(message || code || 'Runtime operation failed'));
    this.name = 'RuntimeError';
    this.code = String(code || 'RUNTIME_ERROR');
    this.retryable = options.retryable === true;
    if (options.details !== undefined) this.details = cloneJson(options.details);
    if (options.cause !== undefined) this.cause = options.cause;
  }

  toJSON() {
    const value = {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
    };
    if (this.details !== undefined) value.details = cloneJson(this.details);
    return value;
  }
}

/**
 * Build the server's composition root.  Neighboring modules can be supplied
 * through options (catalog, planner, policy, approvals, audit, broker and
 * adapters).  The small in-memory implementations below are intentionally
 * complete, which also gives us a deterministic fixture mode for integration
 * tests and a useful local smoke server.
 */
export function createCompositionRoot(options = {}) {
  const fixtureRequested = options.fixture === true || options.fixtures === true;
  const fixture = fixtureRequested ? createFixtureDependencies(options) : null;
  const source = {
    ...(fixture || {}),
    ...(options.dependencies || {}),
    ...options,
  };

  const identity = normalizeIdentity(source.identity || {
    tenantId: source.tenantId,
    subject: source.subject,
    origin: source.origin,
  }, { allowMissing: true });
  const idFactory = typeof source.idFactory === 'function'
    ? source.idFactory
    : createSequenceIdFactory('workflow');
  const now = normalizeClock(source.now);
  const adapters = normalizeAdapters(source.adapters || source.adapter);
  const capabilityIndex = new Map();
  for (const capability of normalizeCapabilities(source.capabilities, adapters)) {
    if (!capability || !capability.id) continue;
    const normalized = normalizeCapability(capability, source.origin);
    capabilityIndex.set(normalized.id, normalized);
  }

  const workflows = new Map();
  const trustedApprovals = new Map();
  const auditRecords = [];
  const external = {
    catalog: source.catalog,
    planner: source.planner,
    workflow: source.workflow || source.workflowStore,
    broker: source.broker || source.executionBroker,
    policy: source.policy || source.policyEngine,
    approvals: source.approvals || source.approvalStore,
    audit: source.audit || source.auditLog,
    hasher: source.hasher || source.canonicalHasher,
  };

  const runtime = {
    identity,
    adapters,
    capabilityIndex,
    workflows,
    trustedApprovals,
    auditRecords,
    publicToolNames: PUBLIC_TOOL_NAMES,
    publicToolDefinitions: PUBLIC_TOOL_DEFINITIONS,

    capabilities: {
      search: (input) => searchCapabilities(input),
      describe: (input) => describeCapability(input),
    },
    plan: {
      propose: (input) => proposePlan(input),
    },
    workflow: {
      execute: (input) => executeWorkflow(input),
      status: (input) => workflowStatus(input),
      replayReadonly: (input) => replayReadonly(input),
      replay_readonly: (input) => replayReadonly(input),
    },

    /** Dispatch one of the six public semantic tools. */
    async callTool(name, input = {}) {
      if (!PUBLIC_TOOL_SET.has(name)) {
        throw new RuntimeError('TOOL_NOT_FOUND', `Unknown public tool: ${name}`, { details: { name } });
      }
      const operation = {
        'capabilities.search': searchCapabilities,
        'capabilities.describe': describeCapability,
        'plan.propose': proposePlan,
        'workflow.execute': executeWorkflow,
        'workflow.status': workflowStatus,
        'workflow.replay_readonly': replayReadonly,
      }[name];
      return operation(input || {});
    },
    dispatch(name, input = {}) {
      return runtime.callTool(name, input);
    },

    /**
     * Internal-only approval injection.  It is intentionally not included in
     * publicToolNames and the protocol dispatcher never calls this method.
     * A host may hold this closure server-side and pass in a separately
     * authenticated approval record.
     */
    async injectTrustedApproval(input = {}) {
      return injectTrustedApproval(input);
    },
    trustApproval(input = {}) {
      return injectTrustedApproval(input);
    },
    issueTrustedApproval(input = {}) {
      return injectTrustedApproval(input);
    },

    getAuditRecords() {
      return auditRecords.map((entry) => cloneJson(entry));
    },
    getWorkflow(workflowId) {
      const record = workflows.get(String(workflowId || ''));
      return record ? publicWorkflow(record) : undefined;
    },
  };

  return runtime;

  async function searchCapabilities(input = {}) {
    const request = assertRequestIdentity(input, identity);
    const query = String(input.query ?? input.q ?? input.text ?? '').trim().toLowerCase();
    const limit = boundedInteger(input.limit, 100, 1, 100);
    let result;

    if (external.catalog) {
      result = await invokeFirst(external.catalog, ['search', 'find', 'list'], [
        { ...cloneJson(input), ...request, query, limit },
      ]);
    }
    if (result === undefined) {
      const entries = [...capabilityIndex.values()]
        .filter((capability) => matchesOrigin(capability, request.origin))
        .filter((capability) => !query || capabilitySearchText(capability).includes(query))
        .sort((left, right) => left.id.localeCompare(right.id))
        .slice(0, limit)
        .map((capability) => cloneJson(capability));
      result = { query, capabilities: entries, items: entries, total: entries.length };
    }

    const payload = normalizeSearchResult(result, query);
    payload.tenantId = request.tenantId;
    payload.subject = request.subject;
    if (request.origin) payload.origin = request.origin;
    return cloneJson(payload);
  }

  async function describeCapability(input = {}) {
    const request = assertRequestIdentity(input, identity);
    const capabilityId = String(input.capabilityId || input.id || input.name || '').trim();
    if (!capabilityId) {
      throw new RuntimeError('INVALID_ARGUMENT', 'capabilityId is required', {
        details: { field: 'capabilityId' },
      });
    }
    let result;
    if (external.catalog) {
      result = await invokeFirst(external.catalog, ['describe', 'get', 'lookup'], [
        capabilityId,
        { ...cloneJson(input), ...request },
      ]);
      // Some catalogs use a single options object.
      if (result === undefined) {
        result = await invokeFirst(external.catalog, ['describe', 'get', 'lookup'], [{
          capabilityId,
          ...cloneJson(input),
          ...request,
        }]);
      }
    }
    if (result === undefined) result = capabilityIndex.get(capabilityId);
    if (result === undefined || result === null) {
      throw new RuntimeError('CAPABILITY_NOT_FOUND', `Capability not found: ${capabilityId}`, {
        details: { capabilityId },
      });
    }
    const normalized = normalizeCapability(result, request.origin);
    if (!matchesOrigin(normalized, request.origin)) {
      throw new RuntimeError('CAPABILITY_ORIGIN_MISMATCH', 'Capability is not available at the requested origin', {
        details: { capabilityId, origin: request.origin },
      });
    }
    return {
      ...cloneJson(normalized),
      tenantId: request.tenantId,
      subject: request.subject,
      ...(request.origin ? { origin: request.origin } : {}),
    };
  }

  async function proposePlan(input = {}) {
    const requestIdentity = assertRequestIdentity(input, identity);
    const request = normalizePlanRequest(input);
    let proposed;
    if (external.planner) {
      proposed = await invokeFirst(external.planner, ['propose', 'plan', 'createPlan'], [{
        ...cloneJson(input),
        ...requestIdentity,
        request,
      }]);
    }
    if (proposed === undefined) proposed = buildFallbackPlan(request, requestIdentity);
    const plan = normalizePlan(proposed, requestIdentity, request, (id) => capabilityIndex.get(id));
    const record = createWorkflowRecord(plan, requestIdentity, request, idFactory, now);
    workflows.set(record.workflowId, record);
    await appendAudit({
      event: 'workflow.plan.proposed',
      tenantId: record.tenantId,
      subject: record.subject,
      workflowId: record.workflowId,
      revision: record.revision,
      nodeCount: record.nodes.length,
    });
    return publicWorkflow(record);
  }

  async function executeWorkflow(input = {}) {
    const requestIdentity = assertRequestIdentity(input, identity);
    const workflowId = String(input.workflowId || input.id || '').trim();
    if (!workflowId) {
      throw new RuntimeError('INVALID_ARGUMENT', 'workflowId is required', {
        details: { field: 'workflowId' },
      });
    }
    const record = workflows.get(workflowId);
    if (!record) {
      throw new RuntimeError('WORKFLOW_NOT_FOUND', `Workflow not found: ${workflowId}`, {
        details: { workflowId },
      });
    }
    assertWorkflowIdentity(record, requestIdentity);
    if (input.revision !== undefined && Number(input.revision) !== record.revision) {
      throw new RuntimeError('WORKFLOW_REVISION_MISMATCH', 'Workflow revision does not match the proposed plan', {
        details: { expected: record.revision, received: Number(input.revision) },
      });
    }

    // A completed workflow is idempotent.  It must never run a mutation a
    // second time merely because workflow.execute was called again.
    if (record.status === 'completed') return executionResult(record, { idempotent: true });
    if (record.status === 'failed' || record.status === 'cancelled') {
      throw new RuntimeError('WORKFLOW_TERMINAL', `Workflow is ${record.status}`, {
        details: { workflowId, status: record.status },
      });
    }

    record.status = 'running';
    record.updatedAt = nowIso(now);
    while (record.cursor < record.nodes.length) {
      const node = record.nodes[record.cursor];
      const capability = capabilityIndex.get(node.capabilityId) || node;
      const readOnly = isReadOnlyNode(node, capability);
      if (UNSAFE_CAPABILITY_WORDS.test(String(node.capabilityId || node.operation || ''))) {
        return failWorkflow(record, new RuntimeError('CAPABILITY_NOT_ALLOWED', 'Raw or unsafe primitives are not executable', {
          details: { nodeId: node.nodeId, capabilityId: node.capabilityId },
        }));
      }
      if (node.origin && record.origin && node.origin !== record.origin) {
        return failWorkflow(record, new RuntimeError('ORIGIN_MISMATCH', 'Workflow node origin does not match the bound origin', {
          details: { nodeId: node.nodeId, origin: node.origin, expected: record.origin },
        }));
      }

      try {
        await evaluatePolicy({
          ...node,
          ...capability,
          tenantId: record.tenantId,
          subject: record.subject,
          workflowId: record.workflowId,
          revision: record.revision,
          origin: record.origin,
          readOnly,
        });
      } catch (error) {
        return failWorkflow(record, toRuntimeError(error, 'POLICY_DENIED', 'Policy denied workflow node'));
      }

      if (!readOnly) {
        const approval = findTrustedApproval(record, node);
        if (!approval) {
          record.status = 'awaiting_approval';
          record.updatedAt = nowIso(now);
          const approvalRequest = makeApprovalRequest(record, node);
          record.pendingApproval = approvalRequest;
          await appendAudit({
            event: 'workflow.approval.required',
            tenantId: record.tenantId,
            subject: record.subject,
            workflowId: record.workflowId,
            revision: record.revision,
            nodeId: node.nodeId,
            origin: record.origin,
            canonicalArgsHash: approvalRequest.canonicalArgsHash,
          });
          return executionResult(record, {
            approvalRequired: true,
            approvalRequest,
            error: {
              code: 'APPROVAL_REQUIRED',
              message: 'Trusted approval is required before this mutation can run',
              retryable: false,
              details: { nodeId: node.nodeId },
            },
          });
        }
        // Single-use is consumed before invoking the adapter.  If an adapter
        // fails, replaying the same approval cannot accidentally duplicate a
        // side effect.
        consumeTrustedApproval(approval);
      }

      try {
        const output = await invokeNode(node, record, { readOnly, capability });
        const recorded = {
          nodeId: node.nodeId,
          capabilityId: node.capabilityId,
          readOnly,
          mode: readOnly ? 'read' : 'mutation',
          output: redactSecrets(output),
          completedAt: nowIso(now),
        };
        record.outputs.push(recorded);
        if (readOnly) record.readonlyOutputs.push(recorded);
        node.status = 'completed';
        record.cursor += 1;
        record.updatedAt = nowIso(now);
        await appendAudit({
          event: readOnly ? 'workflow.node.read_completed' : 'workflow.node.mutation_completed',
          tenantId: record.tenantId,
          subject: record.subject,
          workflowId: record.workflowId,
          revision: record.revision,
          nodeId: node.nodeId,
          capabilityId: node.capabilityId,
          readOnly,
          output: redactSecrets(output),
        });
      } catch (error) {
        return failWorkflow(record, toRuntimeError(error, 'ADAPTER_EXECUTION_FAILED', 'Adapter execution failed'));
      }
    }

    record.status = 'completed';
    record.pendingApproval = undefined;
    record.completedAt = nowIso(now);
    record.updatedAt = record.completedAt;
    await appendAudit({
      event: 'workflow.completed',
      tenantId: record.tenantId,
      subject: record.subject,
      workflowId: record.workflowId,
      revision: record.revision,
    });
    return executionResult(record);
  }

  async function workflowStatus(input = {}) {
    const requestIdentity = assertRequestIdentity(input, identity);
    const workflowId = String(input.workflowId || input.id || '').trim();
    if (!workflowId) {
      throw new RuntimeError('INVALID_ARGUMENT', 'workflowId is required', {
        details: { field: 'workflowId' },
      });
    }
    const record = workflows.get(workflowId);
    if (!record) {
      throw new RuntimeError('WORKFLOW_NOT_FOUND', `Workflow not found: ${workflowId}`, {
        details: { workflowId },
      });
    }
    assertWorkflowIdentity(record, requestIdentity);
    return publicWorkflow(record);
  }

  async function replayReadonly(input = {}) {
    const requestIdentity = assertRequestIdentity(input, identity);
    const workflowId = String(input.workflowId || input.id || '').trim();
    if (!workflowId) {
      throw new RuntimeError('INVALID_ARGUMENT', 'workflowId is required', {
        details: { field: 'workflowId' },
      });
    }
    const record = workflows.get(workflowId);
    if (!record) {
      throw new RuntimeError('WORKFLOW_NOT_FOUND', `Workflow not found: ${workflowId}`, {
        details: { workflowId },
      });
    }
    assertWorkflowIdentity(record, requestIdentity);
    const replayedNodes = [];
    for (const node of record.nodes) {
      const capability = capabilityIndex.get(node.capabilityId) || node;
      if (!isReadOnlyNode(node, capability)) continue;
      const prior = record.outputs.find((entry) => entry.nodeId === node.nodeId);
      if (!prior) continue;
      // Re-run only semantic read nodes.  No approval is consulted and no
      // mutation node is ever handed to an adapter during replay.
      try {
        const output = await invokeNode(node, record, { readOnly: true, capability, replay: true });
        replayedNodes.push({
          nodeId: node.nodeId,
          capabilityId: node.capabilityId,
          readOnly: true,
          output: redactSecrets(output),
        });
      } catch (error) {
        throw toRuntimeError(error, 'REPLAY_FAILED', 'Read-only replay failed');
      }
    }
    await appendAudit({
      event: 'workflow.replayed_readonly',
      tenantId: record.tenantId,
      subject: record.subject,
      workflowId: record.workflowId,
      revision: record.revision,
      nodeCount: replayedNodes.length,
    });
    return {
      workflowId: record.workflowId,
      revision: record.revision,
      status: 'completed',
      readOnly: true,
      replayedNodes,
      outputs: replayedNodes,
    };
  }

  async function injectTrustedApproval(input = {}) {
    const candidate = input.approvalRequest || input.approval || input;
    if (!candidate || typeof candidate !== 'object') {
      throw new RuntimeError('INVALID_APPROVAL', 'A server-side approval record is required');
    }
    const workflowId = String(candidate.workflowId || '').trim();
    const record = workflows.get(workflowId);
    if (!record) {
      throw new RuntimeError('WORKFLOW_NOT_FOUND', `Workflow not found: ${workflowId}`, {
        details: { workflowId },
      });
    }
    const bound = {
      tenantId: String(candidate.tenantId || ''),
      subject: String(candidate.subject || candidate.userId || ''),
      workflowId,
      revision: Number(candidate.revision),
      nodeId: String(candidate.nodeId || ''),
      origin: String(candidate.origin || ''),
      canonicalArgsHash: String(candidate.canonicalArgsHash || candidate.argsHash || ''),
      nonce: String(candidate.nonce || ''),
      expiresAt: candidate.expiresAt,
    };
    assertWorkflowIdentity(record, bound);
    if (!bound.nodeId || !bound.nonce || !bound.canonicalArgsHash || !bound.origin || !Number.isInteger(bound.revision)) {
      throw new RuntimeError('INVALID_APPROVAL', 'Approval must bind workflow, revision, node, origin, hash and nonce');
    }
    if (bound.revision !== record.revision) {
      throw new RuntimeError('APPROVAL_BINDING_MISMATCH', 'Approval revision does not match the workflow revision');
    }
    const node = record.nodes.find((entry) => entry.nodeId === bound.nodeId);
    if (!node) throw new RuntimeError('APPROVAL_BINDING_MISMATCH', 'Approval node is not in the workflow');
    const expectedHash = await canonicalArgsHash(node.args, external.hasher);
    if (expectedHash !== bound.canonicalArgsHash) {
      throw new RuntimeError('APPROVAL_BINDING_MISMATCH', 'Approval arguments do not match the planned node', {
        details: { expected: expectedHash, received: bound.canonicalArgsHash },
      });
    }
    if (node.origin !== bound.origin || record.origin !== bound.origin) {
      throw new RuntimeError('APPROVAL_BINDING_MISMATCH', 'Approval origin does not match the planned node');
    }
    const expiresAt = normalizeExpiry(bound.expiresAt, now());
    if (expiresAt <= now().getTime()) {
      throw new RuntimeError('APPROVAL_EXPIRED', 'Approval has expired');
    }
    const key = approvalKey(bound);
    if (trustedApprovals.has(key)) {
      throw new RuntimeError('APPROVAL_NONCE_REUSED', 'Approval nonce has already been injected');
    }
    const trusted = {
      ...bound,
      expiresAt: new Date(expiresAt).toISOString(),
      trusted: true,
      source: 'server',
      injectedAt: nowIso(now),
      consumed: false,
    };
    await persistApproval(external.approvals, trusted);
    trustedApprovals.set(key, trusted);
    record.pendingApproval = undefined;
    await appendAudit({
      event: 'workflow.approval.injected',
      tenantId: record.tenantId,
      subject: record.subject,
      workflowId: record.workflowId,
      revision: record.revision,
      nodeId: node.nodeId,
      origin: record.origin,
      canonicalArgsHash: bound.canonicalArgsHash,
    });
    return {
      accepted: true,
      workflowId,
      revision: record.revision,
      nodeId: node.nodeId,
      nonce: bound.nonce,
      expiresAt: trusted.expiresAt,
      trusted: true,
    };
  }

  function findTrustedApproval(record, node) {
    const expectedHashPromise = canonicalArgsHash(node.args, external.hasher);
    // canonicalArgsHash is synchronous for the built-in hasher.  For an async
    // custom hasher, makeApprovalRequest stores the same hash and this branch
    // falls through until executeWorkflow's next turn resolves it.
    // eslint-free code keeps this function synchronous for deterministic use.
    const expectedHash = expectedHashPromise;
    for (const approval of trustedApprovals.values()) {
      if (approval.consumed) continue;
      if (approval.expiresAt && normalizeExpiry(approval.expiresAt, now()) <= now().getTime()) continue;
      if (approval.tenantId !== record.tenantId || approval.subject !== record.subject) continue;
      if (approval.workflowId !== record.workflowId || approval.revision !== record.revision) continue;
      if (approval.nodeId !== node.nodeId || approval.origin !== record.origin) continue;
      if (approval.canonicalArgsHash !== expectedHash) continue;
      return approval;
    }
    return undefined;
  }

  function consumeTrustedApproval(approval) {
    approval.consumed = true;
    approval.consumedAt = nowIso(now);
    const key = approvalKey(approval);
    const stored = trustedApprovals.get(key);
    if (stored) stored.consumed = true;
    if (external.approvals) {
      // Best effort: the runtime has already marked its own single-use record;
      // an external store can additionally mark/revoke it when it supports it.
      void invokeFirst(external.approvals, ['consume', 'markUsed', 'revoke'], [cloneJson(approval)]).catch(() => {});
    }
  }

  async function evaluatePolicy(context) {
    if (!external.policy) {
      if (context.origin && context.nodeOrigin && context.origin !== context.nodeOrigin) {
        throw new RuntimeError('ORIGIN_MISMATCH', 'Policy origin mismatch');
      }
      return true;
    }
    const result = await invokeFirst(external.policy, ['evaluate', 'authorize', 'check', 'assertAllowed'], [context]);
    if (result === false || (result && result.allowed === false) || (result && result.ok === false)) {
      throw new RuntimeError('POLICY_DENIED', 'Policy denied workflow node', { details: result });
    }
    return result === undefined ? true : result;
  }

  async function invokeNode(node, record, context) {
    if (external.broker) {
      const brokerResult = await invokeFirst(external.broker, ['execute', 'invoke', 'run'], [{
        node: cloneJson(node),
        workflow: publicWorkflow(record),
        tenantId: record.tenantId,
        subject: record.subject,
        origin: record.origin,
        ...context,
      }]);
      if (brokerResult !== undefined) return brokerResult;
    }
    const adapter = selectAdapter(node, record.origin);
    if (!adapter) {
      throw new RuntimeError('ADAPTER_NOT_FOUND', `No adapter is bound for capability: ${node.capabilityId}`);
    }
    const method = adapter.invoke || adapter.execute || adapter.call || adapter.run;
    if (typeof method !== 'function') {
      throw new RuntimeError('ADAPTER_INVALID', 'Adapter does not expose a semantic invocation method');
    }
    return method.call(adapter, node.capabilityId || node.operation, cloneJson(node.args || {}), {
      tenantId: record.tenantId,
      subject: record.subject,
      origin: record.origin,
      workflowId: record.workflowId,
      revision: record.revision,
      nodeId: node.nodeId,
      readOnly: context.readOnly === true,
      replay: context.replay === true,
    });
  }

  function selectAdapter(node, origin) {
    const id = node.adapterId || node.adapter;
    const candidates = adapters.filter((adapter) => {
      if (id && String(adapter.id || adapter.name || '') !== String(id)) return false;
      if (origin && adapter.origin && adapter.origin !== origin) return false;
      const capabilities = adapter.capabilities || adapter.listCapabilities?.();
      if (!capabilities) return true;
      return [...capabilities].some((entry) => String(entry.id || entry.name || entry) === String(node.capabilityId));
    });
    return candidates[0] || (id ? undefined : adapters[0]);
  }

  function makeApprovalRequest(record, node) {
    const hash = canonicalArgsHash(node.args, external.hasher);
    const expiresAt = new Date(now().getTime() + 5 * 60 * 1000).toISOString();
    return {
      tenantId: record.tenantId,
      subject: record.subject,
      workflowId: record.workflowId,
      revision: record.revision,
      nodeId: node.nodeId,
      origin: record.origin,
      canonicalArgsHash: hash,
      argsHash: hash,
      expiresAt,
      nonce: `${record.workflowId}:${record.revision}:${node.nodeId}`,
      action: node.capabilityId,
      risk: node.risk || 'high',
    };
  }

  async function appendAudit(event) {
    const entry = {
      id: idFactory('audit'),
      at: nowIso(now),
      ...redactSecrets(event),
    };
    auditRecords.push(entry);
    if (external.audit) {
      await invokeFirst(external.audit, ['append', 'record', 'write'], [cloneJson(entry)]);
    }
    return entry;
  }
}

/** Convenience alias used by hosts that call the root a runtime. */
export const createRuntime = createCompositionRoot;

/** Fixture-specific composition root used by integration tests and smoke. */
export function createFixtureRuntime(options = {}) {
  return createCompositionRoot({ ...options, fixture: true });
}

function buildFallbackPlan(request, identity) {
  let rawNodes = request.nodes;
  if (!Array.isArray(rawNodes) || rawNodes.length === 0) {
    const action = String(request.action || request.capabilityId || request.operation || '').toLowerCase();
    if (action.includes('add') || action.includes('cart.add') || request.productId) {
      rawNodes = [{
        capabilityId: 'cart.add',
        operation: 'cart.add',
        args: {
          productId: String(request.productId || request.args?.productId || 'sku-espresso'),
          quantity: request.quantity ?? request.args?.quantity ?? 1,
        },
      }];
    } else if (action.includes('cart') || action.includes('read')) {
      rawNodes = [{ capabilityId: 'cart.read', operation: 'cart.read', args: {} }];
    } else {
      rawNodes = [{
        capabilityId: 'catalog.search',
        operation: 'catalog.search',
        args: { query: String(request.query || request.args?.query || '') },
      }];
    }
  }
  return {
    tenantId: identity.tenantId,
    subject: identity.subject,
    origin: identity.origin,
    request,
    nodes: rawNodes,
  };
}

function normalizePlanRequest(input) {
  const nested = input.request && typeof input.request === 'object' ? input.request : {};
  const source = { ...nested, ...input };
  const nodes = input.nodes || nested.nodes || input.steps || nested.steps;
  return {
    ...cloneJson(source),
    ...(nodes ? { nodes: cloneJson(nodes) } : {}),
    action: source.action || source.capabilityId || source.operation,
    capabilityId: source.capabilityId,
    productId: source.productId || source.args?.productId,
    quantity: source.quantity ?? source.args?.quantity,
    query: source.query || source.args?.query,
  };
}

function normalizePlan(plan, identity, request, resolveCapability = () => undefined) {
  const source = plan && typeof plan === 'object' ? plan : {};
  const nodes = source.nodes || source.steps || source.actions || [];
  const normalizedNodes = (Array.isArray(nodes) ? nodes : []).map((node, index) => {
    const candidate = node && typeof node === 'object' ? node : { capabilityId: node };
    const capabilityId = String(candidate.capabilityId || candidate.operation || candidate.name || '').trim();
    if (!capabilityId) {
      throw new RuntimeError('INVALID_PLAN', 'Every workflow node requires a semantic capabilityId', {
        details: { index },
      });
    }
    if (UNSAFE_CAPABILITY_WORDS.test(capabilityId)) {
      throw new RuntimeError('CAPABILITY_NOT_ALLOWED', 'Raw or unsafe primitives cannot be planned', {
        details: { capabilityId },
      });
    }
    const metadata = resolveCapability(capabilityId);
    const mode = candidate.mode || candidate.kind || metadata?.mode || metadata?.kind || (candidate.readOnly === false ? 'mutation' : 'read');
    const readOnly = candidate.readOnly !== undefined ? candidate.readOnly === true : !isMutationMode(mode);
    return {
      nodeId: String(candidate.nodeId || candidate.id || `node-${index + 1}`),
      capabilityId,
      operation: String(candidate.operation || capabilityId),
      args: cloneJson(candidate.args || candidate.arguments || {}),
      adapterId: candidate.adapterId,
      adapter: candidate.adapter,
      origin: String(candidate.origin || identity.origin || metadata?.origin || ''),
      mode: readOnly ? 'read' : 'mutation',
      kind: readOnly ? 'read' : 'mutation',
      readOnly,
      requiresApproval: candidate.requiresApproval !== undefined ? candidate.requiresApproval === true : !readOnly,
      risk: candidate.risk || metadata?.risk || (readOnly ? 'low' : 'high'),
      status: 'pending',
    };
  });
  if (normalizedNodes.length === 0) {
    throw new RuntimeError('INVALID_PLAN', 'A workflow plan must contain at least one node');
  }
  return {
    id: String(source.workflowId || source.id || ''),
    workflowId: String(source.workflowId || source.id || ''),
    tenantId: String(source.tenantId || identity.tenantId),
    subject: String(source.subject || identity.subject),
    origin: String(source.origin || identity.origin || ''),
    revision: Number.isInteger(Number(source.revision)) ? Number(source.revision) : 1,
    request: cloneJson(source.request || request),
    nodes: normalizedNodes,
    planHash: source.planHash || hashCanonical({
      tenantId: identity.tenantId,
      subject: identity.subject,
      origin: identity.origin,
      nodes: normalizedNodes,
    }),
  };

}

function createWorkflowRecord(plan, identity, request, idFactory = createSequenceIdFactory('workflow'), clock = () => new Date()) {
  const workflowId = plan.workflowId || idFactory('workflow');
  const createdAt = nowIso(clock);
  return {
    workflowId,
    id: workflowId,
    tenantId: plan.tenantId || identity.tenantId,
    subject: plan.subject || identity.subject,
    origin: plan.origin || identity.origin || '',
    revision: plan.revision || 1,
    status: 'proposed',
    request: cloneJson(request),
    planHash: plan.planHash,
    nodes: plan.nodes.map((node) => ({ ...node })),
    cursor: 0,
    outputs: [],
    readonlyOutputs: [],
    createdAt,
    updatedAt: createdAt,
  };
}

function publicWorkflow(record) {
  const value = cloneJson(record);
  if (value && value.pendingApproval) value.pendingApproval = redactSecrets(value.pendingApproval);
  return value;
}

function executionResult(record, extra = {}) {
  return {
    workflowId: record.workflowId,
    revision: record.revision,
    status: record.status,
    outputs: cloneJson(record.outputs),
    ...cloneJson(extra),
  };
}

function failWorkflow(record, error) {
  record.status = 'failed';
  record.error = error.toJSON ? error.toJSON() : toRuntimeError(error).toJSON();
  record.updatedAt = new Date('2026-01-01T00:00:00.000Z').toISOString();
  return {
    workflowId: record.workflowId,
    revision: record.revision,
    status: 'failed',
    outputs: cloneJson(record.outputs),
    error: cloneJson(record.error),
  };
}

function normalizeIdentity(value = {}, options = {}) {
  const source = value && typeof value === 'object' ? value : {};
  const identity = {
    tenantId: String(source.tenantId || '').trim(),
    subject: String(source.subject || source.userId || '').trim(),
    origin: String(source.origin || '').trim(),
  };
  if (options.allowMissing) return identity;
  if (!identity.tenantId || !identity.subject) {
    throw new RuntimeError('IDENTITY_REQUIRED', 'tenantId and subject must be explicit');
  }
  return identity;
}

function assertRequestIdentity(input, configured) {
  const source = input && typeof input === 'object' ? input : {};
  const identity = normalizeIdentity({
    tenantId: source.tenantId || source.context?.tenantId || configured?.tenantId,
    subject: source.subject || source.userId || source.context?.subject || configured?.subject,
    origin: source.origin || source.context?.origin || configured?.origin,
  }, { allowMissing: true });
  if (!identity.tenantId || !identity.subject) {
    throw new RuntimeError('IDENTITY_REQUIRED', 'tenantId and subject must be explicit');
  }
  return identity;
}

function assertWorkflowIdentity(record, identity) {
  if (record.tenantId !== identity.tenantId || record.subject !== identity.subject ||
      (identity.origin && record.origin && identity.origin !== record.origin)) {
    throw new RuntimeError('IDENTITY_MISMATCH', 'Workflow identity does not match the explicit request identity');
  }
}

function normalizeCapabilities(value, adapters) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') {
    return Object.entries(value).map(([id, capability]) => ({ id, ...(capability || {}) }));
  }
  const result = [];
  for (const adapter of adapters) {
    const capabilities = adapter.capabilities || adapter.listCapabilities?.() || [];
    if (Array.isArray(capabilities)) result.push(...capabilities);
    else if (capabilities && typeof capabilities === 'object') {
      for (const [id, capability] of Object.entries(capabilities)) result.push({ id, ...(capability || {}) });
    }
  }
  return result;
}

function normalizeCapability(value, fallbackOrigin) {
  const source = value && typeof value === 'object' ? value : { id: value };
  const id = String(source.id || source.capabilityId || source.name || '').trim();
  const mode = source.mode || source.kind || (source.readOnly === false ? 'mutation' : 'read');
  const readOnly = source.readOnly !== undefined ? source.readOnly === true : !isMutationMode(mode);
  return {
    ...cloneJson(source),
    id,
    name: source.name || id,
    mode: readOnly ? 'read' : 'mutation',
    kind: readOnly ? 'read' : 'mutation',
    readOnly,
    requiresApproval: source.requiresApproval !== undefined ? source.requiresApproval === true : !readOnly,
    origin: String(source.origin || fallbackOrigin || '').trim(),
  };
}

function normalizeAdapters(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.filter(Boolean);
  if (typeof value === 'object') return Object.values(value).filter(Boolean);
  return [value];
}

function matchesOrigin(capability, origin) {
  return !origin || !capability.origin || capability.origin === origin;
}

function capabilitySearchText(capability) {
  return [capability.id, capability.name, capability.description, capability.mode, capability.kind]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

function normalizeSearchResult(value, query) {
  if (Array.isArray(value)) return { query, capabilities: cloneJson(value), items: cloneJson(value), total: value.length };
  const source = value && typeof value === 'object' ? value : {};
  const capabilities = source.capabilities || source.items || source.results || [];
  return {
    ...cloneJson(source),
    query: source.query === undefined ? query : source.query,
    capabilities: cloneJson(capabilities),
    items: cloneJson(source.items || capabilities),
    total: source.total === undefined ? capabilities.length : source.total,
  };
}

function isMutationMode(mode) {
  return /mutation|write|destructive|side.?effect/i.test(String(mode || ''));
}

function isReadOnlyNode(node, capability) {
  if (node.readOnly !== undefined) return node.readOnly === true;
  if (node.mode !== undefined) return !isMutationMode(node.mode);
  if (node.kind !== undefined) return !isMutationMode(node.kind);
  if (capability?.readOnly !== undefined) return capability.readOnly === true;
  return !isMutationMode(capability?.mode || capability?.kind);
}

function boundedInteger(value, fallback, minimum, maximum) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
}

function normalizeClock(clock) {
  if (typeof clock === 'function') {
    return () => {
      const value = clock();
      return value instanceof Date ? new Date(value.getTime()) : new Date(value);
    };
  }
  if (clock && typeof clock.now === 'function') return () => new Date(clock.now());
  return () => new Date('2026-01-01T00:00:00.000Z');
}

function nowIso(clock) {
  return clock().toISOString();
}

function normalizeExpiry(value, fallbackDate) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value < 10_000_000_000 ? value * 1000 : value;
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : fallbackDate.getTime();
}

function approvalKey(approval) {
  return [approval.workflowId, approval.revision, approval.nodeId, approval.nonce].join('|');
}

async function persistApproval(store, approval) {
  if (!store) return;
  const result = await invokeFirst(store, ['insertTrusted', 'insert', 'put', 'save', 'record', 'issue'], [cloneJson(approval)]);
  if (result === undefined) return;
}

async function invokeFirst(target, names, args) {
  if (!target) return undefined;
  for (const name of names) {
    if (typeof target[name] !== 'function') continue;
    return target[name](...args);
  }
  return undefined;
}

function canonicalArgsHash(value, hasher) {
  if (hasher) {
    const candidate = hasher.hash || hasher.canonicalHash || hasher.digest;
    if (typeof candidate === 'function') {
      const result = candidate.call(hasher, value);
      // Runtime approval records are synchronous in the default path.  A
      // promise from an external hasher is intentionally represented as a
      // stable fallback rather than leaking a Promise into JSON.
      if (result && typeof result.then === 'function') return hashCanonical(value);
      return String(result);
    }
    if (typeof hasher === 'function') {
      const result = hasher(value);
      if (result && typeof result.then === 'function') return hashCanonical(value);
      return String(result);
    }
  }
  return hashCanonical(value);
}

function hashCanonical(value) {
  return createHash('sha256').update(canonicalStringify(value)).digest('hex');
}

function canonicalStringify(value, seen = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') return Number.isFinite(value) ? JSON.stringify(value) : 'null';
  if (typeof value === 'bigint') return JSON.stringify(String(value));
  if (value === undefined) return 'null';
  if (typeof value !== 'object') return JSON.stringify(String(value));
  if (seen.has(value)) throw new RuntimeError('CANONICALIZATION_FAILED', 'Cannot hash cyclic arguments');
  seen.add(value);
  let result;
  if (Array.isArray(value)) result = `[${value.map((entry) => canonicalStringify(entry, seen)).join(',')}]`;
  else result = `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalStringify(value[key], seen)}`).join(',')}}`;
  seen.delete(value);
  return result;
}

function createSequenceIdFactory(prefix) {
  let sequence = 0;
  return (kind = 'id') => `${prefix}-${String(kind).replace(/[^a-z0-9_-]/gi, '-')}-${++sequence}`;
}

function redactSecrets(value, seen = new Set()) {
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  let output;
  if (Array.isArray(value)) output = value.map((entry) => redactSecrets(entry, seen));
  else {
    output = {};
    for (const key of Object.keys(value).sort()) output[key] = SECRET_KEY.test(key) ? '[REDACTED]' : redactSecrets(value[key], seen);
  }
  seen.delete(value);
  return output;
}

function cloneJson(value, seen = new Set()) {
  if (value === undefined || value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'bigint') return String(value);
  if (typeof value !== 'object') return undefined;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  let result;
  if (Array.isArray(value)) result = value.map((entry) => cloneJson(entry, seen));
  else {
    result = {};
    for (const key of Object.keys(value).sort()) {
      const child = cloneJson(value[key], seen);
      if (child !== undefined) result[key] = child;
    }
  }
  seen.delete(value);
  return result;
}

function toRuntimeError(error, fallbackCode = 'RUNTIME_ERROR', fallbackMessage = 'Runtime operation failed') {
  if (error instanceof RuntimeError) return error;
  if (error && typeof error === 'object' && typeof error.code === 'string' && typeof error.message === 'string') {
    return new RuntimeError(error.code, error.message, {
      retryable: error.retryable === true,
      details: error.details,
      cause: error,
    });
  }
  return new RuntimeError(fallbackCode, error?.message || fallbackMessage, { cause: error });
}

export { canonicalStringify, hashCanonical, redactSecrets };
