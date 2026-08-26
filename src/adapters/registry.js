import {
  ADAPTER_KINDS,
  ADAPTER_PRIORITY,
  AdapterContractError,
  assertRecord,
  createAdapterError,
  errorResult,
  isJsonSafe,
  isPlainObject,
  makeMetadata,
  normalizeConfidence,
  normalizeOrigin,
  normalizeRisk,
  validateCapabilityName,
} from './contracts.js';

const KIND_SET = new Set(ADAPTER_PRIORITY);

function adapterShape({ adapter }) {
  return isPlainObject({ value: adapter })
    && typeof adapter.id === 'string'
    && typeof adapter.kind === 'string'
    && typeof adapter.describe === 'function'
    && typeof adapter.probe === 'function'
    && typeof adapter.execute === 'function';
}

function canonicalPolicy({ policy, request }) {
  const source = policy === undefined ? {} : assertRecord({ value: policy, name: 'routing policy' });
  const merged = { ...source };
  if (request?.allowVisionFallback === true) merged.allowVisionFallback = true;
  for (const key of ['minimumConfidence', 'maxRiskScore']) {
    if (merged[key] !== undefined && (typeof merged[key] !== 'number' || !Number.isFinite(merged[key]) || merged[key] < 0 || merged[key] > 1)) {
      throw new AdapterContractError({ code: 'ADAPTER_POLICY_INVALID', message: `${key} must be a number between 0 and 1.` });
    }
  }
  if (merged.allowedAdapters !== undefined && (!Array.isArray(merged.allowedAdapters) || merged.allowedAdapters.some((entry) => typeof entry !== 'string'))) {
    throw new AdapterContractError({ code: 'ADAPTER_POLICY_INVALID', message: 'allowedAdapters must be an array of adapter ids.' });
  }
  if (merged.requireReadOnly !== undefined && typeof merged.requireReadOnly !== 'boolean') {
    throw new AdapterContractError({ code: 'ADAPTER_POLICY_INVALID', message: 'requireReadOnly must be boolean.' });
  }
  if (merged.allowVisionFallback !== undefined && typeof merged.allowVisionFallback !== 'boolean') {
    throw new AdapterContractError({ code: 'ADAPTER_POLICY_INVALID', message: 'allowVisionFallback must be boolean.' });
  }
  return merged;
}

function descriptorCapability({ descriptor, name }) {
  return descriptor.capabilities.find((entry) => entry.name === name) ?? null;
}

function normalizeDescriptor({ adapter }) {
  let descriptor;
  try { descriptor = adapter.describe({}); } catch (error) {
    throw new AdapterContractError({ code: 'ADAPTER_DESCRIPTOR_INVALID', message: 'Adapter descriptor could not be read.' });
  }
  if (!isPlainObject({ value: descriptor }) || !isJsonSafe({ value: descriptor })) {
    throw new AdapterContractError({ code: 'ADAPTER_DESCRIPTOR_INVALID', message: 'Adapter descriptor must be JSON-safe.' });
  }
  if (descriptor.id !== adapter.id || descriptor.kind !== adapter.kind || !KIND_SET.has(descriptor.kind)) {
    throw new AdapterContractError({ code: 'ADAPTER_DESCRIPTOR_INVALID', message: 'Adapter id or kind does not match its descriptor.' });
  }
  const expectedPriority = ADAPTER_PRIORITY.indexOf(descriptor.kind);
  if (descriptor.priority !== expectedPriority) {
    throw new AdapterContractError({ code: 'ADAPTER_PRIORITY_INVALID', message: 'Adapter priority must be fixed by adapter kind.' });
  }
  if (!Array.isArray(descriptor.origins) || descriptor.origins.length === 0 || !descriptor.origins.every((origin) => typeof origin === 'string')) {
    throw new AdapterContractError({ code: 'ADAPTER_DESCRIPTOR_INVALID', message: 'Adapter descriptor must declare bound origins.' });
  }
  if (!Array.isArray(descriptor.capabilities) || descriptor.capabilities.length === 0) {
    throw new AdapterContractError({ code: 'ADAPTER_DESCRIPTOR_INVALID', message: 'Adapter descriptor must declare capabilities.' });
  }
  // The typed factories have already validated these fields.  Recheck the
  // fields at the registry boundary because provider data is untrusted.
  for (const capability of descriptor.capabilities) {
    validateCapabilityName({ name: capability?.name });
    if (!isPlainObject({ value: capability }) || !isJsonSafe({ value: capability.inputSchema }) || !isJsonSafe({ value: capability.outputSchema })) {
      throw new AdapterContractError({ code: 'ADAPTER_DESCRIPTOR_INVALID', message: 'Capability schemas must be JSON-safe.' });
    }
    if (typeof capability.readOnly !== 'boolean' || typeof capability.mutates !== 'boolean' || capability.mutates === capability.readOnly) {
      throw new AdapterContractError({ code: 'ADAPTER_DESCRIPTOR_INVALID', message: 'Capability readOnly/mutates flags are invalid.' });
    }
  }
  return descriptor;
}

