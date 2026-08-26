import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CapabilityCatalog,
  DeterministicPlanner,
  ExecutionBroker,
  WorkflowStore,
} from '../../src/core/index.js';
import {
  ApprovalAuthority,
  AuditLog,
  PolicyEngine,
} from '../../src/security/index.js';
import {
  PUBLIC_TOOL_NAMES,
  createCompositionRoot,
  createFixtureRuntime,
} from '../../src/runtime/composition-root.js';
import { createServer } from '../../src/server.js';

const ORIGIN = 'https://shop.example.test';
const OTHER_ORIGIN = 'https://other.example.test';
const IDENTITY = Object.freeze({
  tenantId: 'tenant-acme',
  subject: 'user-alice',
  origin: ORIGIN,
});
const OTHER_IDENTITY = Object.freeze({
  tenantId: 'tenant-other',
  subject: 'user-bob',
  origin: ORIGIN,
});
const ADAPTER_ID = 'typed-orders';

function capability(id, overrides = {}) {
  const readOnly = overrides.readOnly ?? true;
  const mode = readOnly ? 'read' : 'mutation';
  return {
    id,
    version: '1',
    name: id,
    description: `Semantic ${id}`,
    readOnly,
    operation: readOnly ? 'read' : 'write',
    mode,
    kind: mode,
    adapters: [{ id: ADAPTER_ID }],
    adapter: ADAPTER_ID,
    origins: [ORIGIN],
    origin: ORIGIN,
    inputSchema: { type: 'object', additionalProperties: true },
    outputSchema: { type: 'object', additionalProperties: true },
    ...overrides,
  };
}

function typedAdapter({
  id = ADAPTER_ID,
  origin = ORIGIN,
  capabilityIds = ['orders.read'],
  execute,
} = {}) {
  return {
    id,
    origin,
    origins: [origin],
    capabilities: capabilityIds.map((id) => ({ id })),
    execute: execute || ((request) => ({ ok: true, output: { capabilityId: request.capabilityId } })),
  };
}

function runtimeWithCore({
  capabilities = [capability('orders.read')],
  adapters,
  ...options
} = {}) {
  const selectedAdapter = adapters || {
    [ADAPTER_ID]: typedAdapter({ capabilityIds: capabilities.map((entry) => entry.id) }),
  };
  return createCompositionRoot({
    ...options,
    withCore: true,
    allowReadOnly: true,
    policyRules: options.policyRules ?? capabilities.map((entry, index) => ({
      id: `test-allow-${index + 1}`,
      effect: 'allow',
      capabilities: [entry.id],
      origins: entry.origins || [entry.origin],
      adapters: (entry.adapters || [{ id: entry.adapter }]).map((candidate) =>
        typeof candidate === 'string' ? candidate : candidate.id),
    })),
    identity: options.identity || IDENTITY,
    capabilities,
    adapters: selectedAdapter,
  });
}

function callIdentity(identity = IDENTITY) {
  return {
    tenantId: identity.tenantId,
    subject: identity.subject,
    origin: identity.origin,
  };
}

function errorCode(error) {
  return error?.code || error?.details?.code;
}

test('default non-fixture runtime wires concrete core and security services', () => {
  const runtime = createCompositionRoot({
    identity: IDENTITY,
    allowReadOnly: true,
    capabilities: [capability('orders.read')],
    adapters: { [ADAPTER_ID]: typedAdapter() },
  });

  assert.ok(runtime.core, 'non-fixture composition must construct the core service graph');
  assert.ok(runtime.services.catalog instanceof CapabilityCatalog);
  assert.ok(runtime.services.planner instanceof DeterministicPlanner);
  assert.ok(runtime.services.workflow instanceof WorkflowStore);
  assert.ok(runtime.services.broker instanceof ExecutionBroker);
  assert.ok(runtime.services.policy instanceof PolicyEngine);
  assert.ok(runtime.services.approvals instanceof ApprovalAuthority);
  assert.ok(runtime.services.audit instanceof AuditLog);
  assert.strictEqual(runtime.services.catalog, runtime.core.catalog);
  assert.strictEqual(runtime.services.planner, runtime.core.planner);
  assert.strictEqual(runtime.services.workflow, runtime.core.workflowStore);
  assert.strictEqual(runtime.services.broker, runtime.core.broker);
  assert.strictEqual(runtime.services.policy, runtime.core.policy);
  assert.strictEqual(runtime.services.approvals, runtime.core.approvalAuthority);
  assert.strictEqual(runtime.services.audit, runtime.core.audit);

  // Fixture mode is an explicit deterministic test double, not the default
  // service graph used by a non-fixture host.
  assert.equal(createFixtureRuntime().core, null);
});

