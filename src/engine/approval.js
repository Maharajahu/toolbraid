const APPROVAL_VERSION = 2;
const DEFAULT_APPROVAL_TTL_MS = 5 * 60 * 1000;

const BOUND_FIELDS = Object.freeze([
  'version',
  'planId',
  'planRevision',
  'nodeId',
  'toolOrigin',
  'toolName',
  'toolSchemaFingerprint',
  'canonicalCapability',
  'normalizedArguments',
  'effectSummary',
  'risk',
  'nonce',
  'issuedAt',
  'expiresAt',
]);

const EXECUTION_FIELDS = Object.freeze([
  'planId',
  'planRevision',
  'nodeId',
  'toolOrigin',
  'toolName',
  'toolSchemaFingerprint',
  'canonicalCapability',
  'normalizedArguments',
  'effectSummary',
  'risk',
]);

const EXPECTED_KEYS = Object.freeze([...BOUND_FIELDS, 'fingerprint'].sort());
const consumedNonces = new Map();

function approvalError(message, code = 'APPROVAL_INVALID', details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}

function canonicalize(value, path = '$', ancestors = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw approvalError(`Approval data at ${path} must contain a finite number.`, 'APPROVAL_FIELD_INVALID', { path });
    }
    return value;
  }

  if (typeof value !== 'object') {
    throw approvalError(`Approval data at ${path} is not JSON-compatible.`, 'APPROVAL_FIELD_INVALID', { path });
  }

  if (ancestors.has(value)) {
    throw approvalError(`Approval data at ${path} contains a cycle.`, 'APPROVAL_FIELD_INVALID', { path });
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((entry, index) => canonicalize(entry, `${path}[${index}]`, ancestors));
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw approvalError(`Approval data at ${path} must be a plain object.`, 'APPROVAL_FIELD_INVALID', { path });
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

function sha256HexSync(value) {
  const bytes = new TextEncoder().encode(typeof value === 'string' ? value : stableStringify(value));
  const words = [];
  const bitLength = bytes.length * 8;

  for (let index = 0; index < bytes.length; index += 1) {
    words[index >> 2] |= bytes[index] << (24 - (index % 4) * 8);
  }
  words[bitLength >> 5] |= 0x80 << (24 - bitLength % 32);
  words[((bitLength + 64 >> 9) << 4) + 15] = bitLength;

  const hash = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ];
  const constants = [
    0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
    0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
    0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
    0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
    0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
    0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
    0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
    0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2,
  ];
  const rotateRight = (number, amount) => (number >>> amount) | (number << (32 - amount));
  const schedule = new Array(64);

  for (let offset = 0; offset < words.length; offset += 16) {
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

export function sha256Hex(value) {
  return sha256HexSync(value);
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function requireNonEmptyString(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw approvalError(`${field} must be a non-empty string.`, 'APPROVAL_FIELD_INVALID', { field });
  }
}

function requireRevision(value) {
  const validNumber = Number.isInteger(value) && value >= 0;
  const validString = typeof value === 'string' && value.trim() !== '';
  if (!validNumber && !validString) {
    throw approvalError('planRevision must be a non-negative integer or non-empty string.', 'APPROVAL_FIELD_INVALID', { field: 'planRevision' });
  }
}

function requireOrigin(value) {
  requireNonEmptyString(value, 'toolOrigin');
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw approvalError('toolOrigin must be an absolute URL origin.', 'APPROVAL_FIELD_INVALID', { field: 'toolOrigin' });
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== value) {
    throw approvalError('toolOrigin must be a canonical HTTP(S) origin without a path.', 'APPROVAL_FIELD_INVALID', { field: 'toolOrigin' });
  }
}

function timestampMilliseconds(value, field) {
  requireNonEmptyString(value, field);
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) {
    throw approvalError(`${field} must be a valid timestamp.`, 'APPROVAL_FIELD_INVALID', { field });
  }
  return milliseconds;
}

function toIsoTimestamp(value, field) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw approvalError(`${field} must be a valid date.`, 'APPROVAL_FIELD_INVALID', { field });
  }
  return date.toISOString();
}

function requireArguments(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw approvalError('normalizedArguments must be a JSON object.', 'APPROVAL_FIELD_INVALID', { field: 'normalizedArguments' });
  }
  canonicalize(value, '$.normalizedArguments');
}

function requireRisk(value) {
  const validString = typeof value === 'string' && value.trim() !== '';
  const validNumber = typeof value === 'number' && Number.isFinite(value);
  if (!validString && !validNumber) {
    throw approvalError('risk must be a non-empty string or finite number.', 'APPROVAL_FIELD_INVALID', { field: 'risk' });
  }
}

