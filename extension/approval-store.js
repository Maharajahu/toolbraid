const STORAGE_KEY = 'toolbraid.universal.approvals.v1';
export const APPROVAL_VERSION = 1;
export const PROVENANCE = 'generated-by-toolbraid';
export const DEFAULT_APPROVAL_TTL_MS = 120_000;
export const MAX_APPROVAL_TTL_MS = 900_000;

export class ApprovalStoreError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ApprovalStoreError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details = {}) {
  return new ApprovalStoreError(code, message, details);
}

function plainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function cloneJson(value, path = '$', depth = 0, seen = new Set()) {
  if (depth > 16) throw fail('DATA_TOO_DEEP', `Approval data exceeds the depth limit at ${path}.`);
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw fail('DATA_INVALID', `Approval data contains a non-finite number at ${path}.`);
    return value;
  }
  if (!value || typeof value !== 'object') throw fail('DATA_INVALID', `Approval data contains an unsupported value at ${path}.`);
  if (seen.has(value)) throw fail('DATA_CYCLIC', `Approval data is cyclic at ${path}.`);
  seen.add(value);
  let result;
  if (Array.isArray(value)) {
    if (value.length > 512) throw fail('DATA_TOO_LARGE', `Approval data array is too large at ${path}.`);
    result = value.map((entry, index) => cloneJson(entry, `${path}[${index}]`, depth + 1, seen));
  } else {
    if (!plainObject(value)) throw fail('DATA_INVALID', `Approval data must be JSON objects at ${path}.`);
    const keys = Object.keys(value);
    if (keys.length > 512) throw fail('DATA_TOO_LARGE', `Approval data object is too large at ${path}.`);
    result = {};
    for (const key of keys) {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
        throw fail('DATA_INVALID', `Approval data contains a reserved key at ${path}.`);
      }
      result[key] = cloneJson(value[key], `${path}.${key}`, depth + 1, seen);
    }
  }
  seen.delete(value);
  return result;
}

