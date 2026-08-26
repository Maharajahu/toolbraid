/**
 * Shared, dependency-free contracts used by all adapter implementations.
 *
 * Adapters are deliberately expressed in terms of semantic capabilities.  A
 * capability is an operation such as `orders.lookup` or `cart.add`; this
 * module does not expose page events, arbitrary code, command execution, or
 * other transport primitives.
 */

export const ADAPTER_KINDS = Object.freeze({
  STRUCTURED_API: 'structured-api',
  WEBMCP: 'webmcp',
  DOM_ACCESSIBILITY: 'dom-accessibility',
  VISION: 'vision',
});

/** The only routing order accepted by the registry. */
export const ADAPTER_PRIORITY = Object.freeze([
  ADAPTER_KINDS.STRUCTURED_API,
  ADAPTER_KINDS.WEBMCP,
  ADAPTER_KINDS.DOM_ACCESSIBILITY,
  ADAPTER_KINDS.VISION,
]);

export const DEFAULT_ADAPTER_METADATA = Object.freeze({
  [ADAPTER_KINDS.STRUCTURED_API]: Object.freeze({ confidence: 0.98, riskScore: 0.1 }),
  [ADAPTER_KINDS.WEBMCP]: Object.freeze({ confidence: 0.9, riskScore: 0.25 }),
  [ADAPTER_KINDS.DOM_ACCESSIBILITY]: Object.freeze({ confidence: 0.75, riskScore: 0.5 }),
  [ADAPTER_KINDS.VISION]: Object.freeze({ confidence: 0.55, riskScore: 0.8 }),
});

const RISK_LEVELS = Object.freeze(['low', 'medium', 'high', 'critical']);
const PROTOCOLS = Object.freeze(['http:', 'https:']);
const RESERVED_CAPABILITY_PARTS = /^(?:click|shell|browser|javascript|eval|exec|keypress|keystroke|mouse)$/i;

const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