test('default core execution enforces policy denial before adapter invocation', async () => {
  let calls = 0;
  const runtime = createCompositionRoot({
    identity: IDENTITY,
    allowReadOnly: true,
    deniedCapabilities: ['orders.read'],
    capabilities: [capability('orders.read')],
    adapters: {
      [ADAPTER_ID]: typedAdapter({
        execute() {
          calls += 1;
          return { ok: true, output: { leaked: true } };
        },
      }),
    },
  });
  const plan = await runtime.callTool('plan.propose', {
    ...callIdentity(),
    nodes: [{ capabilityId: 'orders.read', args: {} }],
  });
  await assert.rejects(
    runtime.callTool('workflow.execute', {
      ...callIdentity(),
      workflowId: plan.workflowId,
      revision: plan.revision,
    }),
    (error) => errorCode(error) === 'POLICY_DENIED' && error.details?.cause?.code === 'POLICY_DENIED',
  );
  assert.equal(calls, 0);
});

test('mutation deny rules win before an approval can be requested or consumed', async () => {
  let calls = 0;
  const runtime = runtimeWithCore({
    capabilities: [capability('orders.write', { readOnly: false })],
    policyRules: [
      { effect: 'allow', capabilities: ['orders.write'] },
      { effect: 'deny', capabilities: ['orders.write'] },
    ],
    adapters: {
      [ADAPTER_ID]: typedAdapter({
        capabilityIds: ['orders.write'],
        execute() {
          calls += 1;
          return { ok: true, output: { committed: true } };
        },
      }),
    },
  });
  const plan = await runtime.callTool('plan.propose', {
    ...callIdentity(),
    nodes: [{ capabilityId: 'orders.write', args: { orderId: 'o-1' } }],
  });
  await assert.rejects(
    runtime.callTool('workflow.execute', {
      ...callIdentity(),
      workflowId: plan.workflowId,
      revision: plan.revision,
    }),
    (error) => errorCode(error) === 'POLICY_DENIED',
  );
  assert.equal(calls, 0);
});

test('withCore runtime can describe, plan, and execute through the service graph', async () => {
  const calls = [];
  const adapter = typedAdapter({
    execute(request) {
      calls.push(request);
      return { ok: true, output: { orderId: request.args.orderId } };
    },
  });
  const runtime = runtimeWithCore({
    capabilities: [capability('orders.read')],
    adapters: { [ADAPTER_ID]: adapter },
  });

  const described = await runtime.callTool('capabilities.describe', {
    ...callIdentity(),
    capabilityId: 'orders.read',
    version: '1',
  });
  assert.equal(described.id, 'orders.read');
  assert.equal(described.version, '1');

  const plan = await runtime.callTool('plan.propose', {
    ...callIdentity(),
    request: {
      workflowId: 'core-read-workflow',
      nodes: [{ nodeId: 'read-order', capabilityId: 'orders.read', args: { orderId: 'o-1' } }],
    },
  });
  assert.equal(plan.status, 'proposed');
  assert.equal(plan.nodes[0].capabilityId, 'orders.read');

  const result = await runtime.callTool('workflow.execute', {
    ...callIdentity(),
    workflowId: plan.workflowId,
    revision: plan.revision,
  });
  assert.equal(result.status, 'completed');
  assert.equal(calls.length, 1);
});

