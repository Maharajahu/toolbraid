import {
  ADAPTER_KINDS,
  ADAPTER_PRIORITY,
  DEFAULT_ADAPTER_METADATA,
  AdapterContractError,
  assertRecord,
  cloneJson,
  createAdapterError,
  errorResult,
  isJsonSafe,
  isPlainObject,
  makeMetadata,
  normalizeConfidence,
  normalizeOrigin,
  normalizeOrigins,
  normalizeRisk,
  originsEqual,
  validateCapabilityName,
  validateSchema,
  validateSchemaDefinition,
} from './contracts.js';

const KIND_SET = new Set(ADAPTER_PRIORITY);
const RESERVED_SPEC_KEYS = new Set(['click', 'shell', 'browser', 'javascript', 'eval', 'exec']);

function priorityForKind({ kind }) {
  const priority = ADAPTER_PRIORITY.indexOf(kind);
  if (priority < 0) {
    throw new AdapterContractError({ code: 'ADAPTER_KIND_INVALID', message: 'Unknown adapter kind.' });
  }
  return priority;
}

function normalizeAdapterId({ id }) {
  if (typeof id !== 'string' || !/^[a-z][a-z0-9]*(?:[._:-][a-z0-9]+)*$/i.test(id) || id.length > 100) {
    throw new AdapterContractError({ code: 'ADAPTER_ID_INVALID', message: 'Adapter id must be a bounded identifier.' });
  }
  if ([...id.split(/[._:-]/)].some((part) => RESERVED_SPEC_KEYS.has(part.toLowerCase()))) {
    throw new AdapterContractError({ code: 'ADAPTER_RAW_OPERATION_FORBIDDEN', message: 'Raw interaction adapters are not part of the contract.' });
  }
  return id;
}

function firstSchema({ descriptor, names, fallback }) {
  for (const name of names) if (descriptor[name] !== undefined) return descriptor[name];
  return fallback;
}

function normalizeCapability({ descriptor, kind }) {
  if (!isPlainObject({ value: descriptor })) {
    throw new AdapterContractError({ code: 'ADAPTER_CAPABILITY_INVALID', message: 'Each capability must be a plain object.' });
  }
  const name = validateCapabilityName({ name: descriptor.name ?? descriptor.id });
  if (descriptor.readOnly === undefined && descriptor.mutates === undefined) {
    throw new AdapterContractError({ code: 'ADAPTER_MUTABILITY_REQUIRED', message: `Capability ${name} must declare readOnly or mutates explicitly.` });
  }
  const readOnly = descriptor.readOnly === undefined ? descriptor.mutates !== true : descriptor.readOnly === true;
  if (descriptor.mutates !== undefined && descriptor.readOnly !== undefined && descriptor.mutates === readOnly) {
    throw new AdapterContractError({ code: 'ADAPTER_CAPABILITY_INVALID', message: `Capability ${name} has contradictory mutates/readOnly flags.` });
  }
  const inputSchema = firstSchema({ descriptor, names: ['inputSchema', 'argsSchema', 'input'], fallback: undefined });
  const outputSchema = firstSchema({ descriptor, names: ['outputSchema', 'resultSchema', 'output'], fallback: undefined });
  if (inputSchema === undefined || outputSchema === undefined) {
    throw new AdapterContractError({ code: 'ADAPTER_SCHEMA_REQUIRED', message: `Capability ${name} must declare inputSchema and outputSchema.` });
  }
  const inputCheck = validateSchemaDefinition({ schema: inputSchema, name: `${name}.inputSchema` });
  const outputCheck = validateSchemaDefinition({ schema: outputSchema, name: `${name}.outputSchema` });
  if (!inputCheck.valid || !outputCheck.valid) {
    throw new AdapterContractError({
      code: 'ADAPTER_SCHEMA_INVALID',
      message: `Capability ${name} has an invalid JSON Schema.`,
      details: { input: inputCheck.errors, output: outputCheck.errors },
    });
  }
  const defaults = DEFAULT_ADAPTER_METADATA[kind];
  const confidence = normalizeConfidence({
    score: descriptor.confidence,
    fallback: defaults.confidence,
    rationale: descriptor.confidenceRationale ?? descriptor.confidenceMetadata?.rationale,
  });
  const risk = normalizeRisk({
    score: descriptor.riskScore ?? descriptor.risk?.score,
    level: descriptor.riskLevel ?? descriptor.risk?.level,
    factors: descriptor.riskFactors ?? descriptor.risk?.factors,
    fallback: defaults.riskScore,
  });
  const capability = {
    name,
    description: typeof descriptor.description === 'string' ? descriptor.description : name,
    inputSchema: cloneJson({ value: inputSchema }),
    outputSchema: cloneJson({ value: outputSchema }),
    readOnly,
    mutates: !readOnly,
    confidence: confidence.score,
    confidenceScore: confidence.score,
    confidenceMetadata: confidence,
    risk,
    riskScore: risk.score,
    riskLevel: risk.level,
  };
  if (descriptor.semanticTarget !== undefined) {
    if (!isJsonSafe({ value: descriptor.semanticTarget })) {
      throw new AdapterContractError({ code: 'ADAPTER_CAPABILITY_INVALID', message: `Capability ${name} semanticTarget must be JSON-safe.` });
    }
    capability.semanticTarget = cloneJson({ value: descriptor.semanticTarget });
  }
  if (descriptor.tags !== undefined) {
    if (!Array.isArray(descriptor.tags) || descriptor.tags.some((entry) => typeof entry !== 'string')) {
      throw new AdapterContractError({ code: 'ADAPTER_CAPABILITY_INVALID', message: `Capability ${name} tags must be strings.` });
    }
    capability.tags = [...new Set(descriptor.tags)].slice(0, 32);
  }
  return capability;
}

