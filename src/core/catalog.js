import { CoreError } from './errors.js';
import { requireIdentity, sameIdentity } from './identity.js';
import { jsonClone } from './serialization.js';

const CAPABILITY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._+\-]{0,63}$/;
const FORBIDDEN_ROOT_KEYS = new Set([
  'code', 'command', 'cookie', 'evaluate', 'exec', 'execute', 'function',
  'javascript', 'raw', 'script', 'shell', 'selector', 'shellCommand',
  'xpath',
]);
const FORBIDDEN_CAPABILITY_NAMES = new Set([
  'click', 'dom.click', 'page.click', 'shell', 'shell.exec', 'javascript',
  'javascript.eval', 'page.evaluate', 'browser.evaluate', 'raw.click',
]);

/**
 * In-memory capability catalog.  The catalog is intentionally tenant scoped:
 * records registered through an identity are visible only to that tenant,
 * while constructor-provided records may be public (`tenantId: "*"`).
 */
export class CapabilityCatalog {
  #records = new Map();

  constructor(options = {}) {
    if (!options || typeof options !== 'object' || Array.isArray(options)) {
      throw new CoreError('INVALID_CATALOG', 'Catalog options must be an object');
    }
    if (options.capabilities !== undefined) {
      if (!Array.isArray(options.capabilities)) {
        throw new CoreError('INVALID_CATALOG', 'capabilities must be an array');
      }
      for (const capability of options.capabilities) {
        const normalized = normalizeCapability(capability, { tenantId: '*' });
        this.#insert(normalized, false);
      }
    }
  }

  register(input) {
    const operation = requireObject(input, 'register input');
    const identity = requireIdentity(operation);
    const capability = normalizeCapability(operation.capability, identity);
    this.#insert(capability, operation.replace === true);
    return jsonClone(capability);
  }

  registerMany(input) {
    const operation = requireObject(input, 'registerMany input');
    const identity = requireIdentity(operation);
    if (!Array.isArray(operation.capabilities) || operation.capabilities.length === 0) {
      throw new CoreError('INVALID_CAPABILITY', 'capabilities must be a non-empty array');
    }
    const result = [];
    // Validate the complete batch before changing the catalog.  A malformed
    // provider response must not leave a partially updated catalog.
    const normalized = operation.capabilities.map((capability) => normalizeCapability(capability, identity));
    for (const capability of normalized) {
      this.#insert(capability, operation.replace === true);
      result.push(jsonClone(capability));
    }
    return { capabilities: result };
  }

  remove(input) {
    const operation = requireObject(input, 'remove input');
    const identity = requireIdentity(operation);
    const id = requireCapabilityId(operation.capabilityId ?? operation.id);
    const version = normalizeVersion(operation.version);
    const key = recordKey(id, version);
    const record = this.#records.get(key);
    if (!record || !visibleTo(record, identity)) {
      throw new CoreError('CAPABILITY_NOT_FOUND', 'Capability was not found');
    }
    // Tenant registrations can only remove their own record.  A public record
    // can be removed only by a caller that explicitly supplied the same public
    // scope at construction time (there is no public mutating API for that).
    if (record.tenantId !== identity.tenantId) {
      throw new CoreError('CAPABILITY_FORBIDDEN', 'Capability is outside the tenant scope');
    }
    this.#records.delete(key);
    return { removed: true, capabilityId: id, version };
  }

