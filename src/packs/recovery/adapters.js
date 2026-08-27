import { getRecoveryCapability } from './ontology.js';

function adapterError(code, message, details = {}) {
  const error = new Error(message);
  error.name = 'RecoveryAdapterError';
  error.code = code;
  error.details = details;
  return error;
}

function normalizedKey(value) {
  return String(value ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[^A-Za-z0-9]+/g, '')
    .toLowerCase();
}

function schemaObject(schema) {
  let parsed = schema;
  if (typeof schema === 'string') {
    try {
      parsed = JSON.parse(schema);
    } catch {
      throw adapterError('RECOVERY_SCHEMA_INVALID', 'Provider inputSchema is not valid JSON.');
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw adapterError('RECOVERY_SCHEMA_INVALID', 'Provider inputSchema must be an object.');
  }
  if (parsed.properties !== undefined
      && (!parsed.properties || typeof parsed.properties !== 'object' || Array.isArray(parsed.properties))) {
    throw adapterError('RECOVERY_SCHEMA_INVALID', 'Provider inputSchema properties must be an object.');
  }
  if (parsed.required !== undefined
      && (!Array.isArray(parsed.required) || parsed.required.some((field) => typeof field !== 'string' || !field))) {
    throw adapterError('RECOVERY_SCHEMA_INVALID', 'Provider inputSchema required must be an array of field names.');
  }
  return parsed;
}

function propertyForConcept(schema, aliases) {
  const properties = Object.keys(schema.properties ?? {});
  const indexed = new Map(properties.map((name) => [normalizedKey(name), name]));
  for (const alias of aliases) {
    const match = indexed.get(normalizedKey(alias));
    if (match) return match;
  }
  return null;
}

function typeMatches(value, type) {
  if (Array.isArray(type)) return type.some((entry) => typeMatches(value, entry));
  if (type === 'array') return Array.isArray(value);
  if (type === 'object') return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  if (type === 'integer') return Number.isInteger(value);
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (type === 'string') return typeof value === 'string';
  if (type === 'boolean') return typeof value === 'boolean';
  if (type === 'null') return value === null;
  return true;
}

export function validateProviderInput(schemaInput, input) {
  const schema = schemaObject(schemaInput);
  if (!typeMatches(input, schema.type ?? 'object')) {
    throw adapterError('RECOVERY_INPUT_INVALID', `Provider input must be ${schema.type ?? 'object'}.`);
  }
  for (const required of schema.required ?? []) {
    if (!Object.hasOwn(input, required) || input[required] === undefined || input[required] === null || input[required] === '') {
      throw adapterError('RECOVERY_INPUT_REQUIRED', `Provider input is missing ${required}.`, { field: required });
    }
  }
  for (const [field, value] of Object.entries(input)) {
    const definition = schema.properties?.[field];
    if (!definition) continue;
    if (definition.type && !typeMatches(value, definition.type)) {
      throw adapterError('RECOVERY_INPUT_TYPE', `Provider input ${field} must be ${definition.type}.`, {
        field,
        expected: definition.type,
      });
    }
    if (definition.enum && !definition.enum.includes(value)) {
      throw adapterError('RECOVERY_INPUT_VALUE', `Provider input ${field} is outside its allowed values.`, {
        field,
        allowed: definition.enum,
      });
    }
  }
  return input;
}

export function buildRecoveryToolInput(capabilityId, schemaInput, canonicalArguments = {}) {
  const capability = getRecoveryCapability(capabilityId);
  if (!capability) {
    throw adapterError('RECOVERY_CAPABILITY_UNKNOWN', `Unknown recovery capability: ${capabilityId}`, { capabilityId });
  }
  if (!canonicalArguments || typeof canonicalArguments !== 'object' || Array.isArray(canonicalArguments)) {
    throw adapterError('RECOVERY_ARGUMENTS_INVALID', 'Canonical recovery arguments must be an object.', { capabilityId });
  }

  const schema = schemaObject(schemaInput);
  const input = {};
  for (const [concept, value] of Object.entries(canonicalArguments)) {
    if (value === undefined) continue;
    const aliases = [concept, ...(capability.inputAliases[concept] ?? [])];
    const property = propertyForConcept(schema, aliases);
    if (property) input[property] = structuredClone(value);
  }
  return validateProviderInput(schema, input);
}

function pick(source, aliases, fallback = undefined) {
  if (!source || typeof source !== 'object') return fallback;
  const indexed = new Map(Object.keys(source).map((key) => [normalizedKey(key), key]));
  for (const alias of aliases) {
    const key = indexed.get(normalizedKey(alias));
    if (key !== undefined && source[key] !== undefined) return source[key];
  }
  return fallback;
}

function requiredValue(value, capabilityId, field) {
  if (value === undefined || value === null || value === '') {
    throw adapterError('RECOVERY_OUTPUT_REQUIRED', `${capabilityId} output is missing ${field}.`, {
      capabilityId,
      field,
    });
  }
  return value;
}

function numberValue(value, capabilityId, field) {
  const parsed = typeof value === 'number' ? value : Number(String(value ?? '').replace(/[^0-9.-]+/g, ''));
  if (!Number.isFinite(parsed)) {
    throw adapterError('RECOVERY_OUTPUT_TYPE', `${capabilityId} output ${field} must be numeric.`, {
      capabilityId,
      field,
    });
  }
  return parsed;
}

function aliased(payload, capability, field, fallback = undefined) {
  return pick(payload, [field, ...(capability.outputAliases[field] ?? [])], fallback);
}

function canonicalArray(payload, capability, collectionField, itemFields) {
  const source = aliased(payload, capability, collectionField, Array.isArray(payload) ? payload : null);
  if (!Array.isArray(source)) {
    throw adapterError('RECOVERY_OUTPUT_TYPE', `${capability.id} output ${collectionField} must be an array.`, {
      capabilityId: capability.id,
      field: collectionField,
    });
  }
  return source.map((item, index) => Object.fromEntries(itemFields.map((field) => [
    field,
    String(requiredValue(aliased(item, capability, field), capability.id, `${collectionField}[${index}].${field}`)),
  ])));
}

function recordValue(value, capabilityId, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw adapterError('RECOVERY_OUTPUT_TYPE', `${capabilityId} output ${field} must be an object.`, {
      capabilityId,
      field,
    });
  }
  return structuredClone(value);
}

