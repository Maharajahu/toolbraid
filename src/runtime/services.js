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
import { ADAPTER_DATA_LIMITS, assertAdapterDataBounds } from '../adapters/base.js';
import { normalizeAdapterError } from '../adapters/contracts.js';

const RISK_LEVELS = new Set(['low', 'medium', 'high', 'critical']);
const RISK_RANK = Object.freeze({ low: 0, medium: 1, high: 2, critical: 3 });

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
  // Adapter/page descriptors are observations, never catalog authority.
  // Hosts must supply the capability records explicitly so a provider cannot
  // choose its own mutability, operation, or execution scope.
  const capabilities = options.capabilities === undefined
    ? []
    : normalizeCatalogCapabilities(options.capabilities || [], fallbackOrigin, adapters);
  const adapterIndex = indexAdapters(adapters);
  const auditOptions = options.auditOptions &&
    typeof options.auditOptions === 'object' &&
    !Array.isArray(options.auditOptions)
    ? { ...options.auditOptions }
    : {};
  // Keep the default audit clock owned by this service graph while allowing a
  // host to bound retention (directly or through auditOptions).  A direct
  // maxAuditEntries setting is intentionally authoritative at the composition
  // boundary, just like the direct workflow quota settings below.
  if (options.maxAuditEntries !== undefined) auditOptions.maxEntries = options.maxAuditEntries;
  const audit = options.audit || new AuditLog({
    ...auditOptions,
    clock: () => now().getTime(),
  });
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
  const workflowStoreOptions = options.workflowStoreOptions &&
    typeof options.workflowStoreOptions === 'object' &&
    !Array.isArray(options.workflowStoreOptions)
    ? { ...options.workflowStoreOptions }
    : {};
  // Keep quota configuration at the composition boundary.  A host may pass
  // it directly alongside the other core options or group it under
  // workflowStoreOptions; in both cases the trusted clock/id factory remain
  // owned by this service graph.
  for (const name of [
    'maxHistory',
    'maxRecords',
    'maxWorkflowRecords',
    'maxBytes',
    'maxWorkflowBytes',
    'maxRecordsPerTenant',
    'maxTenantRecords',
    'maxWorkflowsPerTenant',
    'maxBytesPerTenant',
    'maxTenantBytes',
    'maxWorkflowBytesPerTenant',
    'maxRecordsPerIdentity',
    'maxIdentityRecords',
    'maxWorkflowsPerIdentity',
    'maxBytesPerIdentity',
    'maxIdentityBytes',
    'maxWorkflowBytesPerIdentity',
    'maxRecordBytes',
    'maxBytesPerRecord',
    'maxWorkflowRecordBytes',
  ]) {
    if (options[name] !== undefined) workflowStoreOptions[name] = options[name];
  }
  const workflowStore = options.workflowStore || options.store || new WorkflowStore({
    ...workflowStoreOptions,
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
    policy,
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
      const binding = { id: candidate?.id || candidate?.adapterId || candidate?.name || 'structured.api' };
      if (typeof candidate?.version === 'string') binding.version = candidate.version;
      if (typeof candidate?.kind === 'string') binding.kind = candidate.kind;
      return binding;
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
      ...(() => {
        const risk = normalizeRiskLevel(source.riskLevel ?? source.risk);
        return risk === undefined ? {} : { risk };
      })(),
      ...(source.provider === undefined ? {} : { provider: source.provider }),
      ...(source.providerMetadata === undefined ? {} : { providerMetadata: source.providerMetadata }),
    };
  });
}

function normalizeRiskLevel(value) {
  const supplied = typeof value === 'string'
    ? value.toLowerCase()
    : value && typeof value === 'object' && typeof value.level === 'string'
      ? value.level.toLowerCase()
      : undefined;
  let derived;
  const score = value && typeof value === 'object' ? value.score : undefined;
  if (typeof score === 'number' && Number.isFinite(score) && score >= 0 && score <= 1) {
    derived = score >= 0.85 ? 'critical' : score >= 0.6 ? 'high' : score >= 0.3 ? 'medium' : 'low';
  }
  if (!RISK_LEVELS.has(supplied)) return derived;
  if (!derived || RISK_RANK[supplied] >= RISK_RANK[derived]) return supplied;
  return derived;
}