  search(input) {
    const operation = requireObject(input, 'search input');
    const identity = requireIdentity(operation);
    const query = normalizeQuery(operation.query ?? operation.q ?? '');
    const tags = normalizeStringList(operation.tags, 'tags');
    const adapter = optionalString(operation.adapter ?? operation.adapterId, 'adapter');
    const origin = optionalString(operation.origin, 'origin');
    const readOnly = optionalBoolean(operation.readOnly, 'readOnly');
    const limit = normalizeLimit(operation.limit);
    const candidates = [];
    for (const record of this.#records.values()) {
      if (!visibleTo(record, identity)) continue;
      if (readOnly !== undefined && record.readOnly !== readOnly) continue;
      if (adapter && !record.adapters.some((entry) => entry.id === adapter)) continue;
      if (origin && !record.origins.includes(origin)) continue;
      if (tags.length && !tags.every((tag) => record.tags.includes(tag))) continue;
      const score = scoreRecord(record, query);
      if (query && score <= 0) continue;
      candidates.push({ record, score });
    }
    candidates.sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      return compareRecord(left.record, right.record);
    });
    const offset = normalizeCursor(operation.cursor);
    const selected = candidates.slice(offset, offset + limit).map(({ record }) => searchView(record));
    const nextOffset = offset + selected.length;
    const result = {
      capabilities: selected,
      nextCursor: nextOffset < candidates.length ? String(nextOffset) : null,
    };
    // `items` is a useful compatibility alias for callers that use the common
    // paginated-list vocabulary.  It contains exactly the same JSON values.
    result.items = result.capabilities;
    return result;
  }

  describe(input) {
    const operation = requireObject(input, 'describe input');
    const identity = requireIdentity(operation);
    const id = requireCapabilityId(operation.capabilityId ?? operation.id);
    const version = normalizeVersion(operation.version);
    const record = this.#records.get(recordKey(id, version));
    if (!record || !visibleTo(record, identity)) {
      throw new CoreError('CAPABILITY_NOT_FOUND', 'Capability was not found');
    }
    return jsonClone(record);
  }

  list(input) {
    const operation = requireObject(input, 'list input');
    return this.search({ ...operation, query: '' });
  }

  has(input) {
    const operation = requireObject(input, 'has input');
    const identity = requireIdentity(operation);
    const id = requireCapabilityId(operation.capabilityId ?? operation.id);
    const version = normalizeVersion(operation.version);
    const record = this.#records.get(recordKey(id, version));
    return Boolean(record && visibleTo(record, identity));
  }

  // Internal use by the planner/execution broker.  It still requires explicit
  // identity and returns a clone so callers cannot mutate catalog state.
  resolve(input) {
    const operation = requireObject(input, 'resolve input');
    const identity = requireIdentity(operation);
    const id = requireCapabilityId(operation.capabilityId ?? operation.id);
    const version = normalizeVersion(operation.version);
    const record = this.#records.get(recordKey(id, version));
    if (!record || !visibleTo(record, identity)) {
      throw new CoreError('CAPABILITY_NOT_FOUND', 'Capability was not found');
    }
    return jsonClone(record);
  }

  #insert(capability, replace) {
    const key = recordKey(capability.id, capability.version);
    if (this.#records.has(key) && !replace) {
      throw new CoreError('CAPABILITY_CONFLICT', 'Capability version is already registered', {
        details: { capabilityId: capability.id, version: capability.version },
      });
    }
    this.#records.set(key, capability);
  }
}

export function normalizeCapability(value, scope = { tenantId: '*' }) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new CoreError('INVALID_CAPABILITY', 'Capability must be an object');
  }
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_ROOT_KEYS.has(key.toLowerCase())) {
      throw new CoreError('UNSAFE_CAPABILITY', `Capability field ${key} is not allowed`);
    }
  }
  const id = requireCapabilityId(value.id ?? value.capabilityId);
  if (FORBIDDEN_CAPABILITY_NAMES.has(id.toLowerCase())) {
    throw new CoreError('UNSAFE_CAPABILITY', 'Raw browser or shell primitives are not capabilities');
  }
  const version = normalizeVersion(value.version);
  const readOnly = value.readOnly ?? (typeof value.mutates === 'boolean' ? !value.mutates : undefined);
  if (typeof readOnly !== 'boolean') {
    throw new CoreError('INVALID_CAPABILITY', 'Capability readOnly must be explicit');
  }
  if (typeof value.mutates === 'boolean' && value.mutates === readOnly) {
    throw new CoreError('INVALID_CAPABILITY', 'Capability mutates and readOnly disagree');
  }
  if (value.operation !== undefined && value.operation !== 'read' && value.operation !== 'write') {
    throw new CoreError('INVALID_CAPABILITY', 'Capability operation must be read or write');
  }
  if (value.operation === 'read' && !readOnly || value.operation === 'write' && readOnly) {
    throw new CoreError('INVALID_CAPABILITY', 'Capability operation disagrees with readOnly');
  }
  const tenantId = value.tenantId ?? scope.tenantId;
  if (typeof tenantId !== 'string' || tenantId.length === 0) {
    throw new CoreError('INVALID_CAPABILITY', 'Capability tenant scope is invalid');
  }
  if (scope.tenantId !== '*' && tenantId !== scope.tenantId) {
    throw new CoreError('CAPABILITY_FORBIDDEN', 'Capability tenant scope does not match identity');
  }
  const adapters = normalizeAdapters(value.adapters ?? value.adapter);
  const origins = normalizeStringList(value.origins ?? value.origin, 'origins');
  const tags = normalizeStringList(value.tags, 'tags');
  const description = optionalString(value.description, 'description') ?? '';
  const name = optionalString(value.name, 'name') ?? id;
  const inputSchema = value.inputSchema === undefined ? {} : jsonClone(value.inputSchema);
  const outputSchema = value.outputSchema === undefined ? {} : jsonClone(value.outputSchema);
  const metadata = value.metadata === undefined ? {} : jsonClone(value.metadata);
  const normalized = {
    id,
    version,
    name,
    description,
    readOnly,
    mutates: !readOnly,
    operation: value.operation ?? (readOnly ? 'read' : 'write'),
    inputSchema,
    outputSchema,
    adapters,
    origins,
    tags,
    metadata,
    tenantId,
  };
  if (value.provider !== undefined) normalized.provider = jsonClone(value.provider);
  if (value.providerMetadata !== undefined) normalized.providerMetadata = jsonClone(value.providerMetadata);
  return normalized;
}

