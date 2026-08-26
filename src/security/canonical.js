import { createHash } from "node:crypto";
import { SecurityError } from "./errors.js";

const objectHasOwn = Object.prototype.hasOwnProperty;
const DEFAULT_MAX_DEPTH = 100;
const DEFAULT_MAX_ARRAY_LENGTH = 100_000;
const DEFAULT_MAX_OBJECT_KEYS = 100_000;

/**
 * A small, dependency-free canonical JSON encoder.
 *
 * JavaScript's JSON.stringify is not sufficient for security bindings: it
 * silently drops undefined properties, converts non-finite numbers to null,
 * ignores symbol keys and invokes user supplied toJSON methods.  This encoder
 * accepts only JSON data and emits a deterministic representation with object
 * keys sorted by their UTF-16 code units (the ordering used by JCS).
 */
export function canonicalJson(value, options = {}) {
  const settings = {
    maxDepth: options.maxDepth ?? DEFAULT_MAX_DEPTH,
    maxArrayLength: options.maxArrayLength ?? DEFAULT_MAX_ARRAY_LENGTH,
    maxObjectKeys: options.maxObjectKeys ?? DEFAULT_MAX_OBJECT_KEYS,
  };

  if (!Number.isSafeInteger(settings.maxDepth) || settings.maxDepth < 0) {
    throw new SecurityError("INVALID_CANONICAL_OPTIONS", "maxDepth must be a non-negative safe integer.");
  }
  if (!Number.isSafeInteger(settings.maxArrayLength) || settings.maxArrayLength < 0) {
    throw new SecurityError("INVALID_CANONICAL_OPTIONS", "maxArrayLength must be a non-negative safe integer.");
  }
  if (!Number.isSafeInteger(settings.maxObjectKeys) || settings.maxObjectKeys < 0) {
    throw new SecurityError("INVALID_CANONICAL_OPTIONS", "maxObjectKeys must be a non-negative safe integer.");
  }

  const ancestors = new WeakSet();
  return encode(value, "$", 0, ancestors, settings);
}

function encode(value, path, depth, ancestors, settings) {
  if (depth > settings.maxDepth) {
    throw new SecurityError("CANONICAL_JSON_TOO_DEEP", "JSON value exceeds the maximum nesting depth.", {
      details: { path },
    });
  }

  if (value === null) return "null";

  switch (typeof value) {
    case "string":
      assertUnicodeString(value, path);
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) {
        throw new SecurityError("INVALID_CANONICAL_JSON", "JSON numbers must be finite.", {
          details: { path },
        });
      }
      // JSON.stringify already renders -0 as 0.  Keep this explicit because
      // negative zero is otherwise an easy source of binding ambiguity.
      if (Object.is(value, -0)) return "0";
      return JSON.stringify(value);
    case "undefined":
    case "bigint":
    case "function":
    case "symbol":
      throw new SecurityError("INVALID_CANONICAL_JSON", "Value is not JSON-safe.", {
        details: { path, type: typeof value },
      });
    case "object":
      break;
    default:
      throw new SecurityError("INVALID_CANONICAL_JSON", "Value is not JSON-safe.", {
        details: { path },
      });
  }

  if (ancestors.has(value)) {
    throw new SecurityError("INVALID_CANONICAL_JSON", "Cyclic values cannot be canonicalized.", {
      details: { path },
    });
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return encodeArray(value, path, depth, ancestors, settings);
    return encodeObject(value, path, depth, ancestors, settings);
  } finally {
    ancestors.delete(value);
  }
}

function encodeArray(value, path, depth, ancestors, settings) {
  if (value.length > settings.maxArrayLength) {
    throw new SecurityError("CANONICAL_JSON_TOO_LARGE", "Array exceeds the maximum length.", {
      details: { path },
    });
  }

  // JSON.stringify ignores enumerable non-index array properties.  Rejecting
  // them avoids two in-memory values accidentally receiving the same binding.
  const keys = Object.keys(value);
  for (const key of keys) {
    if (!isArrayIndexKey(key, value.length)) {
      throw new SecurityError("INVALID_CANONICAL_JSON", "Arrays may only contain indexed values.", {
        details: { path: `${path}.${key}` },
      });
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) {
      throw new SecurityError("INVALID_CANONICAL_JSON", "Accessor properties are not JSON-safe.", {
        details: { path: `${path}[${key}]` },
      });
    }
  }

  const parts = [];
  for (let index = 0; index < value.length; index += 1) {
    if (!objectHasOwn.call(value, index)) {
      throw new SecurityError("INVALID_CANONICAL_JSON", "Sparse arrays are not JSON-safe.", {
        details: { path: `${path}[${index}]` },
      });
    }
    parts.push(encode(value[index], `${path}[${index}]`, depth + 1, ancestors, settings));
  }
  return `[${parts.join(",")}]`;
}

function encodeObject(value, path, depth, ancestors, settings) {
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new SecurityError("INVALID_CANONICAL_JSON", "Only plain JSON objects are supported.", {
      details: { path },
    });
  }

  const symbols = Object.getOwnPropertySymbols(value);
  if (symbols.some((symbol) => Object.prototype.propertyIsEnumerable.call(value, symbol))) {
    throw new SecurityError("INVALID_CANONICAL_JSON", "Enumerable symbol keys are not JSON-safe.", {
      details: { path },
    });
  }

  const keys = Object.keys(value);
  if (keys.length > settings.maxObjectKeys) {
    throw new SecurityError("CANONICAL_JSON_TOO_LARGE", "Object exceeds the maximum key count.", {
      details: { path },
    });
  }
  keys.sort();

  const parts = [];
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) {
      throw new SecurityError("INVALID_CANONICAL_JSON", "Accessor properties are not JSON-safe.", {
        details: { path: `${path}.${key}` },
      });
    }
    assertUnicodeString(key, `${path}.${key}`);
    parts.push(`${JSON.stringify(key)}:${encode(descriptor.value, `${path}.${key}`, depth + 1, ancestors, settings)}`);
  }
  return `{${parts.join(",")}}`;
}

function isArrayIndexKey(key, length) {
  // Canonical array keys are exactly the own indices in [0, length).
  if (!/^(?:0|[1-9]\d*)$/.test(key)) return false;
  const index = Number(key);
  return Number.isSafeInteger(index) && index >= 0 && index < length && String(index) === key;
}

function assertUnicodeString(value, path) {
  // Lone surrogates have multiple incompatible interpretations across JSON
  // implementations.  Reject them at the security boundary instead of
  // allowing an escaped and unescaped form to bind differently elsewhere.
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new SecurityError("INVALID_CANONICAL_JSON", "Strings may not contain lone surrogates.", {
          details: { path },
        });
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new SecurityError("INVALID_CANONICAL_JSON", "Strings may not contain lone surrogates.", {
        details: { path },
      });
    }
  }
}

/** SHA-256 of the canonical JSON representation, returned as lowercase hex. */
export function canonicalHash(value, options = {}) {
  return createHash("sha256").update(canonicalJson(value, options), "utf8").digest("hex");
}

/** Alias useful at call sites that want to make the algorithm explicit. */
export const sha256Canonical = canonicalHash;

/**
 * Clone JSON data through the canonical representation.  This is used before
 * storing caller-owned values in an audit record or approval snapshot.
 */
export function cloneCanonical(value, options = {}) {
  return JSON.parse(canonicalJson(value, options));
}