function normalizeProbeRequest({ input }) {
  if (input === undefined) return {};
  return assertRecord({ value: input, name: 'probe request' });
}

function normalizeExecutionRequest({ input }) {
  const request = input === undefined ? {} : assertRecord({ value: input, name: 'execution request' });
  const args = request.args === undefined ? {} : request.args;
  if (!isPlainObject({ value: args })) {
    throw new AdapterContractError({ code: 'ADAPTER_ARGUMENTS_INVALID', message: 'Capability arguments must be a plain object.' });
  }
  const context = request.context === undefined ? {} : request.context;
  if (!isPlainObject({ value: context })) {
    throw new AdapterContractError({ code: 'ADAPTER_CONTEXT_INVALID', message: 'Adapter context must be a plain object.' });
  }
  return { ...request, args, context };
}

function serializeHandlerError({ error }) {
  if (error instanceof AdapterContractError) return error.toJSON();
  if (isPlainObject({ value: error }) && typeof error.code === 'string' && typeof error.message === 'string') {
    return createAdapterError({ code: error.code, message: error.message, retryable: error.retryable, details: error.details });
  }
  return createAdapterError({ code: 'ADAPTER_EXECUTION_FAILED', message: 'Adapter execution failed.', retryable: true });
}

function normalizeAvailability({ result }) {
  if (typeof result === 'boolean') return { available: result };
  if (!isPlainObject({ value: result })) return { available: false, reason: 'Adapter availability signal was invalid.' };
  if (result.available !== undefined && typeof result.available !== 'boolean') return { available: false, reason: 'Adapter availability signal was invalid.' };
  return {
    available: result.available !== false,
    confidence: result.confidence,
    confidenceRationale: result.confidenceRationale,
    riskScore: result.riskScore,
    riskLevel: result.riskLevel,
    riskFactors: result.riskFactors,
    evidence: result.evidence,
    reason: typeof result.reason === 'string' ? result.reason : undefined,
  };
}

/**
 * Build the common adapter contract. Concrete adapters should use one of the
 * typed factories instead of calling this directly.
 */
