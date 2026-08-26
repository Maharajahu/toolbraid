const DEFAULT_REPLACEMENT = "[REDACTED]";
const UNSERIALIZABLE = "[UNSERIALIZABLE]";
const SECRET_KEYS = new Set([
  "accesskey",
  "accesstoken",
  "apikey",
  "authorization",
  "bearer",
  "clientsecret",
  "cookie",
  "credential",
  "credentials",
  "cvv",
  "jwt",
  "nonce",
  "oauth",
  "password",
  "passcode",
  "passwd",
  "passphrase",
  "privatekey",
  "refreshkey",
  "refreshtoken",
  "secret",
  "secretkey",
  "session",
  "sessionid",
  "setcookie",
  "signature",
  "ssn",
  "token",
  "totp",
]);

/** Return true for object keys that should never appear in audit output. */
export function isSecretLikeKey(key) {
  if (typeof key !== "string") return false;
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/gu, "");
  if (!normalized) return false;
  if (SECRET_KEYS.has(normalized)) return true;
  return [
    "key",
    "token",
    "secret",
    "password",
    "credential",
    "authorization",
    "cookie",
    "nonce",
    "signature",
  ].some((suffix) => normalized.endsWith(suffix));
}

/**
 * Deeply copy JSON-like data while replacing values below secret-like keys.
 * The input is never mutated.  Cycles, accessors and unsupported values are
 * replaced with a marker rather than being serialized accidentally.
 */
export function redactSecrets(value, options = {}) {
  const replacement = options.replacement ?? DEFAULT_REPLACEMENT;
  const maxDepth = options.maxDepth ?? 100;
  const seen = new WeakSet();
  return walkRedact(value, "$", 0, seen, replacement, maxDepth, false);
}

export const redact = redactSecrets;

function walkRedact(value, path, depth, seen, replacement, maxDepth, underSecretKey) {
  if (depth > maxDepth) return UNSERIALIZABLE;
  if (underSecretKey) return replacement;
  if (value === null) return null;

  switch (typeof value) {
    case "string":
    case "boolean":
      return value;
    case "number":
      return Number.isFinite(value) ? value : UNSERIALIZABLE;
    case "undefined":
    case "bigint":
    case "function":
    case "symbol":
      return UNSERIALIZABLE;
    case "object":
      break;
    default:
      return UNSERIALIZABLE;
  }

  if (seen.has(value)) return UNSERIALIZABLE;
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const result = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.prototype.hasOwnProperty.call(value, index)) {
          result.push(UNSERIALIZABLE);
          continue;
        }
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !("value" in descriptor)) {
          result.push(UNSERIALIZABLE);
          continue;
        }
        result.push(walkRedact(descriptor.value, `${path}[${index}]`, depth + 1, seen, replacement, maxDepth, false));
      }
      return result;
    }

    const result = Object.create(null);
    for (const key of Object.keys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor)) {
        result[key] = UNSERIALIZABLE;
        continue;
      }
      result[key] = walkRedact(
        descriptor.value,
        `${path}.${key}`,
        depth + 1,
        seen,
        replacement,
        maxDepth,
        isSecretLikeKey(key),
      );
    }
    return result;
  } finally {
    seen.delete(value);
  }
}