export function canonicalizeRecoveryOutput(capabilityId, payload) {
  const capability = getRecoveryCapability(capabilityId);
  if (!capability) {
    throw adapterError('RECOVERY_CAPABILITY_UNKNOWN', `Unknown recovery capability: ${capabilityId}`, { capabilityId });
  }
  if (!payload || typeof payload !== 'object') {
    throw adapterError('RECOVERY_OUTPUT_INVALID', `${capabilityId} returned a non-object payload.`, { capabilityId });
  }

  if (capabilityId === 'service.health.read') {
    return {
      status: String(requiredValue(aliased(payload, capability, 'status'), capabilityId, 'status')),
      impact: String(requiredValue(aliased(payload, capability, 'impact'), capabilityId, 'impact')),
      errorRate: numberValue(aliased(payload, capability, 'errorRate'), capabilityId, 'errorRate'),
      startedAt: String(requiredValue(aliased(payload, capability, 'startedAt'), capabilityId, 'startedAt')),
      observedAt: String(requiredValue(aliased(payload, capability, 'observedAt'), capabilityId, 'observedAt')),
    };
  }
  if (capabilityId === 'release.history.read') {
    return { releases: canonicalArray(payload, capability, 'releases', ['releaseId', 'summary', 'releasedAt', 'author']) };
  }
  if (capabilityId === 'deployment.history.read') {
    return {
      deployments: canonicalArray(payload, capability, 'deployments', [
        'deploymentId', 'releaseId', 'status', 'deployedAt', 'previousReleaseId',
      ]),
    };
  }
  if (capabilityId === 'recovery.option.prepare') {
    return {
      recoveryOptionId: String(requiredValue(aliased(payload, capability, 'recoveryOptionId'), capabilityId, 'recoveryOptionId')),
      quoteRevision: String(requiredValue(aliased(payload, capability, 'quoteRevision'), capabilityId, 'quoteRevision')),
      targetReleaseId: String(requiredValue(aliased(payload, capability, 'targetReleaseId'), capabilityId, 'targetReleaseId')),
      expiresAt: String(requiredValue(aliased(payload, capability, 'expiresAt'), capabilityId, 'expiresAt')),
      effectSummary: String(requiredValue(aliased(payload, capability, 'effectSummary'), capabilityId, 'effectSummary')),
      preconditions: recordValue(aliased(payload, capability, 'preconditions', {}), capabilityId, 'preconditions'),
    };
  }
  if (capabilityId === 'recovery.option.apply') {
    return {
      operationId: String(requiredValue(aliased(payload, capability, 'operationId'), capabilityId, 'operationId')),
      status: String(requiredValue(aliased(payload, capability, 'status'), capabilityId, 'status')),
      appliedAt: String(requiredValue(aliased(payload, capability, 'appliedAt'), capabilityId, 'appliedAt')),
      activeReleaseId: String(requiredValue(aliased(payload, capability, 'activeReleaseId'), capabilityId, 'activeReleaseId')),
    };
  }
  if (capabilityId === 'status.notice.read') {
    return {
      noticeId: String(requiredValue(aliased(payload, capability, 'noticeId'), capabilityId, 'noticeId')),
      title: String(requiredValue(aliased(payload, capability, 'title'), capabilityId, 'title')),
      body: String(requiredValue(aliased(payload, capability, 'body'), capabilityId, 'body')),
      status: String(requiredValue(aliased(payload, capability, 'status'), capabilityId, 'status')),
      noticeRevision: String(requiredValue(aliased(payload, capability, 'noticeRevision'), capabilityId, 'noticeRevision')),
      updatedAt: String(requiredValue(aliased(payload, capability, 'updatedAt'), capabilityId, 'updatedAt')),
    };
  }
  if (capabilityId === 'status.notice.publish') {
    return {
      publicationId: String(requiredValue(aliased(payload, capability, 'publicationId'), capabilityId, 'publicationId')),
      status: String(requiredValue(aliased(payload, capability, 'status'), capabilityId, 'status')),
      publishedAt: String(requiredValue(aliased(payload, capability, 'publishedAt'), capabilityId, 'publishedAt')),
      noticeRevision: String(requiredValue(aliased(payload, capability, 'noticeRevision'), capabilityId, 'noticeRevision')),
    };
  }
  throw adapterError('RECOVERY_CAPABILITY_UNKNOWN', `No output adapter exists for ${capabilityId}.`, { capabilityId });
}