function assertBoundFields(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw approvalError('Approval envelope must be an object.');
  }
  if (value.version !== APPROVAL_VERSION) {
    throw approvalError(`Approval version must be ${APPROVAL_VERSION}.`, 'APPROVAL_VERSION_UNSUPPORTED');
  }

  requireNonEmptyString(value.planId, 'planId');
  requireRevision(value.planRevision);
  requireNonEmptyString(value.nodeId, 'nodeId');
  requireOrigin(value.toolOrigin);
  requireNonEmptyString(value.toolName, 'toolName');
  if (typeof value.toolSchemaFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(value.toolSchemaFingerprint)) {
    throw approvalError('toolSchemaFingerprint must be a lowercase SHA-256 hex digest.', 'APPROVAL_FIELD_INVALID', { field: 'toolSchemaFingerprint' });
  }
  requireNonEmptyString(value.canonicalCapability, 'canonicalCapability');
  requireArguments(value.normalizedArguments);
  requireNonEmptyString(value.effectSummary, 'effectSummary');
  requireRisk(value.risk);
  requireNonEmptyString(value.nonce, 'nonce');

  const issuedAt = timestampMilliseconds(value.issuedAt, 'issuedAt');
  const expiresAt = timestampMilliseconds(value.expiresAt, 'expiresAt');
  if (expiresAt <= issuedAt) {
    throw approvalError('expiresAt must be later than issuedAt.', 'APPROVAL_FIELD_INVALID', { field: 'expiresAt' });
  }
}

function boundProjection(value) {
  return Object.fromEntries(BOUND_FIELDS.map((field) => [field, value[field]]));
}

function cloneJson(value) {
  return JSON.parse(stableStringify(value));
}

function randomNonce() {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function resolveExpiry(issuedAt, suppliedExpiry, ttlMs) {
  if (suppliedExpiry !== undefined && suppliedExpiry !== null) {
    return toIsoTimestamp(suppliedExpiry, 'expiresAt');
  }
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw approvalError('ttlMs must be a positive finite number.', 'APPROVAL_FIELD_INVALID', { field: 'ttlMs' });
  }
  return new Date(Date.parse(issuedAt) + ttlMs).toISOString();
}

/**
 * Creates the exact, provider-independent packet that the human approves.
 * quoteRevision and idempotencyKey, when used, belong inside normalizedArguments.
 */
export function createApprovalEnvelope(binding, options = {}) {
  if (!binding || typeof binding !== 'object' || Array.isArray(binding)) {
    throw approvalError('Approval binding must be an object.', 'APPROVAL_FIELD_INVALID');
  }

  const issuedAt = toIsoTimestamp(binding.issuedAt ?? options.now ?? new Date(), 'issuedAt');
  const envelope = {
    version: binding.version ?? APPROVAL_VERSION,
    planId: binding.planId,
    planRevision: binding.planRevision,
    nodeId: binding.nodeId,
    toolOrigin: binding.toolOrigin,
    toolName: binding.toolName,
    toolSchemaFingerprint: binding.toolSchemaFingerprint,
    canonicalCapability: binding.canonicalCapability,
    normalizedArguments: cloneJson(binding.normalizedArguments),
    effectSummary: binding.effectSummary,
    risk: binding.risk,
    nonce: binding.nonce ?? options.nonce ?? randomNonce(),
    issuedAt,
    expiresAt: resolveExpiry(
      issuedAt,
      binding.expiresAt ?? options.expiresAt,
      options.ttlMs ?? DEFAULT_APPROVAL_TTL_MS,
    ),
  };

  assertBoundFields(envelope);
  return { ...envelope, fingerprint: sha256HexSync(boundProjection(envelope)) };
}

function assertEnvelopeShape(envelope) {
  assertBoundFields(envelope);
  const actualKeys = Object.keys(envelope).sort();
  if (stableStringify(actualKeys) !== stableStringify(EXPECTED_KEYS)) {
    throw approvalError('Approval envelope fields were added or removed.', 'APPROVAL_RECORD_TAMPERED', {
      actualKeys,
      expectedKeys: EXPECTED_KEYS,
    });
  }
  if (typeof envelope.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(envelope.fingerprint)) {
    throw approvalError('Approval fingerprint is invalid.', 'APPROVAL_RECORD_TAMPERED');
  }
  const expectedFingerprint = sha256HexSync(boundProjection(envelope));
  if (envelope.fingerprint !== expectedFingerprint) {
    throw approvalError('The approval envelope was modified.', 'APPROVAL_RECORD_TAMPERED');
  }
}