function adapterDescriptor(adapter) {
  if (!adapter || typeof adapter !== 'object' || typeof adapter.describe !== 'function') return undefined;
  let descriptor;
  try {
    descriptor = adapter.describe({});
  } catch {
    return undefined;
  }
  if (!descriptor || typeof descriptor !== 'object') return undefined;
  if (Array.isArray(descriptor.capabilities) && descriptor.capabilities.length > ADAPTER_DATA_LIMITS.maxCapabilities) {
    throw new CoreError(
      'CAPABILITY_LIMIT_EXCEEDED',
      `An adapter may declare at most ${ADAPTER_DATA_LIMITS.maxCapabilities} capabilities`,
    );
  }
  assertAdapterDataBounds(descriptor, 'Adapter descriptor', {
    maxNodes: ADAPTER_DATA_LIMITS.maxNodes * ADAPTER_DATA_LIMITS.maxCapabilities,
    maxBytes: ADAPTER_DATA_LIMITS.maxBytes * 8,
  });
  return descriptor;
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
      if (id) {
        const version = descriptor?.version || adapter?.version;
        const kind = descriptor?.kind || adapter?.kind;
        matches.push({
          id,
          ...(typeof version === 'string' ? { version } : {}),
          ...(typeof kind === 'string' ? { kind } : {}),
        });
      }
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
      let result;
      try {
        result = await adapter.execute({
          ...request,
          capability: request.capabilityId,
          context,
        });
      } catch (error) {
        // Provider exceptions are untrusted data.  Normalize them before the
        // core broker can persist or attach the value to a workflow error.
        throw adapterError(error);
      }
      if (result && result.ok === false) throw adapterError(result.error);
      if (result && result.ok === true && Object.prototype.hasOwnProperty.call(result, 'output')) return sanitizeAdapterOutput(result.output);
      if (result && result.ok === true && Object.prototype.hasOwnProperty.call(result, 'value')) return sanitizeAdapterOutput(result.value);
      return sanitizeAdapterOutput(result);
    }
    const method = adapter?.invoke || adapter?.execute || adapter?.call || adapter?.run;
    if (typeof method !== 'function') throw new CoreError('ADAPTER_UNAVAILABLE', 'Adapter does not expose a semantic invocation method');
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
    const oneObject = method === adapter?.execute && typeof adapter?.invoke !== 'function' && method.length <= 1;
    try {
      const result = oneObject
        ? method.call(adapter, { ...request, context })
        : method.call(adapter, request.capabilityId, request.args || {}, context);
      return normalizeLegacyEnvelope(await result);
    } catch (error) {
      // Legacy providers may reject or throw with an Error carrying an
      // attacker-sized message.  Keep the same bounded envelope as typed
      // adapters before returning control to the broker.
      throw adapterError(error);
    }
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