test('typed adapters receive one object request and ok:false is a failed execution', async () => {
  const requests = [];
  const adapter = typedAdapter({
    execute(request) {
      requests.push(request);
      if (!request || typeof request !== 'object' || Array.isArray(request)) {
        return { ok: false, error: { code: 'ADAPTER_REQUEST_NOT_OBJECT', message: 'request must be an object' } };
      }
      if (request.args.mode === 'reject') {
        return { ok: false, error: { code: 'UPSTREAM_REJECTED', message: 'The semantic operation was rejected' } };
      }
      return { ok: true, output: { accepted: true } };
    },
  });
  const runtime = runtimeWithCore({
    capabilities: [capability('orders.read')],
    adapters: { [ADAPTER_ID]: adapter },
  });

  const acceptedPlan = await runtime.callTool('plan.propose', {
    ...callIdentity(),
    request: {
      workflowId: 'typed-ok',
      nodes: [{ nodeId: 'typed-read', capabilityId: 'orders.read', args: { mode: 'accept' } }],
    },
  });
  const accepted = await runtime.callTool('workflow.execute', {
    ...callIdentity(),
    workflowId: acceptedPlan.workflowId,
    revision: acceptedPlan.revision,
  });
  assert.equal(accepted.status, 'completed');
  assert.equal(requests.length, 1);
  assert.equal(typeof requests[0], 'object');
  assert.equal(Array.isArray(requests[0]), false);
  assert.equal(requests[0].capabilityId, 'orders.read');
  assert.deepEqual(requests[0].args, { mode: 'accept' });
  assert.equal(requests[0].origin, ORIGIN);

  const rejectedPlan = await runtime.callTool('plan.propose', {
    ...callIdentity(),
    request: {
      workflowId: 'typed-failure',
      nodes: [{ nodeId: 'typed-reject', capabilityId: 'orders.read', args: { mode: 'reject' } }],
    },
  });
  const rejected = await runtime.callTool('workflow.execute', {
    ...callIdentity(),
    workflowId: rejectedPlan.workflowId,
    revision: rejectedPlan.revision,
  }).catch((error) => error);
  if (rejected instanceof Error) {
    assert.ok(['ADAPTER_EXECUTION_FAILED', 'EXECUTION_FAILED', 'UPSTREAM_REJECTED'].includes(errorCode(rejected)));
  } else {
    assert.equal(rejected.status, 'failed');
    assert.ok(['ADAPTER_EXECUTION_FAILED', 'EXECUTION_FAILED', 'UPSTREAM_REJECTED'].includes(rejected.error?.code));
  }
  assert.equal(requests.length, 2);
});

test('origin mismatches are rejected before a bound adapter can run', async () => {
  let calls = 0;
  const adapter = typedAdapter({ execute() { calls += 1; return { ok: true, output: {} }; } });
  const runtime = runtimeWithCore({
    capabilities: [capability('orders.read')],
    adapters: { [ADAPTER_ID]: adapter },
  });

  await assert.rejects(
    runtime.callTool('plan.propose', {
      ...callIdentity({ ...IDENTITY, origin: OTHER_ORIGIN }),
      request: {
        workflowId: 'wrong-origin-plan',
        nodes: [{ nodeId: 'wrong-origin', capabilityId: 'orders.read', args: {} }],
      },
    }),
    (error) => ['ORIGIN_NOT_ALLOWED', 'CAPABILITY_ORIGIN_MISMATCH', 'IDENTITY_MISMATCH', 'INVALID_PLAN'].includes(errorCode(error)),
  );
  assert.equal(calls, 0);
});

test('an unknown capability cannot self-label as read-only', async () => {
  let calls = 0;
  const adapter = typedAdapter({ execute() { calls += 1; return { ok: true, output: {} }; } });
  const runtime = runtimeWithCore({
    capabilities: [capability('orders.read')],
    adapters: { [ADAPTER_ID]: adapter },
  });

  await assert.rejects(
    runtime.callTool('plan.propose', {
      ...callIdentity(),
      request: {
        workflowId: 'unknown-readonly',
        nodes: [{ nodeId: 'unknown', capabilityId: 'unknown.read', readOnly: true, mode: 'read', args: {} }],
      },
    }),
    (error) => ['CAPABILITY_NOT_FOUND', 'INVALID_PLAN'].includes(errorCode(error)),
  );
  assert.equal(calls, 0);
});

