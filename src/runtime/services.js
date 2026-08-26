/**
 * Composition helpers for the concrete core/security contracts.  Keeping the
 * constructors in one place means hosts can replace one service at a time
 * (for example, a durable workflow store) without changing MCP handlers.
 */
import {
  CoreError,
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
  const adapters = normalizeAdapters(options.adapters || options.adapter);
  const fallbackOrigin = options.origin || identity.origin || undefined;
  const capabilities = options.capabilities === undefined
    ? normalizeCatalogCapabilities(discoverAdapterCapabilities(adapters), fallbackOrigin, adapters)
    : normalizeCatalogCapabilities(options.capabilities || [], fallbackOrigin, adapters);
  const adapterIndex = indexAdapters(adapters);
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
    // ExecutionBroker accepts a Map/object keyed by the planned adapter id.
    // Passing the caller's array here silently disabled all adapters in the
    // core path.  The index also wraps typed adapters so their one-object
    // request/response envelope is adapted to the broker's semantic output.
    adapters: adapterIndex,
    adapterResolver: options.adapterResolver,
    executor: options.executor,
    approvalCredentialResolver: options.approvalCredentialResolver,
    approvalCredential: options.approvalCredential,
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
    adapters,
    adapterIndex,
  };
}

export function normalizeCatalogCapabilities(value, fallbackOrigin, adapters = []) {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => {
    const source = entry && typeof entry === 'object' ? entry : { id: entry };
    const id = source.id || source.capabilityId || source.name;
    const matchingAdapters = adaptersForCapability(adapters, id);
    const adapter = source.adapters || source.adapter || matchingAdapters || [{ id: 'structured.api' }];
    const adapterBindings = (Array.isArray(adapter) ? adapter : [adapter]).map((candidate) => {
      if (typeof candidate === 'string') return { id: candidate };
      return { id: candidate?.id || candidate?.adapterId || candidate?.name || 'structured.api' };
    });
    const matchingOrigins = originsForAdapters(adapterBindings, id, adapters);
    const origin = source.origins || source.origin || matchingOrigins || fallbackOrigin;
    const mode = source.mode || source.kind;
    const readOnly = source.readOnly !== undefined
      ? source.readOnly === true
      : source.mutates !== undefined
        ? source.mutates !== true
        : mode === 'read' || mode === 'readonly' || mode === 'read_only'
          ? true
          : mode === 'mutation' || mode === 'mutating' || mode === 'write'
            ? false
            : undefined;
    return {
      id,
      version: source.version || '1',
      name: source.name || id,
      description: source.description || '',
      readOnly,
      ...(source.mutates === undefined ? {} : { mutates: source.mutates }),
      operation: source.operation || (readOnly ? 'read' : 'write'),
      adapters: adapterBindings,
      ...(origin === undefined || origin === '' ? {} : { origins: Array.isArray(origin) ? origin : [origin] }),
      tags: source.tags,
      inputSchema: source.inputSchema || source.argsSchema || {},
      outputSchema: source.outputSchema || source.resultSchema || {},
      metadata: source.metadata,
      tenantId: source.tenantId || '*',
      ...(source.risk === undefined ? {} : { risk: source.risk }),
      ...(source.provider === undefined ? {} : { provider: source.provider }),
      ...(source.providerMetadata === undefined ? {} : { providerMetadata: source.providerMetadata }),
    };
  });
}

/**
 * Discover semantic capability descriptors from typed or legacy adapters.
 * Typed adapters expose a JSON descriptor through describe({}); older hosts
 * commonly expose a capabilities array directly.  Discovery is constructor
 * time only: provider/page output is never allowed to register a capability
 * through an MCP request.
 */
function discoverAdapterCapabilities(adapters) {
  const discovered = [];
  for (const adapter of adapters) {
    const descriptor = adapterDescriptor(adapter);
    const capabilities = descriptor?.capabilities ?? adapter?.capabilities;
    if (!Array.isArray(capabilities)) continue;
    for (const capability of capabilities) {
      if (!capability || typeof capability !== 'object') continue;
      const id = capability.id || capability.capabilityId || capability.name;
      if (!id) continue;
      discovered.push({
        ...capability,
        id,
        version: capability.version || descriptor?.version || adapter?.version || '1',
        adapters: capability.adapters || capability.adapter || [{
          id: descriptor?.id || adapter?.id || adapter?.name,
          kind: descriptor?.kind || adapter?.kind,
        }],
        origins: capability.origins || capability.origin || descriptor?.origins || descriptor?.origin || adapter?.origins || adapter?.origin,
      });
    }
  }
  return discovered;
}