export function validateRecoveryOutput(capabilityId, output) {
  if (!getRecoveryCapability(capabilityId)) {
    throw adapterError('RECOVERY_CAPABILITY_UNKNOWN', `Unknown recovery capability: ${capabilityId}`, { capabilityId });
  }
  if (!output || typeof output !== 'object') {
    throw adapterError('RECOVERY_OUTPUT_INVALID', `${capabilityId} canonical output must be an object.`, { capabilityId });
  }

  const requireString = (field) => {
    if (typeof output[field] !== 'string' || output[field] === '') {
      throw adapterError('RECOVERY_OUTPUT_INVALID', `${capabilityId} canonical output requires ${field}.`, {
        capabilityId,
        field,
      });
    }
  };
  const requireItems = (field, itemFields) => {
    if (!Array.isArray(output[field])) {
      throw adapterError('RECOVERY_OUTPUT_INVALID', `${capabilityId} canonical output requires ${field}.`, {
        capabilityId,
        field,
      });
    }
    for (const [index, item] of output[field].entries()) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        throw adapterError('RECOVERY_OUTPUT_INVALID', `${capabilityId} ${field}[${index}] must be an object.`, {
          capabilityId,
          field,
          index,
        });
      }
      for (const itemField of itemFields) {
        if (typeof item[itemField] !== 'string' || item[itemField] === '') {
          throw adapterError('RECOVERY_OUTPUT_INVALID', `${capabilityId} ${field}[${index}] requires ${itemField}.`, {
            capabilityId,
            field: itemField,
            index,
          });
        }
      }
    }
  };

  if (capabilityId === 'service.health.read') {
    for (const field of ['status', 'impact', 'startedAt', 'observedAt']) requireString(field);
    if (!Number.isFinite(output.errorRate) || output.errorRate < 0) {
      throw adapterError('RECOVERY_OUTPUT_INVALID', 'Service health requires a non-negative errorRate.', { capabilityId });
    }
  } else if (capabilityId === 'release.history.read') {
    requireItems('releases', ['releaseId', 'summary', 'releasedAt', 'author']);
  } else if (capabilityId === 'deployment.history.read') {
    requireItems('deployments', ['deploymentId', 'releaseId', 'status', 'deployedAt', 'previousReleaseId']);
  } else if (capabilityId === 'recovery.option.prepare') {
    for (const field of ['recoveryOptionId', 'quoteRevision', 'targetReleaseId', 'expiresAt', 'effectSummary']) requireString(field);
    if (!output.preconditions || typeof output.preconditions !== 'object' || Array.isArray(output.preconditions)) {
      throw adapterError('RECOVERY_OUTPUT_INVALID', 'Recovery preparation requires preconditions.', { capabilityId });
    }
  } else if (capabilityId === 'recovery.option.apply') {
    for (const field of ['operationId', 'status', 'appliedAt', 'activeReleaseId']) requireString(field);
    if (output.status !== 'applied') {
      throw adapterError('RECOVERY_OUTPUT_INVALID', 'Recovery mutation did not report applied.', { capabilityId });
    }
  } else if (capabilityId === 'status.notice.read') {
    for (const field of ['noticeId', 'title', 'body', 'status', 'noticeRevision', 'updatedAt']) requireString(field);
  } else if (capabilityId === 'status.notice.publish') {
    for (const field of ['publicationId', 'status', 'publishedAt', 'noticeRevision']) requireString(field);
    if (output.status !== 'published') {
      throw adapterError('RECOVERY_OUTPUT_INVALID', 'Status mutation did not report published.', { capabilityId });
    }
  }
  return output;
}
