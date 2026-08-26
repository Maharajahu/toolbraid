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
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    assertUnicodeString(value, path);
    return value;
  }
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
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw new CoreError('INVALID_JSON', `Symbol properties are not supported at ${path}`);
    }
    for (const name of Object.getOwnPropertyNames(value)) {
      if (name === 'length') continue;
      if (!isArrayIndex(name, value.length)) {
        throw new CoreError('INVALID_JSON', `Non-index array property at ${path}.${name}`);
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, name);
      if (!descriptor || !('value' in descriptor) || descriptor.enumerable !== true) {
        throw new CoreError('INVALID_JSON', `Invalid array property at ${path}[${name}]`);
      }
    }
    result = new Array(value.length);
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.prototype.hasOwnProperty.call(value, index)) {
        throw new CoreError('INVALID_JSON', `Sparse array entry at ${path}[${index}]`);
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      result[index] = clone(descriptor.value, `${path}[${index}]`, allowUndefined, seen);
    }
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new CoreError('INVALID_JSON', `Non-plain object at ${path}`);
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw new CoreError('INVALID_JSON', `Symbol properties are not supported at ${path}`);
    }
    result = {};
    const names = Object.getOwnPropertyNames(value);
    const keys = Object.keys(value);
    if (names.length !== keys.length) {
      throw new CoreError('INVALID_JSON', `Non-enumerable or accessor property at ${path}`);
    }
    for (const key of keys.sort()) {
      assertUnicodeString(key, `${path}.${key}`);
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !('value' in descriptor) || descriptor.enumerable !== true) {
        throw new CoreError('INVALID_JSON', `Accessor property at ${path}.${key}`);
      }
      const child = clone(descriptor.value, `${path}.${key}`, allowUndefined, seen);
      if (child !== undefined) {
        // Assignment to `__proto__` on an ordinary object changes its
        // prototype.  Define JSON keys as data properties so parsed attacker
        // input is cloned exactly and cannot create hash ambiguity.
        Object.defineProperty(result, key, {
          value: child,
          enumerable: true,
          configurable: true,
          writable: true,
        });
      }
    }
  }
  seen.delete(value);
  return result;
}

function isArrayIndex(key, length) {
  if (!/^(?:0|[1-9]\d*)$/.test(key)) return false;
  const index = Number(key);
  return Number.isSafeInteger(index) && index >= 0 && index < length && String(index) === key;
}

function assertUnicodeString(value, path) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new CoreError('INVALID_JSON', `Lone surrogate at ${path}`);
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new CoreError('INVALID_JSON', `Lone surrogate at ${path}`);
    }
  }
}

export function isJsonSafe(value) {
  try {
    jsonClone(value);
    return true;
  } catch {
    return false;
  }
}