test('public plan and audit snapshots are detached from server state', async () => {
  const runtime = runtimeWithCore();
  const plan = await runtime.callTool('plan.propose', {
    ...callIdentity(),
    request: {
      workflowId: 'immutable-public-state',
      nodes: [{ nodeId: 'read-order', capabilityId: 'orders.read', args: { orderId: 'o-1' } }],
    },
  });
  const originalHash = plan.planHash;
  plan.status = 'completed';
  plan.nodes[0].args.orderId = 'tampered';
  plan.nodes.push({ nodeId: 'injected', capabilityId: 'orders.read' });

  const status = await runtime.callTool('workflow.status', {
    ...callIdentity(),
    workflowId: plan.workflowId,
    revision: plan.revision,
  });
  assert.equal(status.status, 'proposed');
  assert.equal(status.planHash, originalHash);
  assert.deepEqual(status.nodes.map(({ nodeId }) => nodeId), ['read-order']);
  assert.equal(status.nodes[0].args.orderId, 'o-1');

  const firstAudit = runtime.getAuditRecords();
  assert.ok(firstAudit.length > 0);
  const auditLength = firstAudit.length;
  firstAudit[0].workflowId = 'tampered';
  firstAudit.push({ event: 'forged' });
  const secondAudit = runtime.getAuditRecords();
  assert.equal(secondAudit.length, auditLength);
  assert.equal(secondAudit[0].workflowId, plan.workflowId);
});

test('capability visibility is tenant-scoped and secret metadata is redacted', async () => {
  const privateCapability = capability('tenant.orders.read', {
    tenantId: IDENTITY.tenantId,
    metadata: {
      safe: 'visible',
      apiKey: 'api-secret-value',
      nested: { accessToken: 'bearer-secret-value', label: 'ok' },
    },
  });
  const runtime = runtimeWithCore({
    capabilities: [privateCapability],
  });

  const ownerSearch = await runtime.callTool('capabilities.search', {
    ...callIdentity(),
    query: 'tenant.orders',
  });
  assert.deepEqual(ownerSearch.capabilities.map(({ id }) => id), ['tenant.orders.read']);
  assert.equal(JSON.stringify(ownerSearch).includes('api-secret-value'), false);
  assert.equal(JSON.stringify(ownerSearch).includes('bearer-secret-value'), false);

  const otherSearch = await runtime.callTool('capabilities.search', {
    ...callIdentity(OTHER_IDENTITY),
    query: 'tenant.orders',
  });
  assert.equal(otherSearch.capabilities.some(({ id }) => id === 'tenant.orders.read'), false);
  assert.equal(otherSearch.total, 0);
  await assert.rejects(
    runtime.callTool('capabilities.describe', {
      ...callIdentity(OTHER_IDENTITY),
      capabilityId: 'tenant.orders.read',
      version: '1',
    }),
    (error) => ['CAPABILITY_NOT_FOUND', 'CAPABILITY_FORBIDDEN'].includes(errorCode(error)),
  );

  const described = await runtime.callTool('capabilities.describe', {
    ...callIdentity(),
    capabilityId: 'tenant.orders.read',
    version: '1',
  });
  assert.equal(described.metadata.apiKey, '[REDACTED]');
  assert.equal(described.metadata.nested.accessToken, '[REDACTED]');
  assert.equal(described.metadata.safe, 'visible');
});

test('dependency order is honored and duplicate node ids are rejected', async () => {
  const calls = [];
  const adapter = typedAdapter({ execute(request) { calls.push(request.nodeId); return { ok: true, output: {} }; } });
  const runtime = runtimeWithCore({
    capabilities: [capability('orders.read')],
    adapters: { [ADAPTER_ID]: adapter },
  });
  const plan = await runtime.callTool('plan.propose', {
    ...callIdentity(),
    request: {
      workflowId: 'dependency-order',
      nodes: [
        { nodeId: 'dependent', capabilityId: 'orders.read', args: {}, dependsOn: ['prerequisite'] },
        { nodeId: 'prerequisite', capabilityId: 'orders.read', args: {} },
      ],
    },
  });
  const result = await runtime.callTool('workflow.execute', {
    ...callIdentity(),
    workflowId: plan.workflowId,
    revision: plan.revision,
  });
  assert.equal(result.status, 'completed');
  assert.ok(calls.indexOf('prerequisite') < calls.indexOf('dependent'));

  await assert.rejects(
    runtime.callTool('plan.propose', {
      ...callIdentity(),
      request: {
        workflowId: 'duplicate-node-id',
        nodes: [
          { nodeId: 'same', capabilityId: 'orders.read', args: {} },
          { nodeId: 'same', capabilityId: 'orders.read', args: {} },
        ],
      },
    }),
    (error) => errorCode(error) === 'INVALID_PLAN',
  );
});