export function createAdapter(spec = {}) {
  const input = assertRecord({ value: spec, name: 'adapter specification' });
  const kind = input.kind;
  if (!KIND_SET.has(kind)) {
    throw new AdapterContractError({ code: 'ADAPTER_KIND_INVALID', message: 'Adapter kind is not supported.' });
  }
  const id = normalizeAdapterId({ id: input.id });
  const priority = priorityForKind({ kind });
  if (input.priority !== undefined && input.priority !== priority) {
    throw new AdapterContractError({ code: 'ADAPTER_PRIORITY_INVALID', message: 'Adapter priority is fixed by adapter kind.' });
  }
  const origins = normalizeOrigins({ origins: input.origins, origin: input.origin });
  if (!Array.isArray(input.capabilities) || input.capabilities.length === 0) {
    throw new AdapterContractError({ code: 'ADAPTER_CAPABILITIES_REQUIRED', message: 'An adapter must declare at least one semantic capability.' });
  }
  const capabilities = input.capabilities.map((entry) => normalizeCapability({ descriptor: entry, kind }));
  const capabilityMap = new Map();
  for (const capability of capabilities) {
    if (capabilityMap.has(capability.name)) {
      throw new AdapterContractError({ code: 'ADAPTER_CAPABILITY_DUPLICATE', message: `Duplicate capability: ${capability.name}.` });
    }
    capabilityMap.set(capability.name, capability);
  }
  const defaults = DEFAULT_ADAPTER_METADATA[kind];
  const adapterConfidence = normalizeConfidence({
    score: input.confidence,
    fallback: defaults.confidence,
    rationale: input.confidenceRationale ?? input.confidenceMetadata?.rationale,
  });
  const adapterRisk = normalizeRisk({
    score: input.riskScore ?? input.risk?.score,
    level: input.riskLevel ?? input.risk?.level,
    factors: input.riskFactors ?? input.risk?.factors,
    fallback: defaults.riskScore,
  });
  const source = typeof input.source === 'string' ? input.source : kind;
  const description = typeof input.description === 'string' ? input.description : `${kind} adapter`;

  const handlers = isPlainObject({ value: input.handlers }) ? input.handlers : {};
  for (const key of Object.keys(handlers)) {
    if (!capabilityMap.has(key)) {
      throw new AdapterContractError({ code: 'ADAPTER_HANDLER_UNKNOWN', message: `Handler declared for unknown capability: ${key}.` });
    }
    if (typeof handlers[key] !== 'function') {
      throw new AdapterContractError({ code: 'ADAPTER_HANDLER_INVALID', message: `Handler for ${key} must be a function.` });
    }
  }
  const invoke = input.invoke;
  if (invoke !== undefined && typeof invoke !== 'function') {
    throw new AdapterContractError({ code: 'ADAPTER_HANDLER_INVALID', message: 'Adapter invoke must be a function.' });
  }
  const availability = input.availability;
  if (availability !== undefined && typeof availability !== 'function') {
    throw new AdapterContractError({ code: 'ADAPTER_AVAILABILITY_INVALID', message: 'Adapter availability must be a function.' });
  }

  const descriptor = {
    id,
    kind,
    priority,
    source,
    description,
    origins: [...origins],
    capabilities: capabilities.map((capability) => cloneJson({ value: capability })),
    confidence: adapterConfidence.score,
    confidenceScore: adapterConfidence.score,
    confidenceMetadata: adapterConfidence,
    risk: adapterRisk,
    riskScore: adapterRisk.score,
    riskLevel: adapterRisk.level,
  };
  // Keep the origin binding visible at both levels.  A consumer can inspect a
  // single capability descriptor without having to infer which adapter
  // origins it inherited.
  for (const capability of descriptor.capabilities) {
    capability.origins = [...origins];
    if (origins.length === 1) capability.origin = origins[0];
  }
  if (origins.length === 1) descriptor.origin = origins[0];
  if (input.version !== undefined) {
    if (typeof input.version !== 'string' || input.version.length > 40) {
      throw new AdapterContractError({ code: 'ADAPTER_VERSION_INVALID', message: 'Adapter version must be a bounded string.' });
    }
    descriptor.version = input.version;
  }
  if (input.metadata !== undefined) {
    if (!isJsonSafe({ value: input.metadata })) throw new AdapterContractError({ code: 'ADAPTER_METADATA_INVALID', message: 'Adapter metadata must be JSON-safe.' });
    descriptor.metadata = cloneJson({ value: input.metadata });
  }
  Object.freeze(descriptor.origins);
  Object.freeze(descriptor.capabilities);

  const getCapability = ({ name } = {}) => {
    try { return capabilityMap.get(validateCapabilityName({ name })) ?? null; } catch { return null; }
  };

  const describe = () => cloneJson({ value: descriptor });

  const supports = ({ origin, capability } = {}) => {
    let canonical;
    try { canonical = normalizeOrigin({ origin }); } catch { return { supported: false, reason: 'Origin is invalid.' }; }
    const cap = capability === undefined ? undefined : getCapability({ name: capability });
    return {
      supported: origins.some((bound) => originsEqual({ expected: bound, actual: canonical })) && (capability === undefined ? capabilities.length > 0 : cap !== null),
      adapterId: id,
      kind,
      origin: canonical,
      ...(capability === undefined ? {} : { capability, capabilityKnown: cap !== null }),
    };
  };

  const probe = (probeInput = {}) => {
    let request;
    try { request = normalizeProbeRequest({ input: probeInput }); } catch (error) { return errorResult({ error }); }
    let canonical;
    try { canonical = normalizeOrigin({ origin: request.origin }); } catch (error) { return errorResult({ error }); }
    const requestedName = request.capability ?? request.capabilityId ?? request.operation;
    const capability = requestedName === undefined ? undefined : getCapability({ name: requestedName });
    const baseDetails = {
      adapterId: id,
      kind,
      priority,
      origin: canonical,
      ...(requestedName === undefined ? {} : { capability: requestedName }),
    };
    if (!origins.some((bound) => originsEqual({ expected: bound, actual: canonical }))) {
      return { ok: true, available: false, ...baseDetails, reason: 'Origin is not bound to this adapter.' };
    }
    if (requestedName !== undefined && capability === null) {
      return { ok: true, available: false, ...baseDetails, reason: 'Capability is not declared by this adapter.' };
    }
    const selectedCapabilities = capability ? [capability] : capabilities;
    const withHandlers = selectedCapabilities.filter((entry) => typeof handlers[entry.name] === 'function' || typeof invoke === 'function');
    if (withHandlers.length === 0) {
      return { ok: true, available: false, ...baseDetails, reason: 'No executable handler is bound to the capability.' };
    }
    let availabilityResult = { available: true };
    if (availability) {
      try {
        const raw = availability({
          adapterId: id,
          kind,
          origin: canonical,
          capability: capability?.name,
          // `request` is the caller's probe context.  The outer fields remain
          // available as probeRequest for integrations that need them.
          request: cloneJson({ value: request.request ?? request }),
          probeRequest: cloneJson({ value: request }),
        });
        if (raw && typeof raw.then === 'function') {
          return { ok: true, available: false, ...baseDetails, reason: 'Asynchronous availability checks are not permitted during routing.' };
        }
        availabilityResult = normalizeAvailability({ result: raw });
      } catch (error) {
        return { ok: true, available: false, ...baseDetails, reason: 'Adapter availability check failed.', error: serializeHandlerError({ error }) };
      }
    }
    let confidence;
    let risk;
    try {
      confidence = normalizeConfidence({ score: availabilityResult.confidence, fallback: capability?.confidence ?? adapterConfidence.score, rationale: availabilityResult.confidenceRationale ?? capability?.confidenceMetadata?.rationale ?? adapterConfidence.rationale });
      risk = normalizeRisk({ score: availabilityResult.riskScore, level: availabilityResult.riskLevel, factors: availabilityResult.riskFactors ?? capability?.risk?.factors ?? adapterRisk.factors, fallback: capability?.riskScore ?? adapterRisk.score });
    } catch (error) {
      return { ok: true, available: false, ...baseDetails, reason: 'Adapter emitted invalid confidence or risk metadata.', error: serializeHandlerError({ error }) };
    }
    const metadata = makeMetadata({
      adapterId: id,
      kind,
      origin: canonical,
      capability: capability?.name,
      confidence,
      risk,
      evidence: availabilityResult.evidence,
      reason: availabilityResult.reason,
    });
    return {
      ok: true,
      available: availabilityResult.available,
      ...baseDetails,
      confidence: confidence.score,
      confidenceScore: confidence.score,
      confidenceMetadata: confidence,
      risk,
      riskScore: risk.score,
      riskLevel: risk.level,
      metadata,
      ...(availabilityResult.reason === undefined ? {} : { reason: availabilityResult.reason }),
    };
  };

  const finishExecution = ({ request, canonical, capability, value }) => {
    if (!isJsonSafe({ value })) return errorResult({ error: createAdapterError({ code: 'ADAPTER_OUTPUT_INVALID', message: 'Adapter output must be JSON-safe.' }) });
    const validation = validateSchema({ value, schema: capability.outputSchema });
    if (!validation.valid) {
      return errorResult({ error: createAdapterError({ code: 'ADAPTER_OUTPUT_SCHEMA_INVALID', message: 'Adapter output does not match the declared output schema.', details: { errors: validation.errors } }) });
    }
    const confidence = normalizeConfidence({ fallback: capability.confidence });
    const risk = normalizeRisk({ score: capability.riskScore, level: capability.riskLevel, factors: capability.risk.factors });
    return {
      ok: true,
      adapterId: id,
      kind,
      priority,
      origin: canonical,
      capability: capability.name,
      output: cloneJson({ value }),
      metadata: makeMetadata({ adapterId: id, kind, origin: canonical, capability: capability.name, confidence, risk }),
    };
  };

  const execute = (executionInput = {}) => {
    let request;
    try { request = normalizeExecutionRequest({ input: executionInput }); } catch (error) { return errorResult({ error }); }
    let canonical;
    try { canonical = normalizeOrigin({ origin: request.origin }); } catch (error) { return errorResult({ error }); }
    const capability = getCapability({ name: request.capability ?? request.capabilityId ?? request.operation });
    if (capability === null) return errorResult({ error: createAdapterError({ code: 'ADAPTER_CAPABILITY_UNKNOWN', message: 'Capability is not declared by this adapter.' }) });
    if (!origins.some((bound) => originsEqual({ expected: bound, actual: canonical }))) return errorResult({ error: createAdapterError({ code: 'ADAPTER_ORIGIN_MISMATCH', message: 'Request origin is not bound to this adapter.' }) });
    if (capability.mutates) {
      if (request.context.replay === true || request.context.readOnlyReplay === true) return errorResult({ error: createAdapterError({ code: 'ADAPTER_MUTATION_REPLAY_FORBIDDEN', message: 'Mutating capabilities cannot run during read-only replay.' }) });
      const approval = request.context.approvalRecord ?? request.context.approval;
      if (!isPlainObject({ value: approval }) || approval.trusted !== true) return errorResult({ error: createAdapterError({ code: 'ADAPTER_APPROVAL_REQUIRED', message: 'A trusted server-side approval record is required for mutating capabilities.' }) });
      if (approval.origin !== undefined && !originsEqual({ expected: canonical, actual: approval.origin })) return errorResult({ error: createAdapterError({ code: 'ADAPTER_APPROVAL_ORIGIN_MISMATCH', message: 'Approval origin does not match the adapter origin.' }) });
      if (approval.adapterId !== undefined && approval.adapterId !== id) return errorResult({ error: createAdapterError({ code: 'ADAPTER_APPROVAL_ADAPTER_MISMATCH', message: 'Approval adapter does not match the selected adapter.' }) });
      if (approval.capability !== undefined && approval.capability !== capability.name) return errorResult({ error: createAdapterError({ code: 'ADAPTER_APPROVAL_CAPABILITY_MISMATCH', message: 'Approval capability does not match the requested capability.' }) });
    }
    const validation = validateSchema({ value: request.args, schema: capability.inputSchema });
    if (!validation.valid) return errorResult({ error: createAdapterError({ code: 'ADAPTER_ARGUMENT_SCHEMA_INVALID', message: 'Capability arguments do not match the declared input schema.', details: { errors: validation.errors } }) });
    const handler = handlers[capability.name];
    if (typeof handler !== 'function' && typeof invoke !== 'function') return errorResult({ error: createAdapterError({ code: 'ADAPTER_HANDLER_UNAVAILABLE', message: 'No executable handler is bound to the capability.' }) });
    try {
      const value = typeof handler === 'function'
        ? handler({ capability: capability.name, args: cloneJson({ value: request.args }), origin: canonical, context: cloneJson({ value: request.context }), request: cloneJson({ value: request }) })
        : invoke({ capability: capability.name, args: cloneJson({ value: request.args }), origin: canonical, context: cloneJson({ value: request.context }), request: cloneJson({ value: request }) });
      if (value && typeof value.then === 'function') {
        return value.then((resolved) => finishExecution({ request, canonical, capability, value: resolved })).catch((error) => errorResult({ error: serializeHandlerError({ error }) }));
      }
      return finishExecution({ request, canonical, capability, value });
    } catch (error) {
      return errorResult({ error: serializeHandlerError({ error }) });
    }
  };

  const publicCapabilities = descriptor.capabilities.map((capability) => cloneJson({ value: capability }));
  Object.freeze(publicCapabilities);
  return Object.freeze({
    id,
    kind,
    priority,
    ...(origins.length === 1 ? { origin: origins[0] } : {}),
    origins: [...origins],
    capabilities: publicCapabilities,
    describe,
    supports,
    probe,
    execute,
    invoke: execute,
    getCapability,
  });
}