function assertExecutionContext(envelope, expected) {
  if (!expected || typeof expected !== 'object' || Array.isArray(expected)) {
    throw approvalError('Current execution context is required.', 'APPROVAL_CONTEXT_INCOMPLETE');
  }
  for (const field of EXECUTION_FIELDS) {
    if (!hasOwn(expected, field)) {
      throw approvalError(`Current execution context is missing ${field}.`, 'APPROVAL_CONTEXT_INCOMPLETE', { field });
    }
  }

  const mismatches = [
    ['planId', 'APPROVAL_PLAN_MISMATCH'],
    ['planRevision', 'APPROVAL_PLAN_REVISION_MISMATCH'],
    ['nodeId', 'APPROVAL_NODE_MISMATCH'],
    ['toolOrigin', 'APPROVAL_TOOL_ORIGIN_MISMATCH'],
    ['toolName', 'APPROVAL_TOOL_NAME_MISMATCH'],
    ['toolSchemaFingerprint', 'APPROVAL_TOOL_SCHEMA_MISMATCH'],
    ['canonicalCapability', 'APPROVAL_CAPABILITY_MISMATCH'],
    ['normalizedArguments', 'APPROVAL_ARGUMENTS_MISMATCH'],
    ['effectSummary', 'APPROVAL_EFFECT_MISMATCH'],
    ['risk', 'APPROVAL_RISK_MISMATCH'],
  ];

  for (const [field, code] of mismatches) {
    if (stableStringify(envelope[field]) !== stableStringify(expected[field])) {
      throw approvalError(`Approved ${field} does not match the current execution.`, code, {
        field,
        approved: envelope[field],
        current: expected[field],
      });
    }
  }
}

/** Verifies integrity, freshness, single-use state, and the exact live execution context. */
export function verifyApprovalEnvelope(envelope, expected, { now = new Date() } = {}) {
  assertEnvelopeShape(envelope);
  assertExecutionContext(envelope, expected);

  const checkedAt = Date.parse(toIsoTimestamp(now, 'now'));
  if (checkedAt >= Date.parse(envelope.expiresAt)) {
    throw approvalError('The approval envelope has expired.', 'APPROVAL_EXPIRED', { expiresAt: envelope.expiresAt });
  }
  if (consumedNonces.has(envelope.nonce)) {
    throw approvalError('This approval nonce has already been consumed.', 'APPROVAL_REPLAY_BLOCKED', {
      nonce: envelope.nonce,
      firstClaim: consumedNonces.get(envelope.nonce),
    });
  }
  return true;
}

/**
 * Atomically verifies and claims every nonce in the current JavaScript realm.
 * Validation is deliberately synchronous and completes for the whole set before
 * any nonce is consumed, so one invalid request leaves the entire set untouched.
 */
export function claimApprovalEnvelopeSet(requests, { now = new Date() } = {}) {
  if (!Array.isArray(requests) || requests.length === 0) {
    throw approvalError('Approval claim set must be a non-empty array.', 'APPROVAL_SET_INVALID');
  }

  const claimedAt = toIsoTimestamp(now, 'now');
  const seenNonces = new Set();
  const receipts = requests.map((request, index) => {
    if (!request || typeof request !== 'object' || Array.isArray(request)) {
      throw approvalError('Each approval claim must contain an envelope and execution context.', 'APPROVAL_SET_INVALID', {
        index,
      });
    }

    const { envelope, expected } = request;
    verifyApprovalEnvelope(envelope, expected, { now: claimedAt });
    if (seenNonces.has(envelope.nonce)) {
      throw approvalError('An approval nonce appears more than once in the claim set.', 'APPROVAL_DUPLICATE_NONCE', {
        nonce: envelope.nonce,
        index,
      });
    }
    seenNonces.add(envelope.nonce);

    return Object.freeze({
      version: envelope.version,
      nonce: envelope.nonce,
      fingerprint: envelope.fingerprint,
      planId: envelope.planId,
      planRevision: envelope.planRevision,
      nodeId: envelope.nodeId,
      claimedAt,
    });
  });

  for (const receipt of receipts) {
    consumedNonces.set(receipt.nonce, receipt);
  }
  return Object.freeze(receipts);
}

/**
 * Atomically claims one nonce. This function is deliberately synchronous:
 * callers must invoke it before awaiting a mutation.
 */
export function claimApprovalEnvelope(envelope, expected, options = {}) {
  return claimApprovalEnvelopeSet([{ envelope, expected }], options)[0];
}

/**
 * Claims first, then invokes the optional asynchronous mutation. A rejected or
 * failed mutation does not release the nonce; retry requires fresh human approval.
 */
export async function consumeApprovalEnvelope(envelope, expected, execute, options = {}) {
  const receipt = claimApprovalEnvelope(envelope, expected, options);
  if (execute === undefined) return receipt;
  if (typeof execute !== 'function') {
    throw approvalError('consumeApprovalEnvelope execute argument must be a function.', 'APPROVAL_EXECUTOR_INVALID');
  }
  const result = await execute(receipt);
  return { receipt, result };
}

export { APPROVAL_VERSION, DEFAULT_APPROVAL_TTL_MS };
