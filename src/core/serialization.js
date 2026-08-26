import { createHash } from 'node:crypto';
import { CoreError } from './errors.js';

/**
 * Convert a value to the small JSON subset accepted by the control plane.
 * Values crossing an adapter/security boundary are rejected rather than
 * coerced.  This makes argument hashing and persistence unambiguous.
 */
export function jsonClone(value, options = {}) {
  const { path = '$', allowUndefined = false } = options;
  return clone(value, path, allowUndefined, new Set());
}

export function stableStringify(value, options = {}) {
  return JSON.stringify(jsonClone(value, options));
}

export function canonicalHash(value) {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

function clone(value, path, allowUndefined, seen) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new CoreError('INVALID_JSON', `Non-finite number at ${path}`);
    }
    return value;
  }
  if (value === undefined) {
    if (allowUndefined) return undefined;
    throw new CoreError('INVALID_JSON', `Undefined value at ${path}`);
  }
  if (typeof value === 'bigint' || typeof value === 'function' || typeof value === 'symbol') {
    throw new CoreError('INVALID_JSON', `Unsupported value at ${path}`);
  }
  if (typeof value !== 'object') {
    throw new CoreError('INVALID_JSON', `Unsupported value at ${path}`);
  }
  if (seen.has(value)) throw new CoreError('INVALID_JSON', `Circular value at ${path}`);
  seen.add(value);

  let result;
  if (Array.isArray(value)) {
    result = value.map((entry, index) => clone(entry, `${path}[${index}]`, allowUndefined, seen));
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new CoreError('INVALID_JSON', `Non-plain object at ${path}`);
    }
    result = {};
    for (const key of Object.keys(value).sort()) {
      const child = clone(value[key], `${path}.${key}`, allowUndefined, seen);
      if (child !== undefined) result[key] = child;
    }
  }
  seen.delete(value);
  return result;
}

export function isJsonSafe(value) {
  try {
    jsonClone(value);
    return true;
  } catch {
    return false;
  }
}