function stableStringify(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw fail('DATA_INVALID', 'Fingerprint input contains a non-finite number.');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (!plainObject(value)) throw fail('DATA_INVALID', 'Fingerprint input must contain JSON-compatible objects.');
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

function hex(bytes) {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function resolveCrypto(cryptoRef) {
  const value = cryptoRef ?? globalThis.crypto;
  if (!value || typeof value.getRandomValues !== 'function' || !value.subtle || typeof value.subtle.digest !== 'function') {
    throw fail('CRYPTO_UNAVAILABLE', 'WebCrypto randomness and SHA-256 are required for approvals.');
  }
  return value;
}

export function createCryptoNonce(cryptoRef = globalThis.crypto) {
  const value = resolveCrypto(cryptoRef);
  if (typeof value.randomUUID === 'function') return value.randomUUID();
  const bytes = new Uint8Array(32);
  value.getRandomValues(bytes);
  return hex(bytes);
}

export async function sha256Hex(value, cryptoRef = globalThis.crypto) {
  const cryptoValue = resolveCrypto(cryptoRef);
  const canonical = typeof value === 'string' ? value : stableStringify(cloneJson(value));
  const encoded = new TextEncoder().encode(canonical);
  return hex(await cryptoValue.subtle.digest('SHA-256', encoded));
}

/**
 * Fingerprint includes the complete action scope. Callers should pass the
 * prepared action, not a label or page text excerpt.
 */
export async function fingerprintAction(action, cryptoRef = globalThis.crypto) {
  if (!plainObject(action)) throw fail('ACTION_REQUIRED', 'A prepared action object is required.');
  return sha256Hex({
    tabId: action.tabId ?? action.scope?.tabId ?? null,
    frameId: action.frameId ?? action.scope?.frameId ?? null,
    sessionId: action.sessionId ?? action.scope?.sessionId ?? null,
    origin: action.origin ?? action.scope?.origin ?? action.provenance?.origin ?? null,
    pageFingerprint: action.pageFingerprint ?? action.scope?.pageFingerprint ?? action.provenance?.pageFingerprint ?? null,
    target: action.target ?? action.scope?.target ?? null,
    targetFingerprint: action.targetFingerprint ?? action.target?.targetFingerprint ?? action.scope?.targetFingerprint ?? null,
    actionId: action.actionId ?? null,
    tool: action.tool ?? { name: action.toolName ?? action.name ?? null },
    arguments: action.arguments ?? action.normalizedArguments ?? action.input ?? {},
    effect: action.effect ?? null,
    classification: action.classification ?? null,
    requiresApproval: action.requiresApproval ?? null,
    risk: action.risk ?? action.effect?.risk ?? null,
  }, cryptoRef);
}

function assertActionAuthorityBinding(action) {
  if (!Number.isInteger(action?.tabId) || action.tabId < 0
    || !Number.isInteger(action?.frameId) || action.frameId < 0
    || typeof action?.sessionId !== 'string' || action.sessionId.length < 8 || action.sessionId.length > 220
    || typeof action?.origin !== 'string') {
    throw fail(
      'ACTION_BINDING_REQUIRED',
      'A prepared action must be bound to an exact tab, frame, session, and origin.',
    );
  }
  try {
    const origin = new URL(action.origin);
    if (!['http:', 'https:'].includes(origin.protocol) || origin.origin !== action.origin) throw new Error('invalid origin');
  } catch {
    throw fail('ACTION_BINDING_INVALID', 'The prepared action origin binding is invalid.');
  }
}

function assertTrustedEvent(event) {
  if (event?.isTrusted !== true) throw fail('TRUSTED_ACTIVATION_REQUIRED', 'Approval changes require a trusted user activation.');
}

function validateTtl(ttlMs) {
  if (!Number.isFinite(ttlMs) || ttlMs < 1 || ttlMs > MAX_APPROVAL_TTL_MS) {
    throw fail('TTL_INVALID', `Approval TTL must be between 1 and ${MAX_APPROVAL_TTL_MS} milliseconds.`);
  }
  return Math.floor(ttlMs);
}

function storageGet(area, key) {
  if (!area || typeof area.get !== 'function') return Promise.reject(fail('STORAGE_UNAVAILABLE', 'chrome.storage.local is unavailable.'));
  if (area.get.length >= 2) {
    return new Promise((resolve, reject) => {
      try {
        area.get(key, (value) => {
          const runtimeError = globalThis.chrome?.runtime?.lastError;
          if (runtimeError) reject(fail('STORAGE_READ_FAILED', runtimeError.message));
          else resolve(value ?? {});
        });
      } catch (error) {
        reject(error);
      }
    });
  }
  try {
    const result = area.get(key);
    if (result && typeof result.then === 'function') return result;
  } catch (error) {
    return Promise.reject(error);
  }
  return new Promise((resolve, reject) => {
    area.get(key, (value) => {
      const runtimeError = globalThis.chrome?.runtime?.lastError;
      if (runtimeError) reject(fail('STORAGE_READ_FAILED', runtimeError.message));
      else resolve(value ?? {});
    });
  });
}

function storageSet(area, value) {
  if (!area || typeof area.set !== 'function') return Promise.reject(fail('STORAGE_UNAVAILABLE', 'chrome.storage.local is unavailable.'));
  if (area.set.length >= 2) {
    return new Promise((resolve, reject) => {
      try {
        area.set(value, () => {
          const runtimeError = globalThis.chrome?.runtime?.lastError;
          if (runtimeError) reject(fail('STORAGE_WRITE_FAILED', runtimeError.message));
          else resolve();
        });
      } catch (error) {
        reject(error);
      }
    });
  }
  try {
    const result = area.set(value);
    if (result && typeof result.then === 'function') return result;
  } catch (error) {
    return Promise.reject(error);
  }
  return new Promise((resolve, reject) => {
    area.set(value, () => {
      const runtimeError = globalThis.chrome?.runtime?.lastError;
      if (runtimeError) reject(fail('STORAGE_WRITE_FAILED', runtimeError.message));
      else resolve();
    });
  });
}

function storageRemove(area, key) {
  if (!area || typeof area.remove !== 'function') return Promise.resolve();
  if (area.remove.length >= 2) {
    return new Promise((resolve, reject) => {
      try {
        area.remove(key, () => {
          const runtimeError = globalThis.chrome?.runtime?.lastError;
          if (runtimeError) reject(fail('STORAGE_WRITE_FAILED', runtimeError.message));
          else resolve();
        });
      } catch (error) {
        reject(error);
      }
    });
  }
  try {
    const result = area.remove(key);
    if (result && typeof result.then === 'function') return result;
  } catch (error) {
    return Promise.reject(error);
  }
  return new Promise((resolve, reject) => {
    area.remove(key, () => {
      const runtimeError = globalThis.chrome?.runtime?.lastError;
      if (runtimeError) reject(fail('STORAGE_WRITE_FAILED', runtimeError.message));
      else resolve();
    });
  });
}

function normalizeRecords(value) {
  if (!plainObject(value)) return {};
  const records = value[STORAGE_KEY];
  if (!plainObject(records)) return {};
  const result = {};
  for (const [id, record] of Object.entries(records)) {
    if (!plainObject(record) || typeof record.id !== 'string' || record.id !== id) continue;
    if (record.version !== APPROVAL_VERSION || record.provenance !== PROVENANCE) continue;
    result[id] = cloneJson(record);
  }
  return result;
}

export function createApprovalStore({
  storageArea = globalThis.chrome?.storage?.local,
  cryptoRef = globalThis.crypto,
  now = () => Date.now(),
  nonceFactory = () => createCryptoNonce(cryptoRef),
  key = STORAGE_KEY,
} = {}) {
  if (typeof now !== 'function' || typeof nonceFactory !== 'function') throw new TypeError('now and nonceFactory must be functions.');
  if (typeof key !== 'string' || key.length < 1) throw new TypeError('A storage key is required.');

  async function read() {
    const value = await storageGet(storageArea, key);
    return normalizeRecords({ [STORAGE_KEY]: value?.[key] ?? value?.[STORAGE_KEY] });
  }

  async function write(records) {
    await storageSet(storageArea, { [key]: cloneJson(records) });
  }

  async function get(id) {
    if (typeof id !== 'string' || id.length < 1) return null;
    const records = await read();
    const record = records[id];
    if (!record) return null;
    if (record.expiresAt <= now() && record.state !== 'expired') {
      record.state = 'expired';
      await write(records);
    }
    return record.state === 'expired' ? null : Object.freeze(record);
  }

  async function list() {
    const records = await read();
    const timestamp = now();
    let dirty = false;
    const result = [];
    for (const record of Object.values(records)) {
      if (record.expiresAt <= timestamp) {
        dirty = true;
        continue;
      }
      result.push(Object.freeze(record));
    }
    if (dirty) await write(Object.fromEntries(result.map((record) => [record.id, record])));
    return result;
  }

  async function createApproval({ event, action, ttlMs = DEFAULT_APPROVAL_TTL_MS } = {}) {
    assertTrustedEvent(event);
    const ttl = validateTtl(ttlMs);
    const scope = cloneJson(action, '$.action');
    assertActionAuthorityBinding(scope);
    const fingerprint = await fingerprintAction(scope, cryptoRef);
    const nonce = nonceFactory();
    if (typeof nonce !== 'string' || nonce.length < 16) throw fail('NONCE_INVALID', 'Approval nonce generation failed.');
    const createdAt = now();
    const record = {
      version: APPROVAL_VERSION,
      provenance: PROVENANCE,
      id: `approval-${nonce}`,
      nonce,
      state: 'approved',
      createdAt,
      expiresAt: createdAt + ttl,
      fingerprint,
      scope,
    };
    const records = await read();
    if (records[record.id]) throw fail('NONCE_REUSE', 'Approval nonce is already present in local storage.');
    records[record.id] = record;
    await write(records);
    return Object.freeze(cloneJson(record));
  }

  async function transition(id, state, event) {
    assertTrustedEvent(event);
    const records = await read();
    const record = records[id];
    if (!record) throw fail('APPROVAL_NOT_FOUND', 'Approval record was not found.');
    if (record.expiresAt <= now()) {
      delete records[id];
      await write(records);
      throw fail('APPROVAL_EXPIRED', 'Approval record has expired.');
    }
    if (state === 'denied') {
      if (!['approved', 'pending'].includes(record.state)) throw fail('APPROVAL_STATE_INVALID', 'Approval cannot be denied in its current state.');
    } else if (state === 'executed') {
      if (record.state !== 'approved') throw fail('APPROVAL_STATE_INVALID', 'Only an approved record can be executed.');
    }
    record.state = state;
    record[`${state}At`] = now();
    await write(records);
    return Object.freeze(cloneJson(record));
  }

  async function prepareExecution(id, event) {
    assertTrustedEvent(event);
    const record = await get(id);
    if (!record) throw fail('APPROVAL_NOT_FOUND', 'Approval record was not found or has expired.');
    if (record.state !== 'approved') throw fail('APPROVAL_STATE_INVALID', 'Approval is not executable in its current state.');
    return record;
  }

  async function execute(id, event, executor = null) {
    const record = await prepareExecution(id, event);
    if (typeof executor !== 'function') throw fail('EXECUTOR_UNAVAILABLE', 'No execution authority is attached to this approval.');
    const result = await executor(Object.freeze(cloneJson(record.scope)));
    const executed = await transition(id, 'executed', event);
    return Object.freeze({ ok: true, result, approval: executed, provenance: PROVENANCE });
  }

  async function clear() {
    await storageRemove(storageArea, key);
  }

  return Object.freeze({
    createApproval,
    create: createApproval,
    approve: createApproval,
    get,
    list,
    deny: (id, event) => transition(id, 'denied', event),
    markExecuted: (id, event) => transition(id, 'executed', event),
    prepareExecution,
    execute,
    clear,
    key,
  });
}

export { STORAGE_KEY, stableStringify };
