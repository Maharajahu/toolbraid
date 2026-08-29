import {
  freezeDeep,
  sha256Hex,
  stableStringify,
} from '../../universal/canonical.js';

export const CAPABILITY_PACK_MANIFEST_VERSION = 1;
export const DEFAULT_CAPABILITY_PACK_TOOL_BUDGET = 8;
export const MAX_CAPABILITY_PACKS = 128;
export const MAX_CAPABILITY_PACK_ID_LENGTH = 64;
export const MAX_CAPABILITY_PACK_VERSION_LENGTH = 64;
export const MAX_CAPABILITY_PACK_HOSTS = 32;
export const MAX_CAPABILITY_PACK_PATH_HINTS = 32;
export const MAX_CAPABILITY_PACK_OBJECTIVE_TOKENS = 16;
export const MAX_CAPABILITY_PACK_HINT_LENGTH = 128;

export class CapabilityPackError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'CapabilityPackError';
    this.code = code;
    this.details = details;
  }
}

function packError(code, message, details = {}) {
  return new CapabilityPackError(code, message, details);
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function text(value, field, maxLength = MAX_CAPABILITY_PACK_HINT_LENGTH) {
  if (typeof value !== 'string') {
    throw packError('PACK_HINT_INVALID', `${field} must be a string.`, { field });
  }
  const result = value.trim();
  if (!result || result.length > maxLength || result !== value) {
    throw packError('PACK_HINT_INVALID', `${field} is empty, oversized, or not normalized.`, { field });
  }
  return result;
}

function identifier(value, field, maxLength) {
  const result = text(value, field, maxLength);
  if (!/^[A-Za-z0-9_.-]+$/.test(result)) {
    throw packError('PACK_MANIFEST_INVALID', `${field} contains unsupported characters.`, { field });
  }
  return result;
}

function list(value, field, maxItems, normalize) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > maxItems) {
    throw packError('PACK_HINT_INVALID', `${field} must be an array with at most ${maxItems} entries.`, { field });
  }
  const result = value.map((entry, index) => normalize(entry, `${field}[${index}]`));
  return [...new Set(result)].sort((left, right) => left.localeCompare(right));
}

function normalizeHost(value, field) {
  const result = text(value, field, 253).toLowerCase();
  // Host hints deliberately contain hostnames, not origins, paths, wildcard
  // patterns, ports, or userinfo.  Matching is always HTTPS-only below.
  if (result.includes('://') || result.includes('/') || result.includes(':')
      || result.includes('@') || result.includes('*') || /\s/.test(result)) {
    throw packError('PACK_HINT_INVALID', `${field} must be an exact hostname.`, { field });
  }
  try {
    const parsed = new URL(`https://${result}/`);
    if (parsed.protocol !== 'https:' || parsed.hostname !== result || parsed.port
        || parsed.username || parsed.password || parsed.pathname !== '/') {
      throw new Error('hostname is not exact');
    }
  } catch {
    throw packError('PACK_HINT_INVALID', `${field} must be an exact HTTPS hostname.`, { field });
  }
  return result;
}

function normalizePath(value, field) {
  const result = text(value, field);
  if (!result.startsWith('/') || result.includes('?') || result.includes('#') || result.includes('*')
      || result.includes('\\') || result.includes('//')) {
    throw packError('PACK_HINT_INVALID', `${field} must be a normalized literal URL path.`, { field });
  }
  return result;
}

function normalizeObjectiveTokens(value, field) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw packError('PACK_HINT_INVALID', `${field} must be an array of bounded objective hints.`, { field });
  }
  const tokens = [];
  for (const [index, entry] of value.entries()) {
    const source = text(entry, `${field}[${index}]`, MAX_CAPABILITY_PACK_HINT_LENGTH);
    const normalized = source
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .match(/[a-z0-9]+/g) ?? [];
    tokens.push(...normalized);
    if (tokens.length > MAX_CAPABILITY_PACK_OBJECTIVE_TOKENS) {
      throw packError(
        'PACK_HINT_INVALID',
        `${field} contains too many objective tokens.`,
        { field, max: MAX_CAPABILITY_PACK_OBJECTIVE_TOKENS },
      );
    }
  }
  return [...new Set(tokens)].sort((left, right) => left.localeCompare(right));
}

function normalizeHints(rawHints) {
  if (!isPlainObject(rawHints)) {
    throw packError('PACK_HINT_INVALID', 'Capability pack hints must be a plain object.');
  }
  const hosts = list(rawHints.hosts, 'hints.hosts', MAX_CAPABILITY_PACK_HOSTS, normalizeHost);
  const paths = list(rawHints.paths, 'hints.paths', MAX_CAPABILITY_PACK_PATH_HINTS, normalizePath);
  const pathPrefixes = list(rawHints.pathPrefixes, 'hints.pathPrefixes', MAX_CAPABILITY_PACK_PATH_HINTS, normalizePath);
  const objectiveTokens = normalizeObjectiveTokens(
    rawHints.objectiveTokens ?? rawHints.objectives,
    'hints.objectiveTokens',
  );
  if (hosts.length === 0) {
    throw packError('PACK_HINT_INVALID', 'Capability pack hints require at least one exact HTTPS hostname.');
  }
  return freezeDeep({ hosts, paths, pathPrefixes, objectiveTokens });
}

