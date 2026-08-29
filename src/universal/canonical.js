/**
 * Small JSON-only primitives shared by the universal page model.
 *
 * This module deliberately has no browser or Node dependencies.  Keeping the
 * canonical representation here means a snapshot, a generated descriptor,
 * and a prepared action can be compared in the extension, a worker, or a
 * plain Node test with the same result.
 */

export class UniversalDataError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'UniversalDataError';
    this.code = code;
    this.details = details;
  }
}

function dataError(code, message, details = {}) {
  return new UniversalDataError(code, message, details);
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Return a deterministic JSON-compatible clone with sorted object keys.
 * Undefined, functions, symbols, bigint values, class instances, and cycles
 * are rejected rather than silently disappearing from a security boundary.
 */
export function canonicalize(value, path = '$', ancestors = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw dataError('UNIVERSAL_VALUE_INVALID', `Non-finite number at ${path}.`, { path });
    return Object.is(value, -0) ? 0 : value;
  }

  if (value === undefined || typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') {
    throw dataError('UNIVERSAL_VALUE_INVALID', `Value at ${path} is not JSON-compatible.`, { path });
  }

  if (typeof value !== 'object') {
    throw dataError('UNIVERSAL_VALUE_INVALID', `Value at ${path} is not JSON-compatible.`, { path });
  }
  if (ancestors.has(value)) throw dataError('UNIVERSAL_VALUE_CYCLE', `Circular value at ${path}.`, { path });

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((entry, index) => canonicalize(entry, `${path}[${index}]`, ancestors));
    }
    if (!isPlainObject(value)) {
      throw dataError('UNIVERSAL_VALUE_INVALID', `Value at ${path} must be a plain object.`, { path });
    }

    const result = {};
    for (const key of Object.keys(value).sort()) {
      result[key] = canonicalize(value[key], `${path}.${key}`, ancestors);
    }
    return result;
  } finally {
    ancestors.delete(value);
  }
}

export function stableStringify(value) {
  return JSON.stringify(canonicalize(value));
}

/**
 * Synchronous SHA-256, kept local so fingerprinting works before Web Crypto
 * is available (and in the ordinary Node test runner).  The implementation is
 * intentionally the standard SHA-256 compression function, not a browser
 * API shim or a non-cryptographic hash.
 */
export function sha256Hex(value) {
  const text = typeof value === 'string' ? value : stableStringify(value);
  const bytes = new TextEncoder().encode(text);
  const bitLength = bytes.length * 8;
  const wordCount = (((bytes.length + 9 + 63) >> 6) << 4);
  const words = new Array(wordCount).fill(0);

  for (let index = 0; index < bytes.length; index += 1) {
    words[index >> 2] |= bytes[index] << (24 - (index % 4) * 8);
  }
  words[bytes.length >> 2] |= 0x80 << (24 - (bytes.length % 4) * 8);
  words[wordCount - 2] = Math.floor(bitLength / 0x100000000);
  words[wordCount - 1] = bitLength >>> 0;

  const constants = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];
  const hash = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ];
  const rotateRight = (number, amount) => (number >>> amount) | (number << (32 - amount));

  for (let offset = 0; offset < wordCount; offset += 16) {
    const schedule = new Array(64).fill(0);
    for (let index = 0; index < 64; index += 1) {
      if (index < 16) {
        schedule[index] = words[offset + index] | 0;
      } else {
        const x = schedule[index - 15];
        const y = schedule[index - 2];
        const sigma0 = rotateRight(x, 7) ^ rotateRight(x, 18) ^ (x >>> 3);
        const sigma1 = rotateRight(y, 17) ^ rotateRight(y, 19) ^ (y >>> 10);
        schedule[index] = (schedule[index - 16] + sigma0 + schedule[index - 7] + sigma1) | 0;
      }
    }

    let [a, b, c, d, e, f, g, h] = hash;
    for (let index = 0; index < 64; index += 1) {
      const bigSigma1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choice = (e & f) ^ (~e & g);
      const temp1 = (h + bigSigma1 + choice + constants[index] + schedule[index]) | 0;
      const bigSigma0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (bigSigma0 + majority) | 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) | 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) | 0;
    }

    hash[0] = (hash[0] + a) | 0;
    hash[1] = (hash[1] + b) | 0;
    hash[2] = (hash[2] + c) | 0;
    hash[3] = (hash[3] + d) | 0;
    hash[4] = (hash[4] + e) | 0;
    hash[5] = (hash[5] + f) | 0;
    hash[6] = (hash[6] + g) | 0;
    hash[7] = (hash[7] + h) | 0;
  }

  return hash.map((number) => (number >>> 0).toString(16).padStart(8, '0')).join('');
}

export function cloneJson(value, path = '$') {
  return canonicalize(value, path);
}

export function freezeDeep(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freezeDeep(child);
  return Object.freeze(value);
}

export function assertPlainObject(value, field) {
  if (!isPlainObject(value)) {
    throw dataError('UNIVERSAL_OBJECT_REQUIRED', `${field} must be a plain object.`, { field });
  }
  return value;
}