export function isPlainObject({ value }) {
  if (value === null || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function isJsonSafe({ value, allowUndefined = false }) {
  const seen = new Set();

  const visit = (candidate) => {
    if (candidate === null) return true;
    if (candidate === undefined) return allowUndefined;
    if (typeof candidate === 'string' || typeof candidate === 'boolean') return true;
    if (typeof candidate === 'number') return Number.isFinite(candidate);
    if (typeof candidate === 'bigint' || typeof candidate === 'function' || typeof candidate === 'symbol') {
      return false;
    }
    if (typeof candidate !== 'object') return false;
    if (seen.has(candidate)) return false;
    seen.add(candidate);
    if (Array.isArray(candidate)) {
      return candidate.every(visit);
    }
    if (!isPlainObject({ value: candidate })) return false;
    return Object.entries(candidate).every(([key, item]) => typeof key === 'string' && visit(item));
  };

  return visit(value);
}

export function cloneJson({ value }) {
  if (!isJsonSafe({ value })) {
    throw new AdapterContractError({
      code: 'ADAPTER_NON_JSON_VALUE',
      message: 'Adapter data must be JSON-safe.',
      retryable: false,
    });
  }
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

export function createAdapterError({
  code = 'ADAPTER_CONTRACT_ERROR',
  message = 'Adapter contract rejected the request.',
  retryable = false,
  details,
} = {}) {
  const error = { code, message, retryable: retryable === true };
  if (details !== undefined && isJsonSafe({ value: details })) error.details = cloneJson({ value: details });
  return error;
}

export class AdapterContractError extends Error {
  constructor({ code, message, retryable = false, details } = {}) {
    const error = createAdapterError({ code, message, retryable, details });
    super(error.message);
    this.name = 'AdapterContractError';
    this.code = error.code;
    this.retryable = error.retryable;
    if (error.details !== undefined) this.details = error.details;
  }

  toJSON() {
    return createAdapterError({
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      details: this.details,
    });
  }
}

export function errorResult({ error, details } = {}) {
  const normalized = error instanceof AdapterContractError
    ? error.toJSON()
    : createAdapterError({
      code: error?.code,
      message: error?.message,
      retryable: error?.retryable,
      details: error?.details,
    });
  if (details !== undefined && normalized.details === undefined && isJsonSafe({ value: details })) {
    normalized.details = cloneJson({ value: details });
  }
  return { ok: false, error: normalized };
}

export function successResult({ value, metadata } = {}) {
  const result = { ok: true };
  if (value !== undefined) {
    if (!isJsonSafe({ value })) {
      return errorResult({
        error: createAdapterError({
          code: 'ADAPTER_NON_JSON_VALUE',
          message: 'Adapter result must be JSON-safe.',
        }),
      });
    }
    result.value = cloneJson({ value });
  }
  if (metadata !== undefined && isJsonSafe({ value: metadata })) result.metadata = cloneJson({ value: metadata });
  return result;
}

function formatPath({ path, key }) {
  return typeof key === 'number' ? `${path}[${key}]` : `${path}.${key}`;
}

function schemaError({ path, keyword, message }) {
  return { path, keyword, message };
}

function schemaTypes({ schema }) {
  if (typeof schema.type === 'string') return [schema.type];
  if (Array.isArray(schema.type) && schema.type.every((type) => typeof type === 'string')) return schema.type;
  return undefined;
}

function jsonTypeMatches({ value, type }) {
  if (type === 'null') return value === null;
  if (type === 'object') return isPlainObject({ value });
  if (type === 'array') return Array.isArray(value);
  if (type === 'string') return typeof value === 'string';
  if (type === 'boolean') return typeof value === 'boolean';
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (type === 'integer') return typeof value === 'number' && Number.isInteger(value);
  return false;
}

function schemaDefinitionErrors({ schema, path = '$', seen = new Set() }) {
  const errors = [];
  if (!isPlainObject({ value: schema })) {
    return [schemaError({ path, keyword: 'schema', message: 'Schema must be a plain JSON object.' })];
  }
  if (seen.has(schema)) {
    return [schemaError({ path, keyword: 'schema', message: 'Schema must not contain cycles.' })];
  }
  seen.add(schema);

  const types = schemaTypes({ schema });
  if (hasOwn(schema, 'type') && !types) {
    errors.push(schemaError({ path, keyword: 'type', message: 'type must be a string or an array of strings.' }));
  }
  if (types) {
    const allowedTypes = new Set(['null', 'boolean', 'object', 'array', 'number', 'integer', 'string']);
    for (const type of types) {
      if (!allowedTypes.has(type)) errors.push(schemaError({ path, keyword: 'type', message: `Unsupported JSON Schema type: ${type}.` }));
    }
  }
  for (const keyword of ['required', 'enum', 'oneOf', 'anyOf', 'allOf']) {
    if (hasOwn(schema, keyword) && !Array.isArray(schema[keyword])) {
      errors.push(schemaError({ path, keyword, message: `${keyword} must be an array.` }));
    }
  }
  if (Array.isArray(schema.required)) {
    const duplicates = new Set();
    for (const key of schema.required) {
      if (typeof key !== 'string' || key.length === 0) errors.push(schemaError({ path, keyword: 'required', message: 'required entries must be non-empty strings.' }));
      if (duplicates.has(key)) errors.push(schemaError({ path, keyword: 'required', message: `Duplicate required property: ${key}.` }));
      duplicates.add(key);
    }
  }
  if (hasOwn(schema, 'properties')) {
    if (!isPlainObject({ value: schema.properties })) {
      errors.push(schemaError({ path, keyword: 'properties', message: 'properties must be an object.' }));
    } else {
      for (const [key, child] of Object.entries(schema.properties)) {
        errors.push(...schemaDefinitionErrors({ schema: child, path: `${path}.properties.${key}`, seen }));
      }
    }
  }
  if (hasOwn(schema, 'items') && !isPlainObject({ value: schema.items })) {
    errors.push(schemaError({ path, keyword: 'items', message: 'items must be a schema object.' }));
  } else if (hasOwn(schema, 'items')) {
    errors.push(...schemaDefinitionErrors({ schema: schema.items, path: `${path}.items`, seen }));
  }
  for (const keyword of ['additionalProperties', 'additionalItems']) {
    if (hasOwn(schema, keyword) && typeof schema[keyword] !== 'boolean' && !isPlainObject({ value: schema[keyword] })) {
      errors.push(schemaError({ path, keyword, message: `${keyword} must be a boolean or schema object.` }));
    } else if (hasOwn(schema, keyword) && isPlainObject({ value: schema[keyword] })) {
      errors.push(...schemaDefinitionErrors({ schema: schema[keyword], path: `${path}.${keyword}`, seen }));
    }
  }
  for (const keyword of ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'minLength', 'maxLength', 'minItems', 'maxItems', 'minProperties', 'maxProperties']) {
    if (hasOwn(schema, keyword) && (typeof schema[keyword] !== 'number' || !Number.isFinite(schema[keyword]) || schema[keyword] < 0 && keyword.startsWith('min'))) {
      errors.push(schemaError({ path, keyword, message: `${keyword} must be a finite non-negative number.` }));
    }
  }
  if (hasOwn(schema, 'pattern')) {
    if (typeof schema.pattern !== 'string') errors.push(schemaError({ path, keyword: 'pattern', message: 'pattern must be a string.' }));
    else {
      try { new RegExp(schema.pattern); } catch { errors.push(schemaError({ path, keyword: 'pattern', message: 'pattern must be a valid regular expression.' })); }
    }
  }
  if (hasOwn(schema, 'additionalProperties') && schema.additionalProperties === true && schema.strict === true) {
    errors.push(schemaError({ path, keyword: 'strict', message: 'A strict schema cannot allow arbitrary additional properties.' }));
  }
  if (hasOwn(schema, '$ref')) errors.push(schemaError({ path, keyword: '$ref', message: '$ref is not supported by the dependency-free validator.' }));
  seen.delete(schema);
  return errors;
}

export function validateSchemaDefinition({ schema, name = 'schema' } = {}) {
  const errors = schemaDefinitionErrors({ schema, path: name });
  return { valid: errors.length === 0, errors };
}

function validateValue({ value, schema, path, errors }) {
  if (!isPlainObject({ value: schema })) {
    errors.push(schemaError({ path, keyword: 'schema', message: 'Schema must be a plain JSON object.' }));
    return;
  }
  if (hasOwn(schema, 'const') && JSON.stringify(value) !== JSON.stringify(schema.const)) {
    errors.push(schemaError({ path, keyword: 'const', message: 'Value does not equal const.' }));
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((entry) => JSON.stringify(entry) === JSON.stringify(value))) {
    errors.push(schemaError({ path, keyword: 'enum', message: 'Value is not one of the allowed enum values.' }));
  }
  const types = schemaTypes({ schema });
  if (types && !types.some((type) => jsonTypeMatches({ value, type }))) {
    errors.push(schemaError({ path, keyword: 'type', message: `Expected ${types.join(' or ')}.` }));
    return;
  }
  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) errors.push(schemaError({ path, keyword: 'minLength', message: 'String is shorter than minLength.' }));
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) errors.push(schemaError({ path, keyword: 'maxLength', message: 'String is longer than maxLength.' }));
    if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern).test(value)) errors.push(schemaError({ path, keyword: 'pattern', message: 'String does not match pattern.' }));
    if (schema.format === 'uri' || schema.format === 'uri-reference') {
      try { new URL(value); } catch { errors.push(schemaError({ path, keyword: 'format', message: 'String is not a valid URI.' })); }
    }
  }
  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) errors.push(schemaError({ path, keyword: 'minimum', message: 'Number is below minimum.' }));
    if (typeof schema.maximum === 'number' && value > schema.maximum) errors.push(schemaError({ path, keyword: 'maximum', message: 'Number is above maximum.' }));
    if (typeof schema.exclusiveMinimum === 'number' && value <= schema.exclusiveMinimum) errors.push(schemaError({ path, keyword: 'exclusiveMinimum', message: 'Number is not above exclusiveMinimum.' }));
    if (typeof schema.exclusiveMaximum === 'number' && value >= schema.exclusiveMaximum) errors.push(schemaError({ path, keyword: 'exclusiveMaximum', message: 'Number is not below exclusiveMaximum.' }));
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) errors.push(schemaError({ path, keyword: 'minItems', message: 'Array has fewer than minItems entries.' }));
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) errors.push(schemaError({ path, keyword: 'maxItems', message: 'Array has more than maxItems entries.' }));
    if (isPlainObject({ value: schema.items })) value.forEach((entry, index) => validateValue({ value: entry, schema: schema.items, path: formatPath({ path, key: index }), errors }));
  }
  if (isPlainObject({ value })) {
    const properties = isPlainObject({ value: schema.properties }) ? schema.properties : {};
    if (Array.isArray(schema.required)) {
      for (const key of schema.required) if (!hasOwn(value, key)) errors.push(schemaError({ path, keyword: 'required', message: `Missing required property: ${key}.` }));
    }
    if (typeof schema.minProperties === 'number' && Object.keys(value).length < schema.minProperties) errors.push(schemaError({ path, keyword: 'minProperties', message: 'Object has fewer than minProperties entries.' }));
    if (typeof schema.maxProperties === 'number' && Object.keys(value).length > schema.maxProperties) errors.push(schemaError({ path, keyword: 'maxProperties', message: 'Object has more than maxProperties entries.' }));
    for (const [key, entry] of Object.entries(value)) {
      if (hasOwn(properties, key)) {
        validateValue({ value: entry, schema: properties[key], path: formatPath({ path, key }), errors });
      } else if (schema.additionalProperties === false) {
        errors.push(schemaError({ path: formatPath({ path, key }), keyword: 'additionalProperties', message: 'Additional properties are not allowed.' }));
      } else if (isPlainObject({ value: schema.additionalProperties })) {
        validateValue({ value: entry, schema: schema.additionalProperties, path: formatPath({ path, key }), errors });
      }
    }
  }
  if (Array.isArray(schema.allOf)) {
    for (const child of schema.allOf) validateValue({ value, schema: child, path, errors });
  }
  if (Array.isArray(schema.anyOf) && !schema.anyOf.some((child) => validateSchema({ value, schema: child }).valid)) {
    errors.push(schemaError({ path, keyword: 'anyOf', message: 'Value does not match anyOf schemas.' }));
  }
  if (Array.isArray(schema.oneOf) && schema.oneOf.filter((child) => validateSchema({ value, schema: child }).valid).length !== 1) {
    errors.push(schemaError({ path, keyword: 'oneOf', message: 'Value must match exactly one oneOf schema.' }));
  }
  if (isPlainObject({ value: schema.not }) && validateSchema({ value, schema: schema.not }).valid) {
    errors.push(schemaError({ path, keyword: 'not', message: 'Value matches a forbidden schema.' }));
  }
}