function normalizedPriority(value) {
  if (value === undefined || value === null) return 0;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < -1000 || value > 1000) {
    throw packError('PACK_MANIFEST_INVALID', 'Capability pack priority must be an integer from -1000 to 1000.');
  }
  return value;
}

function normalizedBudget(value) {
  if (value === undefined || value === null) return DEFAULT_CAPABILITY_PACK_TOOL_BUDGET;
  if (!Number.isInteger(value) || value < 1 || value > 128) {
    throw packError('PACK_MANIFEST_INVALID', 'Capability pack maxTools must be an integer from 1 to 128.');
  }
  return value;
}

/**
 * Normalize one statically trusted manifest.  The loader remains on the
 * internal object for the registry, while public projections intentionally
 * omit it.
 */
export function normalizeCapabilityPackManifest(input) {
  if (!isPlainObject(input)) {
    throw packError('PACK_MANIFEST_INVALID', 'Capability pack manifest must be a plain object.');
  }
  if (input.manifestVersion !== undefined && input.manifestVersion !== CAPABILITY_PACK_MANIFEST_VERSION) {
    throw packError(
      'PACK_MANIFEST_VERSION_UNSUPPORTED',
      `Unsupported capability pack manifest version: ${String(input.manifestVersion)}.`,
      { supported: CAPABILITY_PACK_MANIFEST_VERSION },
    );
  }
  const id = identifier(input.id, 'id', MAX_CAPABILITY_PACK_ID_LENGTH);
  const version = identifier(String(input.version ?? '1'), 'version', MAX_CAPABILITY_PACK_VERSION_LENGTH);
  const load = input.load ?? input.loader;
  if (typeof load !== 'function') {
    throw packError('PACK_MANIFEST_INVALID', `Capability pack ${id}@${version} requires a trusted loader.`);
  }
  const manifest = {
    manifestVersion: CAPABILITY_PACK_MANIFEST_VERSION,
    id,
    version,
    priority: normalizedPriority(input.priority),
    maxTools: normalizedBudget(input.maxTools),
    hints: normalizeHints(input.hints),
    load,
  };
  return Object.freeze(manifest);
}

export function capabilityPackManifestKey(manifest) {
  return `${manifest.id}@${manifest.version}`;
}

export function publicCapabilityPackManifest(manifest) {
  return freezeDeep({
    manifestVersion: manifest.manifestVersion,
    id: manifest.id,
    version: manifest.version,
    priority: manifest.priority,
    maxTools: manifest.maxTools,
    hints: {
      hosts: [...manifest.hints.hosts],
      paths: [...manifest.hints.paths],
      pathPrefixes: [...manifest.hints.pathPrefixes],
      objectiveTokens: [...manifest.hints.objectiveTokens],
    },
  });
}

export function createCapabilityPackCatalog(input = []) {
  const entries = Array.isArray(input) ? input : input?.packs;
  if (!Array.isArray(entries) || entries.length > MAX_CAPABILITY_PACKS) {
    throw packError('PACK_CATALOG_INVALID', `Capability pack catalog must contain at most ${MAX_CAPABILITY_PACKS} manifests.`);
  }
  const normalized = entries.map(normalizeCapabilityPackManifest);
  const keys = new Set();
  for (const manifest of normalized) {
    const key = capabilityPackManifestKey(manifest);
    if (keys.has(key)) throw packError('PACK_DUPLICATE', `Duplicate capability pack manifest: ${key}.`, { key });
    keys.add(key);
  }
  normalized.sort((left, right) => left.id.localeCompare(right.id) || left.version.localeCompare(right.version));
  return Object.freeze(normalized);
}

export function catalogRevision(catalog) {
  return sha256Hex(stableStringify(catalog.map(publicCapabilityPackManifest)));
}

/**
 * Match only a parsed HTTPS page location.  A missing path list means all
 * paths on the exact host; when supplied, literal paths and segment-safe
 * prefixes are ORed together.
 */
export function matchCapabilityPackHints(manifest, { protocol, hostname, pathname }) {
  if (protocol !== 'https:' || typeof hostname !== 'string' || typeof pathname !== 'string') return null;
  const host = hostname.toLowerCase();
  if (!manifest.hints.hosts.includes(host)) return null;

  const exactPath = manifest.hints.paths.includes(pathname);
  const prefix = manifest.hints.pathPrefixes.find((candidate) => {
    if (candidate === '/') return true;
    if (pathname === candidate) return true;
    return candidate.endsWith('/') ? pathname.startsWith(candidate) : pathname.startsWith(`${candidate}/`);
  }) ?? null;
  if (manifest.hints.paths.length > 0 || manifest.hints.pathPrefixes.length > 0) {
    if (!exactPath && !prefix) return null;
  }
  return Object.freeze({
    host,
    pathname,
    exactPath,
    pathPrefix: prefix,
    pathSpecificity: exactPath ? pathname.length + 1 : prefix ? prefix.length : 0,
  });
}

/**
 * The built-in catalog starts empty.  Integrators add trusted manifests in
 * code; no page snapshot or provider payload is ever merged into this array.
 */
export const UNIVERSAL_CAPABILITY_PACK_CATALOG = Object.freeze([]);