test('the host approval hook is not MCP-public', async () => {
  const runtime = runtimeWithCore({
    capabilities: [capability('orders.read', { readOnly: false })],
  });
  assert.equal(typeof runtime.injectTrustedApproval, 'function');
  assert.equal(PUBLIC_TOOL_NAMES.includes('approval.grant'), false);
  assert.equal(runtime.publicToolNames.includes('approval.grant'), false);

  const server = createServer({ root: runtime });
  const listed = await server.handleRequest({
    jsonrpc: '2.0',
    id: 'list',
    method: 'tools/list',
    params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} } },
  });
  assert.equal(listed.result.tools.some(({ name }) => name === 'approval.grant'), false);

  const hidden = await server.handleRequest({
    jsonrpc: '2.0',
    id: 'hidden',
    method: 'tools/call',
    params: { name: 'approval.grant', arguments: {} },
  });
  assert.equal(hidden.error?.code, -32602);
});

test('an audit failure after a side effect is reconciled without retrying the adapter', async () => {
  let auditCalls = 0;
  let sideEffects = 0;
  const audit = {
    append() {
      auditCalls += 1;
      // Let composition and execution start, then fail at the first
      // post-invocation audit append.
      if (sideEffects > 0) throw new Error('audit sink unavailable');
    },
  };
  const adapter = typedAdapter({ execute() { sideEffects += 1; return { ok: true, output: { committed: true } }; } });
  const runtime = runtimeWithCore({
    audit,
    capabilities: [capability('orders.write', { readOnly: false })],
    adapters: { [ADAPTER_ID]: adapter },
  });
  const plan = await runtime.callTool('plan.propose', {
    ...callIdentity(),
    request: {
      workflowId: 'audit-reconcile',
      nodes: [{ nodeId: 'write-order', capabilityId: 'orders.write', args: { orderId: 'o-1' } }],
    },
  });
  const first = await runtime.callTool('workflow.execute', {
    ...callIdentity(),
    workflowId: plan.workflowId,
    revision: plan.revision,
  }).catch((error) => error);
  assert.equal(sideEffects, 0, 'mutation must await a trusted approval before its side effect');
  assert.ok(first && (first.status === 'awaiting_approval' || first.state === 'awaiting_approval' || first.code === 'APPROVAL_REQUIRED'));

  const approvalRequest = first.approvalRequest || first.approvalRequired || first.details?.approvalRequest;
  assert.ok(approvalRequest, 'a mutation must expose a host-only approval request');
  const approval = await runtime.injectTrustedApproval(approvalRequest);
  assert.equal(approval.accepted, true);
  const second = await runtime.callTool('workflow.execute', {
    ...callIdentity(),
    workflowId: plan.workflowId,
    revision: plan.revision,
  }).catch((error) => error);
  assert.equal(sideEffects, 1);
  assert.ok(second instanceof Error || ['failed', 'reconciliation_required', 'completed'].includes(second.status));

  const reconciled = await runtime.callTool('workflow.status', {
    ...callIdentity(),
    workflowId: plan.workflowId,
    revision: plan.revision,
  });
  assert.ok(['failed', 'reconciliation_required', 'completed'].includes(reconciled.status || reconciled.state));

  // A failed post-side-effect audit must not leave a retryable running node
  // that invokes the same mutation a second time.
  const third = await runtime.callTool('workflow.execute', {
    ...callIdentity(),
    workflowId: plan.workflowId,
    revision: plan.revision,
  }).catch((error) => error);
  assert.equal(sideEffects, 1);
  assert.ok(third);
});
