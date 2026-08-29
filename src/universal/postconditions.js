import {
  UniversalDataError,
  cloneJson,
  freezeDeep,
  stableStringify,
} from './canonical.js';

export const POSTCONDITION_CONTRACT_VERSION = 1;

export const POSTCONDITION_STATUSES = Object.freeze({
  VERIFIED_SUCCESS: 'verified-success',
  VERIFIED_FAILURE: 'verified-failure',
  UNVERIFIED: 'unverified',
});

const CONTRACT_KEYS = new Set(['version', 'id', 'adapterId', 'adapterVersion', 'observation']);
const RESULT_KEYS = new Set(['status', 'reasonCode', 'evidence', 'afterPageFingerprint']);
const IDENTIFIER = /^[A-Za-z0-9_.:-]{1,128}$/;
const ADAPTER_IDENTIFIER = /^[A-Za-z0-9_.-]{1,128}$/;
const FINGERPRINT = /^[a-f0-9]{64}$/;
const MAX_EVIDENCE_DEPTH = 4;
const MAX_EVIDENCE_KEYS = 32;
const MAX_EVIDENCE_ITEMS = 32;
const MAX_EVIDENCE_STRING = 512;
const MAX_EVIDENCE_BYTES = 8 * 1024;
const MAX_EVIDENCE_NODES = 256;
const MAX_EVIDENCE_TOTAL_KEYS = 128;
const MAX_EVIDENCE_KEY_LENGTH = 128;
const MAX_EVIDENCE_WORK = 1_024;

export class PostconditionError extends UniversalDataError {
  constructor(code, message, details = {}) {
    super(code, message, details);
    this.name = 'PostconditionError';
  }
}

function postconditionError(code, message, details = {}) {
  return new PostconditionError(code, message, details);
}

function plainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function text(value, field, maxLength, { required = false } = {}) {
  if (typeof value !== 'string') {
    if (!required && (value === undefined || value === null)) return null;
    throw postconditionError('POSTCONDITION_CONTRACT_INVALID', `${field} must be a string.`, { field });
  }
  const result = value.trim();
  if (!result && required) throw postconditionError('POSTCONDITION_CONTRACT_INVALID', `${field} is required.`, { field });
  if (result.length > maxLength) throw postconditionError('POSTCONDITION_CONTRACT_INVALID', `${field} is too long.`, { field });
  return result || null;
}

function validateKeys(value, allowed, code, message) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw postconditionError(code, message, { key });
  }
}

function fingerprint(value, field, { required = false } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw postconditionError('POSTCONDITION_RESULT_INVALID', `${field} is required.`, { field });
    return null;
  }
  if (typeof value !== 'string' || !FINGERPRINT.test(value)) {
    throw postconditionError('POSTCONDITION_RESULT_INVALID', `${field} must be a SHA-256 fingerprint.`, { field });
  }
  return value;
}

function normalizeContract(contract) {
  if (!plainObject(contract)) {
    throw postconditionError('POSTCONDITION_CONTRACT_INVALID', 'A postcondition contract must be a plain object.');
  }
  validateKeys(contract, CONTRACT_KEYS, 'POSTCONDITION_CONTRACT_INVALID', 'Postcondition contract contains an unknown field.');
  if (contract.version !== POSTCONDITION_CONTRACT_VERSION) {
    throw postconditionError('POSTCONDITION_CONTRACT_INVALID', 'The postcondition contract version is unsupported.', {
      version: contract.version,
    });
  }
  const id = text(contract.id, 'id', 128, { required: true });
  if (!IDENTIFIER.test(id)) throw postconditionError('POSTCONDITION_CONTRACT_INVALID', 'Postcondition id has invalid characters.', { id });
  const adapterId = text(contract.adapterId, 'adapterId', 128, { required: true });
  if (!ADAPTER_IDENTIFIER.test(adapterId)) throw postconditionError('POSTCONDITION_CONTRACT_INVALID', 'Postcondition adapterId has invalid characters.', { adapterId });
  const adapterVersion = text(contract.adapterVersion, 'adapterVersion', 64, { required: true });
  const observation = text(contract.observation, 'observation', 64, { required: true });
  if (observation !== 'page-snapshot') {
    throw postconditionError('POSTCONDITION_CONTRACT_INVALID', 'Only page-snapshot postconditions are supported.', { observation });
  }
  return freezeDeep({
    version: POSTCONDITION_CONTRACT_VERSION,
    id,
    adapterId,
    adapterVersion,
    observation,
  });
}

export function validatePostconditionContract(contract) {
  return normalizeContract(contract);
}