export function validateSchema({ value, schema } = {}) {
  const definition = validateSchemaDefinition({ schema });
  if (!definition.valid) return { valid: false, errors: definition.errors };
  if (!isJsonSafe({ value })) return { valid: false, errors: [schemaError({ path: '$', keyword: 'json', message: 'Value must be JSON-safe.' })] };
  const errors = [];
  validateValue({ value, schema, path: '$', errors });
  return { valid: errors.length === 0, errors };
}

export function normalizeOrigin({ origin } = {}) {
  if (typeof origin !== 'string' || origin.trim() !== origin || origin.length === 0) {
    throw new AdapterContractError({ code: 'ADAPTER_ORIGIN_REQUIRED', message: 'A canonical origin string is required.' });
  }
  let parsed;
  try { parsed = new URL(origin); } catch {
    throw new AdapterContractError({ code: 'ADAPTER_ORIGIN_INVALID', message: 'Origin must be a valid URL origin.' });
  }
  if (!PROTOCOLS.includes(parsed.protocol)) {
    throw new AdapterContractError({ code: 'ADAPTER_ORIGIN_PROTOCOL', message: 'Only HTTP(S) origins are supported.' });
  }
  if (parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new AdapterContractError({ code: 'ADAPTER_ORIGIN_NOT_CANONICAL', message: 'Origin must not contain credentials, path, query, or fragment.' });
  }
  if (!parsed.hostname) {
    throw new AdapterContractError({ code: 'ADAPTER_ORIGIN_INVALID', message: 'Origin must include a host.' });
  }
  // URL.host lower-cases DNS names and retains an explicitly non-default port.
  return `${parsed.protocol}//${parsed.host}`;
}