function adapterDescriptor(adapter) {
  if (!adapter || typeof adapter !== 'object' || typeof adapter.describe !== 'function') return undefined;
  try {
    const descriptor = adapter.describe({});
    return descriptor && typeof descriptor === 'object' ? descriptor : undefined;
  } catch {
    return undefined;
  }
}

function adaptersForCapability(adapters, capabilityId) {
  if (!capabilityId) return undefined;
  const matches = [];
  for (const adapter of adapters) {
    const descriptor = adapterDescriptor(adapter);
    const capabilities = descriptor?.capabilities ?? adapter?.capabilities;
    if (!Array.isArray(capabilities)) continue;
    if (capabilities.some((entry) => String(entry?.id || entry?.capabilityId || entry?.name || '') === String(capabilityId))) {
      const id = descriptor?.id || adapter?.id || adapter?.name;
      if (id) matches.push({ id, ...(descriptor?.kind || adapter?.kind ? { kind: descriptor?.kind || adapter?.kind } : {}) });
    }
  }
  return matches.length ? matches : undefined;
}

function originsForAdapters(adapterChoices, capabilityId, adapters) {
  if (!Array.isArray(adapters) || !adapterChoices?.length) return undefined;
  const origins = [];
  for (const choice of adapterChoices) {
    const id = choice?.id;
    const adapter = adapters.find((entry) => String(entry?.id || entry?.name || '') === String(id));
    if (!adapter) continue;
    const descriptor = adapterDescriptor(adapter);
    const capabilities = descriptor?.capabilities ?? adapter?.capabilities;
    const capability = Array.isArray(capabilities)
      ? capabilities.find((entry) => String(entry?.id || entry?.capabilityId || entry?.name || '') === String(capabilityId))
      : undefined;
    const bound = capability?.origins || capability?.origin || descriptor?.origins || descriptor?.origin || adapter?.origins || adapter?.origin;
    if (bound !== undefined) origins.push(...(Array.isArray(bound) ? bound : [bound]));
  }
  return origins.length ? [...new Set(origins)] : undefined;
}

function normalizeAdapters(value) {
  if (value instanceof Map) return [...value.values()].filter(Boolean);
  if (!value) return [];
  if (Array.isArray(value)) return value.filter(Boolean);
  if (typeof value === 'object') return Object.values(value).filter(Boolean);
  return [value];
}

function indexAdapters(adapters) {
  const index = new Map();
  for (const adapter of adapters) {
    const id = adapter?.id || adapter?.name;
    if (typeof id !== 'string' || !id) continue;
    if (index.has(id)) throw new CoreError('ADAPTER_CONFLICT', `Adapter id is registered more than once: ${id}`);
    index.set(id, createBrokerAdapter(adapter));
  }
  return index;
}

function createBrokerAdapter(adapter) {
  const typed = isTypedAdapter(adapter);
  const execute = async (request = {}) => {
    assertAdapterOrigin(adapter, request.origin);
    if (typed) {
      const context = {
        ...(request.context && typeof request.context === 'object' ? request.context : {}),
        tenantId: request.tenantId,
        subjectId: request.subjectId,
        workflowId: request.workflowId,
        revision: request.revision,
        nodeId: request.nodeId,
        adapter: request.adapter,
        origin: request.origin,
        readOnly: request.readOnly === true,
        replay: request.replay === true,
      };
      if (request.readOnly !== true) {
        // Core ExecutionBroker has already checked and consumed the trusted
        // approval before invoking this adapter.  Typed adapters still require
        // an explicit trusted marker in their own envelope.
        context.approvalRecord = {
          trusted: true,
          origin: request.origin,
          adapterId: request.adapter,
          capability: request.capabilityId,
        };
      }
      const result = await adapter.execute({
        ...request,
        capability: request.capabilityId,
        context,
      });
      if (result && result.ok === false) throw adapterError(result.error);
      if (result && result.ok === true && Object.prototype.hasOwnProperty.call(result, 'output')) return sanitizeAdapterOutput(result.output);
      if (result && result.ok === true && Object.prototype.hasOwnProperty.call(result, 'value')) return sanitizeAdapterOutput(result.value);
      return sanitizeAdapterOutput(result);
    }
    const method = adapter?.invoke || adapter?.execute || adapter?.call || adapter?.run;
    if (typeof method !== 'function') throw new CoreError('ADAPTER_UNAVAILABLE', 'Adapter does not expose a semantic invocation method');
    const context = {
      tenantId: request.tenantId,
      subjectId: request.subjectId,
      workflowId: request.workflowId,
      revision: request.revision,
      nodeId: request.nodeId,
      adapter: request.adapter,
      origin: request.origin,
      readOnly: request.readOnly === true,
      replay: request.replay === true,
    };
    const oneObject = method === adapter?.execute && typeof adapter?.invoke !== 'function' && method.length <= 1;
    const result = oneObject
      ? method.call(adapter, { ...request, context })
      : method.call(adapter, request.capabilityId, request.args || {}, context);
    return result && typeof result.then === 'function'
      ? result.then((value) => normalizeLegacyEnvelope(value))
      : normalizeLegacyEnvelope(result);
  };
  return { execute };
}