function sanitizeAdapterOutput(value) {
  const state = { nodes: 0, bytes: 0 };
  const root = { value: undefined };
  const active = new Set();
  const stack = [{ input: value, parent: root, key: 'value', depth: 0, enter: true }];

  const fail = (message) => {
    throw new CoreError('ADAPTER_OUTPUT_LIMIT', `Adapter output ${message}`);
  };
  const addBytes = (candidate) => {
    state.bytes += Buffer.byteLength(candidate, 'utf8');
    if (state.bytes > ADAPTER_DATA_LIMITS.maxBytes) fail(`exceeds the ${ADAPTER_DATA_LIMITS.maxBytes}-byte bound`);
  };
  const marker = (value) => {
    addBytes(value);
    return value;
  };
  const write = (parent, key, child) => {
    if (Array.isArray(parent)) parent[key] = child;
    else Object.defineProperty(parent, key, {
      configurable: true,
      enumerable: true,
      writable: true,
      value: child,
    });
  };
  const primitive = (input) => {
    if (input === null || typeof input === 'boolean') return input;
    if (typeof input === 'string') {
      if (input.length > ADAPTER_DATA_LIMITS.maxStringLength) fail(`contains a string longer than ${ADAPTER_DATA_LIMITS.maxStringLength} characters`);
      addBytes(input);
      return input;
    }
    if (typeof input === 'number') return Number.isFinite(input) ? input : marker('[UNSERIALIZABLE]');
    if (input === undefined) return null;
    if (typeof input === 'bigint') {
      const text = String(input);
      if (text.length > ADAPTER_DATA_LIMITS.maxStringLength) fail(`contains a string longer than ${ADAPTER_DATA_LIMITS.maxStringLength} characters`);
      addBytes(text);
      return text;
    }
    return marker('[UNSERIALIZABLE]');
  };

  while (stack.length) {
    const frame = stack.pop();
    if (!frame.enter) {
      active.delete(frame.input);
      continue;
    }
    state.nodes += 1;
    if (state.nodes > ADAPTER_DATA_LIMITS.maxNodes) fail(`exceeds the ${ADAPTER_DATA_LIMITS.maxNodes}-node bound`);
    if (frame.depth > ADAPTER_DATA_LIMITS.maxDepth) fail(`exceeds the ${ADAPTER_DATA_LIMITS.maxDepth}-level nesting bound`);

    const input = frame.input;
    if (input === null || typeof input !== 'object') {
      write(frame.parent, frame.key, primitive(input));
      continue;
    }
    if (active.has(input)) {
      write(frame.parent, frame.key, marker('[Circular]'));
      continue;
    }

    let prototype;
    let keys;
    try {
      prototype = Object.getPrototypeOf(input);
      keys = Object.keys(input);
    } catch {
      write(frame.parent, frame.key, marker('[UNSERIALIZABLE]'));
      continue;
    }
    if (!Array.isArray(input) && prototype !== Object.prototype && prototype !== null) {
      write(frame.parent, frame.key, marker('[UNSERIALIZABLE]'));
      continue;
    }
    if (Array.isArray(input) && input.length > ADAPTER_DATA_LIMITS.maxArrayLength) {
      fail(`contains an array longer than ${ADAPTER_DATA_LIMITS.maxArrayLength} entries`);
    }
    if (keys.length > ADAPTER_DATA_LIMITS.maxObjectKeys) {
      fail(`contains an object with more than ${ADAPTER_DATA_LIMITS.maxObjectKeys} keys`);
    }

    const output = Array.isArray(input) ? new Array(input.length) : {};
    write(frame.parent, frame.key, output);
    active.add(input);
    stack.push({ input, parent: null, key: null, depth: frame.depth, enter: false });
    if (Array.isArray(input)) {
      for (let index = input.length - 1; index >= 0; index -= 1) {
        const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
        stack.push({
          input: descriptor && Object.prototype.hasOwnProperty.call(descriptor, 'value') ? descriptor.value : undefined,
          parent: output,
          key: index,
          depth: frame.depth + 1,
          enter: true,
        });
      }
    } else {
      for (let index = keys.length - 1; index >= 0; index -= 1) {
        const key = keys[index];
        if (key.length > ADAPTER_DATA_LIMITS.maxKeyLength) fail(`contains a key longer than ${ADAPTER_DATA_LIMITS.maxKeyLength} characters`);
        addBytes(key);
        const descriptor = Object.getOwnPropertyDescriptor(input, key);
        stack.push({
          input: descriptor && Object.prototype.hasOwnProperty.call(descriptor, 'value') ? descriptor.value : '[UNSERIALIZABLE]',
          parent: output,
          key,
          depth: frame.depth + 1,
          enter: true,
        });
      }
    }
  }
  return root.value;
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
  const normalized = normalizeAdapterError({ error: value });
  const error = new Error(normalized.message);
  error.code = normalized.code;
  error.retryable = normalized.retryable;
  if (normalized.details !== undefined) error.details = normalized.details;
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