export function originsEqual({ expected, actual } = {}) {
  try { return normalizeOrigin({ origin: expected }) === normalizeOrigin({ origin: actual }); } catch { return false; }
}

export function normalizeOrigins({ origins, origin } = {}) {
  const values = origins ?? (origin === undefined ? undefined : [origin]);
  if (!Array.isArray(values) || values.length === 0) {
    throw new AdapterContractError({ code: 'ADAPTER_ORIGIN_REQUIRED', message: 'At least one bound origin is required.' });
  }
  const normalized = [];
  for (const entry of values) {
    const canonical = normalizeOrigin({ origin: entry });
    if (!normalized.includes(canonical)) normalized.push(canonical);
  }
  return normalized;
}

export function validateCapabilityName({ name } = {}) {
  if (typeof name !== 'string' || !/^[a-z][a-z0-9]*(?:[._:-][a-z0-9]+)*$/i.test(name) || name.length > 120) {
    throw new AdapterContractError({ code: 'ADAPTER_CAPABILITY_INVALID', message: 'Capability names must be semantic, bounded identifiers.' });
  }
  if (name.split(/[._:-]/).some((part) => RESERVED_CAPABILITY_PARTS.test(part))) {
    throw new AdapterContractError({ code: 'ADAPTER_RAW_OPERATION_FORBIDDEN', message: 'Raw interaction or code capabilities are not part of the adapter contract.' });
  }
  return name;
}