export function isPostconditionContract(contract) {
  try {
    normalizeContract(contract);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check the complete evidence graph before constructing a normalized copy.
 * This is deliberately allocation-free apart from the bounded ancestor set:
 * per-object limits alone would otherwise permit a large collection of small
 * objects to be materialized before the final size check.
 */
function preflightEvidence(value) {
  const encoder = new TextEncoder();
  const state = {
    nodes: 0,
    keys: 0,
    bytes: 0,
    work: 0,
    ancestors: new Set(),
  };
  const fail = (message, details = {}) => {
    throw postconditionError('POSTCONDITION_RESULT_INVALID', message, details);
  };
  const consumeWork = () => {
    state.work += 1;
    if (state.work > MAX_EVIDENCE_WORK) fail('Postcondition evidence exceeds its work budget.');
  };
  const consumeBytes = (size) => {
    state.bytes += size;
    if (state.bytes > MAX_EVIDENCE_BYTES) fail('Postcondition evidence is too large.');
  };
  const visit = (current, depth, path) => {
    consumeWork();
    state.nodes += 1;
    if (state.nodes > MAX_EVIDENCE_NODES) fail('Postcondition evidence contains too many nodes.', { path });
    if (current === null || typeof current === 'boolean') return;
    if (typeof current === 'string') {
      if (current.length > MAX_EVIDENCE_STRING) fail('Postcondition evidence contains an overlong string.', { path });
      consumeBytes(encoder.encode(current).byteLength);
      return;
    }
    if (typeof current === 'number') {
      if (!Number.isFinite(current)) fail('Postcondition evidence contains a non-finite number.', { path });
      return;
    }
    if (!current || typeof current !== 'object') fail('Postcondition evidence must be JSON data.', { path });
    if (depth >= MAX_EVIDENCE_DEPTH) fail('Postcondition evidence is too deeply nested.', { path });
    if (state.ancestors.has(current)) fail('Postcondition evidence contains a circular reference.', { path });

    state.ancestors.add(current);
    try {
      if (Array.isArray(current)) {
        if (current.length > MAX_EVIDENCE_ITEMS) fail('Postcondition evidence contains too many items.', { path });
        for (let index = 0; index < current.length; index += 1) {
          consumeWork();
          if (!Object.hasOwn(current, index)) fail('Postcondition evidence arrays must not contain holes.', { path });
          visit(current[index], depth + 1, `${path}[${index}]`);
        }
        return;
      }
      if (!plainObject(current)) fail('Postcondition evidence must contain plain objects.', { path });
      let localKeys = 0;
      for (const key in current) {
        if (!Object.hasOwn(current, key)) continue;
        localKeys += 1;
        state.keys += 1;
        consumeWork();
        if (localKeys > MAX_EVIDENCE_KEYS || state.keys > MAX_EVIDENCE_TOTAL_KEYS) {
          fail('Postcondition evidence contains too many fields.', { path });
        }
        if (key.length > MAX_EVIDENCE_KEY_LENGTH) {
          fail('Postcondition evidence contains an overlong field name.', { path, key });
        }
        if (['__proto__', 'constructor', 'prototype'].includes(key)) {
          fail('Postcondition evidence contains a reserved field.', { path, key });
        }
        consumeBytes(encoder.encode(key).byteLength);
        visit(current[key], depth + 1, `${path}.${key}`);
      }
    } finally {
      state.ancestors.delete(current);
    }
  };
  visit(value, 0, '$.evidence');
}

function boundedEvidence(value, depth = 0) {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (value.length > MAX_EVIDENCE_STRING) throw postconditionError('POSTCONDITION_RESULT_INVALID', 'Postcondition evidence contains an overlong string.');
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw postconditionError('POSTCONDITION_RESULT_INVALID', 'Postcondition evidence contains a non-finite number.');
    return Object.is(value, -0) ? 0 : value;
  }
  if (!value || typeof value !== 'object') {
    throw postconditionError('POSTCONDITION_RESULT_INVALID', 'Postcondition evidence must be JSON data.');
  }
  if (depth >= MAX_EVIDENCE_DEPTH) throw postconditionError('POSTCONDITION_RESULT_INVALID', 'Postcondition evidence is too deeply nested.');
  if (Array.isArray(value)) {
    if (value.length > MAX_EVIDENCE_ITEMS) throw postconditionError('POSTCONDITION_RESULT_INVALID', 'Postcondition evidence contains too many items.');
    return value.map((entry) => boundedEvidence(entry, depth + 1));
  }
  if (!plainObject(value)) throw postconditionError('POSTCONDITION_RESULT_INVALID', 'Postcondition evidence must contain plain objects.');
  const keys = Object.keys(value);
  if (keys.length > MAX_EVIDENCE_KEYS) throw postconditionError('POSTCONDITION_RESULT_INVALID', 'Postcondition evidence contains too many fields.');
  const result = Object.create(null);
  for (const key of keys.sort()) {
    if (['__proto__', 'constructor', 'prototype'].includes(key)) {
      throw postconditionError('POSTCONDITION_RESULT_INVALID', 'Postcondition evidence contains a reserved field.', { key });
    }
    Object.defineProperty(result, key, {
      value: boundedEvidence(value[key], depth + 1),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return result;
}

function normalizeEvidence(value) {
  if (value === undefined) return Object.freeze(Object.create(null));
  if (!plainObject(value)) throw postconditionError('POSTCONDITION_RESULT_INVALID', 'Postcondition evidence must be a plain object.');
  preflightEvidence(value);
  const result = boundedEvidence(value);
  if (new TextEncoder().encode(stableStringify(result)).byteLength > MAX_EVIDENCE_BYTES) {
    throw postconditionError('POSTCONDITION_RESULT_INVALID', 'Postcondition evidence is too large.');
  }
  return freezeDeep(result);
}

function normalizedTimestamp(value) {
  const date = value instanceof Date ? value : new Date(value ?? Date.now());
  if (!Number.isFinite(date.getTime())) throw postconditionError('POSTCONDITION_RESULT_INVALID', 'checkedAt must be a valid timestamp.');
  return date.toISOString();
}

/**
 * Normalize an adapter verdict into the only shape that may be attached to a
 * Universal dispatch receipt.  A positive or negative verdict must include an
 * observed post-dispatch snapshot fingerprint; otherwise it is rejected.
 */
export function normalizePostconditionResult(raw, {
  contract,
  beforeSnapshot = null,
  afterPageFingerprint = null,
  checkedAt = undefined,
} = {}) {
  const normalizedContract = normalizeContract(contract);
  if (!plainObject(raw)) throw postconditionError('POSTCONDITION_RESULT_INVALID', 'A postcondition result must be a plain object.');
  validateKeys(raw, RESULT_KEYS, 'POSTCONDITION_RESULT_INVALID', 'Postcondition result contains an unknown field.');
  const status = raw.status;
  if (!Object.values(POSTCONDITION_STATUSES).includes(status)) {
    throw postconditionError('POSTCONDITION_RESULT_INVALID', 'Postcondition result status is invalid.', { status });
  }
  const observedFingerprint = fingerprint(raw.afterPageFingerprint ?? afterPageFingerprint, 'afterPageFingerprint', {
    required: status !== POSTCONDITION_STATUSES.UNVERIFIED,
  });
  const beforeFingerprint = beforeSnapshot?.pageFingerprint ?? null;
  if (beforeFingerprint !== null && !FINGERPRINT.test(beforeFingerprint)) {
    throw postconditionError('POSTCONDITION_RESULT_INVALID', 'beforeSnapshot has an invalid page fingerprint.');
  }
  const reasonCode = text(raw.reasonCode, 'reasonCode', 128);
  return freezeDeep({
    version: POSTCONDITION_CONTRACT_VERSION,
    status,
    contractId: normalizedContract.id,
    adapterId: normalizedContract.adapterId,
    adapterVersion: normalizedContract.adapterVersion,
    beforePageFingerprint: beforeFingerprint,
    afterPageFingerprint: observedFingerprint,
    ...(reasonCode ? { reasonCode } : {}),
    evidence: normalizeEvidence(raw.evidence),
    checkedAt: normalizedTimestamp(checkedAt),
  });
}

/**
 * Apply only a normalized verdict to a known dispatch record.  Unknown
 * dispatches are terminal and cannot be upgraded by a later verifier result.
 */
export function applyPostconditionResult(record, result) {
  if (!plainObject(record)) throw postconditionError('POSTCONDITION_RECORD_INVALID', 'A dispatch record must be a plain object.');
  if (!plainObject(result) || !Object.values(POSTCONDITION_STATUSES).includes(result.status)) {
    throw postconditionError('POSTCONDITION_RESULT_INVALID', 'A normalized postcondition result is required.');
  }
  const next = cloneJson(record);
  if (record.status === 'outcome-unknown'
    || record.status === POSTCONDITION_STATUSES.VERIFIED_SUCCESS
    || record.status === POSTCONDITION_STATUSES.VERIFIED_FAILURE) return freezeDeep(next);
  next.verification = cloneJson(result);
  if (result.status === POSTCONDITION_STATUSES.VERIFIED_SUCCESS) {
    next.status = POSTCONDITION_STATUSES.VERIFIED_SUCCESS;
    next.outcome = POSTCONDITION_STATUSES.VERIFIED_SUCCESS;
    next.postcondition = 'satisfied';
  } else if (result.status === POSTCONDITION_STATUSES.VERIFIED_FAILURE) {
    next.status = POSTCONDITION_STATUSES.VERIFIED_FAILURE;
    next.outcome = POSTCONDITION_STATUSES.VERIFIED_FAILURE;
    next.postcondition = 'failed';
  } else {
    next.status = 'dispatched';
    next.outcome = 'postcondition-unverified';
    next.postcondition = 'unverified';
  }
  return freezeDeep(next);
}