function normalizeLegacyEnvelope(value) {
  if (value && typeof value === 'object' && value.ok === false && value.error) throw adapterError(value.error);
  if (value && typeof value === 'object' && value.ok === true && Object.prototype.hasOwnProperty.call(value, 'output')) {
    return sanitizeAdapterOutput(value.output);
  }
  if (value && typeof value === 'object' && value.ok === true && Object.prototype.hasOwnProperty.call(value, 'value')) {
    return sanitizeAdapterOutput(value.value);
  }
  return sanitizeAdapterOutput(value);
}

function sanitizeAdapterOutput(value, seen = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : '[UNSERIALIZABLE]';
  if (value === undefined) return null;
  if (typeof value === 'bigint') return String(value);
  if (typeof value !== 'object') return '[UNSERIALIZABLE]';
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  let output;
  if (Array.isArray(value)) output = value.map((entry) => sanitizeAdapterOutput(entry, seen));
  else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      seen.delete(value);
      return '[UNSERIALIZABLE]';
    }
    output = {};
    for (const key of Object.keys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      output[key] = descriptor && Object.prototype.hasOwnProperty.call(descriptor, 'value')
        ? sanitizeAdapterOutput(descriptor.value, seen)
        : '[UNSERIALIZABLE]';
    }
  }
  seen.delete(value);
  return output;
}

function isTypedAdapter(adapter) {
  return Boolean(adapter && typeof adapter.execute === 'function' && (
    typeof adapter.describe === 'function' && typeof adapter.probe === 'function' && typeof adapter.kind === 'string'
    // Minimal typed integrations may intentionally expose only the one-object
    // execute contract plus origin/capability metadata.  A one-argument
    // execute function with no legacy invoke method is unambiguously typed.
    || (typeof adapter.invoke !== 'function' && adapter.execute.length <= 1)
  ));
}

function assertAdapterOrigin(adapter, origin) {
  if (typeof origin !== 'string' || origin.length === 0) throw new CoreError('ORIGIN_REQUIRED', 'An explicit origin is required for adapter execution');
  const descriptor = adapterDescriptor(adapter);
  const bound = descriptor?.origins || descriptor?.origin || adapter?.origins || adapter?.origin;
  if (!bound) throw new CoreError('ORIGIN_MISMATCH', 'Adapter has no bound execution origin');
  const origins = Array.isArray(bound) ? bound : [bound];
  const canonical = canonicalOrigin(origin);
  if (!origins.some((entry) => canonicalOrigin(entry) === canonical)) {
    throw new CoreError('ORIGIN_MISMATCH', 'Adapter is not bound to the requested origin');
  }
}

function canonicalOrigin(value) {
  try {
    const parsed = new URL(String(value));
    if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.username || parsed.password ||
        parsed.pathname !== '/' || parsed.search || parsed.hash || !parsed.hostname) return '';
    return parsed.origin;
  } catch {
    return '';
  }
}

function adapterError(value) {
  const error = new Error(value?.message || 'Adapter execution failed');
  if (value?.code) error.code = value.code;
  error.retryable = value?.retryable === true;
  if (value?.details !== undefined) error.details = value.details;
  return error;
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