export function normalizeConfidence({ score, rationale = [], fallback } = {}) {
  const candidate = score === undefined ? fallback : score;
  if (typeof candidate !== 'number' || !Number.isFinite(candidate) || candidate < 0 || candidate > 1) {
    throw new AdapterContractError({ code: 'ADAPTER_CONFIDENCE_INVALID', message: 'Confidence must be a number between 0 and 1.' });
  }
  const reasons = Array.isArray(rationale) ? rationale.filter((entry) => typeof entry === 'string').slice(0, 16) : [];
  const band = candidate >= 0.85 ? 'high' : candidate >= 0.6 ? 'medium' : 'low';
  return { score: candidate, band, rationale: reasons };
}

export function normalizeRisk({ score, level, factors = [], fallback } = {}) {
  const candidate = score === undefined ? fallback : score;
  if (typeof candidate !== 'number' || !Number.isFinite(candidate) || candidate < 0 || candidate > 1) {
    throw new AdapterContractError({ code: 'ADAPTER_RISK_INVALID', message: 'Risk score must be a number between 0 and 1.' });
  }
  const derived = candidate >= 0.85 ? 'critical' : candidate >= 0.6 ? 'high' : candidate >= 0.3 ? 'medium' : 'low';
  const chosen = level ?? derived;
  if (!RISK_LEVELS.includes(chosen)) {
    throw new AdapterContractError({ code: 'ADAPTER_RISK_INVALID', message: 'Risk level must be low, medium, high, or critical.' });
  }
  // A caller may provide a stricter level, but never a materially safer level
  // than the score implies.
  const rank = { low: 0, medium: 1, high: 2, critical: 3 };
  if (rank[chosen] < rank[derived]) {
    throw new AdapterContractError({ code: 'ADAPTER_RISK_INVALID', message: 'Risk level cannot understate the risk score.' });
  }
  const details = Array.isArray(factors) ? factors.filter((entry) => typeof entry === 'string').slice(0, 16) : [];
  return { score: candidate, level: chosen, factors: details };
}

export function makeMetadata({ adapterId, kind, origin, capability, confidence, risk, evidence = [], reason } = {}) {
  const metadata = {
    adapterId,
    kind,
    ...(origin === undefined ? {} : { origin }),
    ...(capability === undefined ? {} : { capability }),
    confidence: confidence.score,
    confidenceScore: confidence.score,
    confidenceMetadata: confidence,
    risk,
    riskScore: risk.score,
    riskLevel: risk.level,
    evidence: Array.isArray(evidence) ? evidence.filter((entry) => typeof entry === 'string').slice(0, 16) : [],
  };
  if (reason !== undefined) metadata.reason = reason;
  return metadata;
}

export function assertRecord({ value, name = 'value' } = {}) {
  if (!isPlainObject({ value })) {
    throw new AdapterContractError({ code: 'ADAPTER_INPUT_INVALID', message: `${name} must be a plain object.` });
  }
  return value;
}

