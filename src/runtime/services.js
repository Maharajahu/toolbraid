/**
 * Composition helpers for the concrete core/security contracts.  Keeping the
 * constructors in one place means hosts can replace one service at a time
 * (for example, a durable workflow store) without changing MCP handlers.
 */
import {
  CapabilityCatalog,
  DeterministicPlanner,
  ExecutionBroker,
  WorkflowStore,
} from '../core/index.js';
import {
  ApprovalAuthority,
  AuditLog,
  PolicyEngine,
} from '../security/index.js';

/**
 * Construct the default in-memory service graph.  This graph is optional for
 * the fixture runtime (which uses a tiny semantic adapter directly), but is
 * the composition root's concrete integration point for production hosts.
 */
export function createCoreServices(options = {}) {
  const now = normalizeClock(options.clock || options.now);
  const identity = options.identity || {};
  const capabilities = normalizeCatalogCapabilities(options.capabilities || [], options.origin);
  const audit = options.audit || new AuditLog({ clock: () => now().getTime() });
  const approvalAuthority = options.approvalAuthority || options.approvals || new ApprovalAuthority({
    clock: () => now().getTime(),
    audit,
    nonceFactory: options.nonceFactory || createNonceFactory(options.idPrefix || 'tb'),
    idFactory: options.approvalIdFactory || createApprovalIdFactory(options.idPrefix || 'tb'),
  });
  const catalog = options.catalog || new CapabilityCatalog({ capabilities });
  const planner = options.planner || new DeterministicPlanner({
    catalog,
    idFactory: options.workflowIdFactory,
  });
  const workflowStore = options.workflowStore || options.store || new WorkflowStore({
    clock: () => now().toISOString(),
    idFactory: options.workflowIdFactory,
  });
  const policy = options.policy || options.policyEngine || new PolicyEngine({
    rules: options.policyRules || [],
    allowReadOnly: options.allowReadOnly === true,
    approvalAuthority,
    audit,
    allowedOrigins: options.allowedOrigins,
    allowedAdapters: options.allowedAdapters,
    allowedCapabilities: options.allowedCapabilities,
    allowedActions: options.allowedActions,
    deniedOrigins: options.deniedOrigins,
    deniedAdapters: options.deniedAdapters,
    deniedCapabilities: options.deniedCapabilities,
    deniedActions: options.deniedActions,
  });
  const broker = options.broker || options.executionBroker || new ExecutionBroker({
    store: workflowStore,
    catalog,
    approvalStore: approvalAuthority,
    adapters: options.adapters,
    adapterResolver: options.adapterResolver,
    executor: options.executor,
    audit,
    clock: () => now().toISOString(),
  });
  const approvalIssuer = options.approvalIssuer || approvalAuthority.createIssuer(options.issuerLabel || 'composition-root');
  return {
    catalog,
    planner,
    workflowStore,
    store: workflowStore,
    policy,
    approvalAuthority,
    approvals: approvalAuthority,
    approvalIssuer,
    audit,
    broker,
    identity,
    adapters: options.adapters,
  };
}

export function normalizeCatalogCapabilities(value, fallbackOrigin) {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => {
    const source = entry && typeof entry === 'object' ? entry : { id: entry };
    const readOnly = source.readOnly !== undefined ? source.readOnly === true : source.mutates !== true;
    const adapter = source.adapters || source.adapter || [{ id: 'structured.api' }];
    const adapters = (Array.isArray(adapter) ? adapter : [adapter]).map((candidate) => {
      if (typeof candidate === 'string') return { id: candidate };
      return { id: candidate?.id || candidate?.adapterId || candidate?.name || 'structured.api' };
    });
    const origin = source.origins || source.origin || fallbackOrigin || 'https://example.invalid';
    return {
      id: source.id || source.capabilityId,
      version: source.version || '1',
      name: source.name,
      description: source.description,
      readOnly,
      operation: source.operation || (readOnly ? 'read' : 'write'),
      adapters,
      origins: Array.isArray(origin) ? origin : [origin],
      tags: source.tags,
      inputSchema: source.inputSchema,
      outputSchema: source.outputSchema,
      metadata: source.metadata,
      tenantId: source.tenantId || '*',
    };
  });
}

function normalizeClock(clock) {
  if (typeof clock === 'function') {
    return () => {
      const result = clock();
      return result instanceof Date ? new Date(result.getTime()) : new Date(result);
    };
  }
  return () => new Date('2026-01-01T00:00:00.000Z');
}

function createNonceFactory(prefix) {
  let sequence = 0;
  return () => `${prefix}-nonce-${String(++sequence).padStart(12, '0')}`;
}

function createApprovalIdFactory(prefix) {
  let sequence = 0;
  return () => `${prefix}-approval-${String(++sequence).padStart(8, '0')}`;
}