function searchView(record) {
  return {
    id: record.id,
    version: record.version,
    name: record.name,
    description: record.description,
    readOnly: record.readOnly,
    mutates: record.mutates,
    adapters: record.adapters,
    origins: record.origins,
    tags: record.tags,
  };
}

function scoreRecord(record, query) {
  if (!query) return 0;
  const haystack = [record.id, record.name, record.description, ...record.tags].map((value) => value.toLowerCase());
  const tokens = query.split(/\s+/).filter(Boolean);
  let score = 0;
  for (const token of tokens) {
    if (record.id.toLowerCase() === token) score += 100;
    else if (record.id.toLowerCase().startsWith(token)) score += 50;
    else if (record.name.toLowerCase().includes(token)) score += 20;
    else if (haystack.some((value) => value.includes(token))) score += 10;
    else return 0;
  }
  return score;
}

function visibleTo(record, identity) {
  return record.tenantId === '*' || record.tenantId === identity.tenantId;
}

function compareRecord(left, right) {
  return left.id.localeCompare(right.id) || left.version.localeCompare(right.version);
}

function recordKey(id, version) {
  return `${id}@${version}`;
}

function requireCapabilityId(value) {
  if (typeof value !== 'string' || !CAPABILITY_ID.test(value)) {
    throw new CoreError('INVALID_CAPABILITY', 'capabilityId must be a valid identifier');
  }
  return value;
}

function normalizeVersion(value) {
  const version = value ?? '1';
  if (typeof version !== 'string' || !VERSION.test(version)) {
    throw new CoreError('INVALID_CAPABILITY', 'Capability version must be a valid identifier');
  }
  return version;
}

function normalizeAdapters(value) {
  if (value === undefined) return [];
  const list = Array.isArray(value) ? value : [value];
  const result = [];
  for (const entry of list) {
    if (typeof entry === 'string') {
      if (!entry) throw new CoreError('INVALID_CAPABILITY', 'Adapter id cannot be empty');
      result.push({ id: entry });
    } else if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      const id = optionalString(entry.id ?? entry.adapterId ?? entry.name, 'adapter.id');
      if (!id) throw new CoreError('INVALID_CAPABILITY', 'Adapter id is required');
      const normalized = { id };
      if (entry.version !== undefined) normalized.version = optionalString(entry.version, 'adapter.version');
      if (entry.kind !== undefined) normalized.kind = optionalString(entry.kind, 'adapter.kind');
      result.push(normalized);
    } else {
      throw new CoreError('INVALID_CAPABILITY', 'Adapter must be a string or object');
    }
  }
  result.sort((left, right) => left.id.localeCompare(right.id) || String(left.version ?? '').localeCompare(String(right.version ?? '')));
  const unique = new Map(result.map((entry) => [`${entry.id}@${entry.version ?? ''}`, entry]));
  return [...unique.values()];
}

function normalizeStringList(value, field) {
  if (value === undefined) return [];
  const list = Array.isArray(value) ? value : [value];
  const result = [];
  for (const entry of list) {
    if (typeof entry !== 'string' || entry.length === 0 || entry.length > 200) {
      throw new CoreError('INVALID_CAPABILITY', `${field} entries must be non-empty strings`);
    }
    result.push(entry);
  }
  return [...new Set(result)].sort((left, right) => left.localeCompare(right));
}

function normalizeQuery(value) {
  if (typeof value !== 'string') throw new CoreError('INVALID_QUERY', 'query must be a string');
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

function normalizeLimit(value) {
  if (value === undefined) return 20;
  if (!Number.isInteger(value) || value < 1 || value > 100) {
    throw new CoreError('INVALID_QUERY', 'limit must be an integer from 1 to 100');
  }
  return value;
}

function normalizeCursor(value) {
  if (value === undefined || value === null || value === '') return 0;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) throw new CoreError('INVALID_QUERY', 'cursor is invalid');
  return Number(value);
}

function optionalString(value, field) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || value.length > 500) throw new CoreError('INVALID_CAPABILITY', `${field} must be a string`);
  return value;
}

function optionalBoolean(value, field) {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw new CoreError('INVALID_QUERY', `${field} must be boolean`);
  return value;
}

function requireObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new CoreError('INVALID_INPUT', `${label} must be an object`);
  }
  return value;
}