function candidateMetadata({ result, descriptor, capability, origin }) {
  let confidence;
  let risk;
  try {
    confidence = normalizeConfidence({ score: result.confidence, fallback: descriptor.confidence });
    risk = normalizeRisk({ score: result.riskScore ?? result.risk?.score, level: result.riskLevel ?? result.risk?.level, factors: result.risk?.factors, fallback: descriptor.riskScore });
  } catch {
    return null;
  }
  const metadata = isPlainObject({ value: result.metadata }) && isJsonSafe({ value: result.metadata })
    ? result.metadata
    : makeMetadata({ adapterId: descriptor.id, kind: descriptor.kind, origin, capability, confidence, risk });
  if (metadata.adapterId !== descriptor.id || metadata.kind !== descriptor.kind || metadata.origin !== origin) return null;
  return { confidence, risk, metadata };
}

function rejection({ adapterId, kind, reason, error }) {
  return {
    adapterId,
    kind,
    reason,
    ...(error === undefined ? {} : { error }),
  };
}

/**
 * Build a routing registry. Routing is deterministic and always follows the
 * fixed structured API -> WebMCP -> DOM/accessibility -> vision order.
 */
export function createAdapterRegistry({ adapters = [] } = {}) {
  if (!Array.isArray(adapters)) throw new AdapterContractError({ code: 'ADAPTER_REGISTRY_INVALID', message: 'adapters must be an array.' });
  const entries = new Map();
  let sequence = 0;

  const register = (registration = {}) => {
    const input = assertRecord({ value: registration, name: 'adapter registration' });
    const adapter = input.adapter ?? input;
    if (!adapterShape({ adapter })) return errorResult({ error: createAdapterError({ code: 'ADAPTER_INVALID', message: 'Adapter does not implement the semantic adapter contract.' }) });
    let descriptor;
    try { descriptor = normalizeDescriptor({ adapter }); } catch (error) { return errorResult({ error }); }
    if (entries.has(descriptor.id)) return errorResult({ error: createAdapterError({ code: 'ADAPTER_DUPLICATE', message: `Adapter id is already registered: ${descriptor.id}.` }) });
    entries.set(descriptor.id, { adapter, descriptor, sequence: sequence++ });
    return { ok: true, adapterId: descriptor.id, descriptor };
  };

  const unregister = ({ adapterId } = {}) => {
    if (typeof adapterId !== 'string') return errorResult({ error: createAdapterError({ code: 'ADAPTER_ID_REQUIRED', message: 'adapterId is required.' }) });
    if (!entries.delete(adapterId)) return errorResult({ error: createAdapterError({ code: 'ADAPTER_NOT_FOUND', message: 'Adapter is not registered.' }) });
    return { ok: true, adapterId };
  };

  for (const adapter of adapters) {
    const result = register({ adapter });
    if (!result.ok) throw new AdapterContractError(result.error);
  }

  const list = ({ origin, capability } = {}) => {
    let canonical;
    if (origin !== undefined) {
      try { canonical = normalizeOrigin({ origin }); } catch { return []; }
    }
    let requested;
    if (capability !== undefined) {
      try { requested = validateCapabilityName({ name: capability }); } catch { return []; }
    }
    return [...entries.values()]
      .sort((left, right) => left.descriptor.priority - right.descriptor.priority || left.sequence - right.sequence)
      .filter(({ descriptor }) => canonical === undefined || descriptor.origins.includes(canonical))
      .filter(({ descriptor }) => requested === undefined || descriptorCapability({ descriptor, name: requested }) !== null)
      .map(({ descriptor }) => JSON.parse(JSON.stringify(descriptor)));
  };

  const describe = ({ adapterId } = {}) => {
    if (adapterId === undefined) return list({});
    const entry = entries.get(adapterId);
    return entry ? JSON.parse(JSON.stringify(entry.descriptor)) : null;
  };

  const select = (selectionInput = {}) => {
    let input;
    try { input = assertRecord({ value: selectionInput, name: 'selection request' }); } catch (error) { return errorResult({ error }); }
    let origin;
    try { origin = normalizeOrigin({ origin: input.origin }); } catch (error) { return errorResult({ error }); }
    let capability;
    try { capability = validateCapabilityName({ name: input.capability ?? input.capabilityId ?? input.operation }); } catch (error) { return errorResult({ error }); }
    let request;
    try { request = input.request === undefined ? {} : assertRecord({ value: input.request, name: 'adapter request' }); } catch (error) { return errorResult({ error }); }
    let policy;
    try { policy = canonicalPolicy({ policy: input.policy, request }); } catch (error) { return errorResult({ error }); }
    const ordered = [...entries.values()].sort((left, right) => left.descriptor.priority - right.descriptor.priority || left.sequence - right.sequence);
    const rejections = [];
    const candidates = [];
    for (const entry of ordered) {
      const { adapter, descriptor } = entry;
      if (!descriptor.origins.includes(origin)) {
        rejections.push(rejection({ adapterId: descriptor.id, kind: descriptor.kind, reason: 'Origin is not bound to this adapter.' }));
        continue;
      }
      const capabilityDescriptor = descriptorCapability({ descriptor, name: capability });
      if (!capabilityDescriptor) {
        rejections.push(rejection({ adapterId: descriptor.id, kind: descriptor.kind, reason: 'Capability is not declared by this adapter.' }));
        continue;
      }
      if (policy.allowedAdapters && !policy.allowedAdapters.includes(descriptor.id)) {
        rejections.push(rejection({ adapterId: descriptor.id, kind: descriptor.kind, reason: 'Adapter is not allowed by routing policy.' }));
        continue;
      }
      if (descriptor.kind === ADAPTER_KINDS.VISION && policy.allowVisionFallback !== true) {
        rejections.push(rejection({ adapterId: descriptor.id, kind: descriptor.kind, reason: 'Vision fallback requires explicit policy opt-in.' }));
        continue;
      }
      if (policy.requireReadOnly === true && capabilityDescriptor.mutates) {
        rejections.push(rejection({ adapterId: descriptor.id, kind: descriptor.kind, reason: 'Mutating capability is not allowed by read-only policy.' }));
        continue;
      }
      let result;
      try { result = adapter.probe({ origin, capability, request }); } catch (error) {
        rejections.push(rejection({ adapterId: descriptor.id, kind: descriptor.kind, reason: 'Adapter probe failed.', error: createAdapterError({ code: error?.code, message: error?.message, retryable: error?.retryable }) }));
        continue;
      }
      if (result && typeof result.then === 'function') {
        rejections.push(rejection({ adapterId: descriptor.id, kind: descriptor.kind, reason: 'Asynchronous probes are not permitted during routing.' }));
        continue;
      }
      if (!isPlainObject({ value: result }) || result.ok === false || result.available !== true || result.adapterId !== descriptor.id || result.kind !== descriptor.kind || result.origin !== origin || result.capability !== capability) {
        rejections.push(rejection({ adapterId: descriptor.id, kind: descriptor.kind, reason: isPlainObject({ value: result }) && typeof result.reason === 'string' ? result.reason : 'Adapter is unavailable.' }));
        continue;
      }
      const metadata = candidateMetadata({ result, descriptor, capability, origin });
      if (!metadata) {
        rejections.push(rejection({ adapterId: descriptor.id, kind: descriptor.kind, reason: 'Adapter emitted invalid confidence/risk metadata.' }));
        continue;
      }
      if (policy.minimumConfidence !== undefined && metadata.confidence.score < policy.minimumConfidence) {
        rejections.push(rejection({ adapterId: descriptor.id, kind: descriptor.kind, reason: 'Confidence is below the routing policy minimum.' }));
        continue;
      }
      if (policy.maxRiskScore !== undefined && metadata.risk.score > policy.maxRiskScore) {
        rejections.push(rejection({ adapterId: descriptor.id, kind: descriptor.kind, reason: 'Risk is above the routing policy maximum.' }));
        continue;
      }
      candidates.push({
        adapterId: descriptor.id,
        kind: descriptor.kind,
        priority: descriptor.priority,
        origin,
        capability,
        confidence: metadata.confidence.score,
        confidenceScore: metadata.confidence.score,
        confidenceMetadata: metadata.confidence,
        risk: metadata.risk,
        riskScore: metadata.risk.score,
        riskLevel: metadata.risk.level,
        metadata: metadata.metadata,
      });
    }
    const selected = candidates[0];
    if (!selected) {
      return {
        ok: false,
        origin,
        capability,
        candidates: [],
        rejections,
        error: createAdapterError({
          code: 'ADAPTER_NOT_AVAILABLE',
          message: 'No bound, policy-compliant adapter can provide the requested capability.',
          retryable: false,
          details: { origin, capability, rejections },
        }),
      };
    }
    return {
      ok: true,
      origin,
      capability,
      selected,
      selectedAdapterId: selected.adapterId,
      candidates,
      rejections,
      routing: {
        order: [...ADAPTER_PRIORITY],
        rationale: `Selected ${selected.kind} at priority ${selected.priority}.`,
      },
    };
  };

  const execute = (executionInput = {}) => {
    let input;
    try { input = assertRecord({ value: executionInput, name: 'adapter execution' }); } catch (error) { return errorResult({ error }); }
    const selection = input.selection;
    if (!isPlainObject({ value: selection }) || selection.ok !== true) return errorResult({ error: createAdapterError({ code: 'ADAPTER_SELECTION_REQUIRED', message: 'A successful adapter selection is required.' }) });
    const adapterId = input.adapterId ?? selection.selectedAdapterId ?? selection.selected?.adapterId;
    if (typeof adapterId !== 'string') return errorResult({ error: createAdapterError({ code: 'ADAPTER_SELECTION_INVALID', message: 'Selection does not identify an adapter.' }) });
    const entry = entries.get(adapterId);
    if (!entry) return errorResult({ error: createAdapterError({ code: 'ADAPTER_NOT_FOUND', message: 'Selected adapter is not registered.' }) });
    let origin;
    try { origin = normalizeOrigin({ origin: input.origin }); } catch (error) { return errorResult({ error }); }
    let capability;
    try { capability = validateCapabilityName({ name: input.capability ?? input.capabilityId ?? input.operation }); } catch (error) { return errorResult({ error }); }
    if (selection.origin !== origin || selection.capability !== capability || selection.selectedAdapterId !== adapterId) return errorResult({ error: createAdapterError({ code: 'ADAPTER_SELECTION_BINDING_MISMATCH', message: 'Selection is not bound to this origin, capability, or adapter.' }) });
    try {
      const result = entry.adapter.execute({
        origin,
        capability,
        args: input.args,
        context: input.context,
      });
      if (result && typeof result.then === 'function') {
        return result.catch((error) => errorResult({ error }));
      }
      return result;
    } catch (error) {
      return errorResult({ error });
    }
  };

  return Object.freeze({ register, unregister, list, describe, select, execute });
}

export function selectAdapter({ registry, origin, capability, request, policy } = {}) {
  if (!registry || typeof registry.select !== 'function') return errorResult({ error: createAdapterError({ code: 'ADAPTER_REGISTRY_REQUIRED', message: 'A registry is required.' }) });
  return registry.select({ origin, capability, request, policy });
}
