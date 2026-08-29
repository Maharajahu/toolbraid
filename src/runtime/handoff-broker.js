import {
  freezeDeep,
  sha256Hex,
  stableStringify,
} from '../universal/canonical.js';

export const HANDOFF_PERSISTENCE_VERSION = 1;

export const HANDOFF_TYPES = Object.freeze({
  LOGIN: 'login',
  TWO_FA: '2fa',
  CAPTCHA: 'captcha',
});

export const HANDOFF_STATES = Object.freeze({
  REQUESTED: 'requested',
  AWAITING_UI_GESTURE: 'awaiting-ui-gesture',
  OPENING: 'opening',
  HUMAN_ACTIVE: 'human-active',
  RETURN_REQUESTED: 'return-requested',
  VALIDATING: 'validating',
  COMPLETED: 'completed',
  STILL_REQUIRED: 'still-required',
  EXPIRED: 'expired',
  CANCELLED: 'cancelled',
  FAILED: 'failed',
});

export const HANDOFF_TTL_LIMITS = Object.freeze({
  MIN_MS: 1,
  MAX_MS: 15 * 60 * 1_000,
  DEFAULT_MS: 5 * 60 * 1_000,
});

const TYPE_VALUES = new Set(Object.values(HANDOFF_TYPES));
const STATE_VALUES = new Set(Object.values(HANDOFF_STATES));
const TERMINAL_STATES = new Set([
  HANDOFF_STATES.COMPLETED,
  HANDOFF_STATES.STILL_REQUIRED,
  HANDOFF_STATES.EXPIRED,
  HANDOFF_STATES.CANCELLED,
  HANDOFF_STATES.FAILED,
]);
const NON_REHYDRATABLE_STATES = new Set([
  HANDOFF_STATES.REQUESTED,
  HANDOFF_STATES.OPENING,
  HANDOFF_STATES.HUMAN_ACTIVE,
  HANDOFF_STATES.RETURN_REQUESTED,
  HANDOFF_STATES.VALIDATING,
]);
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,219}$/;
const SAFE_TEXT = /^[^\u0000-\u001f\u007f]{1,160}$/u;
const SAFE_CODE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const SHA256_FINGERPRINT = /^[a-f0-9]{64}$/;
const MAX_REPLAY_FINGERPRINTS = 32;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const SENSITIVE_WORD = /(?:password|passwd|passcode|otp|one[-_ ]?time|secret|token|cookie|authorization|credential)/iu;
let fallbackIdCounter = 0;

export class HandoffBrokerError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'HandoffBrokerError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details = {}) {
  throw new HandoffBrokerError(code, message, details);
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requiredObject(value, field) {
  if (!isPlainObject(value)) fail('FIELD_INVALID', `${field} must be a plain object.`, { field });
  return value;
}

function boundedId(value, field, { optional = false } = {}) {
  if (value === undefined || value === null) {
    if (optional) return null;
    fail('FIELD_REQUIRED', `${field} is required.`, { field });
  }
  if (typeof value !== 'string' || !SAFE_ID.test(value)) {
    fail('FIELD_INVALID', `${field} must be a bounded identifier.`, { field });
  }
  return value;
}

function boundedText(value, field, { optional = false, sensitive = false } = {}) {
  if (value === undefined || value === null || value === '') {
    if (optional) return null;
    fail('FIELD_REQUIRED', `${field} is required.`, { field });
  }
  if (typeof value !== 'string' || value.trim() !== value || !SAFE_TEXT.test(value)) {
    fail('FIELD_INVALID', `${field} must be bounded text.`, { field });
  }
  if (sensitive || SENSITIVE_WORD.test(value)) {
    fail('FIELD_INVALID', `${field} must not contain credential material.`, { field });
  }
  return value;
}

function boundedCode(value, field, fallback = null) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value !== 'string' || !SAFE_CODE.test(value)) {
    fail('FIELD_INVALID', `${field} must be a bounded code.`, { field });
  }
  if (SENSITIVE_WORD.test(value)) {
    fail('FIELD_INVALID', `${field} must not contain credential material.`, { field });
  }
  return value;
}

function integer(value, field, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isInteger(value) || value < min || value > max) {
    fail('FIELD_INVALID', `${field} must be a bounded integer.`, { field });
  }
  return value;
}

function timestamp(value, field) {
  if (typeof value !== 'string') fail('FIELD_INVALID', `${field} must be an ISO timestamp.`, { field });
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) fail('FIELD_INVALID', `${field} must be an ISO timestamp.`, { field });
  return date.toISOString();
}

function clone(value) {
  return structuredClone(value);
}

function publicClone(value) {
  return freezeDeep(clone(value));
}

function nowDate(now) {
  let value;
  try {
    value = now();
  } catch {
    fail('CLOCK_UNAVAILABLE', 'Handoff clock is unavailable.');
  }
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) fail('CLOCK_INVALID', 'Handoff clock returned an invalid time.');
  return date;
}

function normalizeTtl(value, fallback) {
  const ttl = value === undefined || value === null ? fallback : value;
  return integer(ttl, 'ttlMs', {
    min: HANDOFF_TTL_LIMITS.MIN_MS,
    max: HANDOFF_TTL_LIMITS.MAX_MS,
  });
}

function persistenceKeyFrom(options) {
  const key = options.persistenceKey;
  if (key === undefined || key === null) return null;
  if (typeof key !== 'string' || key.length < 32 || key.length > 256) {
    fail('CONFIG_INVALID', 'persistenceKey must be a secret string of 32 to 256 characters.', { field: 'persistenceKey' });
  }
  return key;
}

function requirePersistenceKey(key) {
  if (!key) fail('PERSISTENCE_KEY_REQUIRED', 'A persistence integrity key is required.');
  return key;
}

function equalFingerprint(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string' || left.length !== right.length) return false;
  let different = 0;
  for (let index = 0; index < left.length; index += 1) {
    different |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return different === 0;
}

function replayFingerprints(value, field) {
  if (!Array.isArray(value) || value.length > MAX_REPLAY_FINGERPRINTS) {
    fail('PERSISTENCE_INVALID', `${field} must be a bounded fingerprint array.`, { field });
  }
  const result = [];
  const seen = new Set();
  for (const entry of value) {
    if (typeof entry !== 'string' || !SHA256_FINGERPRINT.test(entry) || seen.has(entry)) {
      fail('PERSISTENCE_INVALID', `${field} contains an invalid fingerprint.`, { field });
    }
    seen.add(entry);
    result.push(entry);
  }
  return result.sort();
}

function validatorResultAccepted(result) {
  if (result && typeof result.then === 'function') return false;
  return result === true || result?.valid === true || result?.ok === true || result?.accepted === true;
}

/**
 * Reduce a navigation value to an origin.  User info, path, query, and
 * fragment are deliberately discarded; only an HTTP(S) origin can cross the
 * broker boundary.
 */
export function normalizeSafeOrigin(value, field = 'safeOrigin') {
  if (typeof value !== 'string' || value.trim() !== value || value.length > 2_048) {
    fail('SAFE_ORIGIN_INVALID', `${field} must be an HTTP(S) origin.`, { field });
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail('SAFE_ORIGIN_INVALID', `${field} must be an HTTP(S) origin.`, { field });
  }
  if (parsed.username || parsed.password || parsed.origin === 'null' || !parsed.hostname) {
    fail('SAFE_ORIGIN_INVALID', `${field} must be an HTTP(S) origin.`, { field });
  }
  const https = parsed.protocol === 'https:';
  const loopbackHttp = parsed.protocol === 'http:' && LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase());
  if (!https && !loopbackHttp) {
    fail('SAFE_ORIGIN_INVALID', `${field} must be an HTTP(S) origin.`, { field });
  }
  return parsed.origin;
}

function originInput(input) {
  const candidate = input.safeOrigin ?? input.origin ?? input.url;
  if (candidate === undefined || candidate === null) {
    fail('FIELD_REQUIRED', 'safeOrigin is required.', { field: 'safeOrigin' });
  }
  return normalizeSafeOrigin(candidate, 'safeOrigin');
}

function defaultIdFactory(prefix) {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return `${prefix}-${uuid}`;
  fallbackIdCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${fallbackIdCounter.toString(36)}`;
}

function normalizeIdFactory(factory) {
  if (factory === undefined || factory === null) return defaultIdFactory;
  if (typeof factory !== 'function') fail('CONFIG_INVALID', 'idFactory must be a function.', { field: 'idFactory' });
  return factory;
}

function handoffIdFrom(input, idFactory) {
  const proposed = input.handoffId ?? input.requestId ?? input.id ?? idFactory('handoff');
  return boundedId(proposed, 'handoffId');
}

function normalizeType(value) {
  if (typeof value !== 'string' || !TYPE_VALUES.has(value)) {
    fail('HANDOFF_TYPE_INVALID', 'Handoff type must be login, 2fa, or captcha.', { field: 'type' });
  }
  return value;
}

function normalizeBinding(input) {
  return {
    missionId: boundedId(input.missionId, 'missionId'),
    memberId: boundedId(input.memberId, 'memberId'),
    sessionId: boundedId(input.sessionId, 'sessionId'),
    pageFingerprint: boundedId(input.pageFingerprint ?? input.pageId ?? input.page, 'pageFingerprint'),
    targetFingerprint: boundedId(
      input.targetFingerprint
        ?? input.targetId
        ?? input.target?.targetFingerprint
        ?? input.target?.fingerprint
        ?? input.target,
      'targetFingerprint',
    ),
    purpose: boundedText(input.purpose, 'purpose'),
    safeOrigin: originInput(input),
  };
}

function bindingFromRecord(record) {
  return {
    missionId: record.missionId,
    memberId: record.memberId,
    sessionId: record.sessionId,
    pageFingerprint: record.pageFingerprint,
    targetFingerprint: record.targetFingerprint,
    purpose: record.purpose,
    safeOrigin: record.safeOrigin,
  };
}

function sameBinding(expected, supplied) {
  return BINDING_FIELDS.every((field) => expected[field] === supplied[field]);
}

function normalizeAttemptBinding(input) {
  requiredObject(input, 'captchaAttempt');
  return normalizeBinding(input);
}

function publicAuthority(authority) {
  if (!authority) return null;
  return {
    intent: authority.intent,
    validatedAt: authority.validatedAt,
  };
}

function publicRecord(record) {
  return {
    handoffId: record.handoffId,
    type: record.type,
    state: record.state,
    missionId: record.missionId,
    memberId: record.memberId,
    sessionId: record.sessionId,
    pageFingerprint: record.pageFingerprint,
    targetFingerprint: record.targetFingerprint,
    purpose: record.purpose,
    safeOrigin: record.safeOrigin,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    expiresAt: record.expiresAt,
    captchaCheckboxAttempts: record.captchaCheckboxAttempts,
    revalidationRequired: record.revalidationRequired,
    uiAuthority: publicAuthority(record.uiAuthority),
    failureCode: record.failureCode,
    stillRequiredCode: record.stillRequiredCode,
  };
}

function persistenceBase(record) {
  return {
    handoffId: record.handoffId,
    type: record.type,
    state: record.state,
    missionId: record.missionId,
    memberId: record.memberId,
    sessionId: record.sessionId,
    pageFingerprint: record.pageFingerprint,
    targetFingerprint: record.targetFingerprint,
    purpose: record.purpose,
    safeOrigin: record.safeOrigin,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    expiresAt: record.expiresAt,
    ttlMs: record.ttlMs,
    captchaCheckboxAttempts: record.captchaCheckboxAttempts,
    failureCode: record.failureCode,
    stillRequiredCode: record.stillRequiredCode,
    uiIntentFingerprints: [...record.uiIntentFingerprints].sort(),
    completionProofFingerprints: [...record.completionProofFingerprints].sort(),
  };
}

function persistenceIntegrity(record, key) {
  return sha256Hex(stableStringify({
    key,
    record,
    version: HANDOFF_PERSISTENCE_VERSION,
  }));
}

function persistenceRecord(record, key) {
  const base = persistenceBase(record);
  return {
    ...base,
    integrity: persistenceIntegrity(base, requirePersistenceKey(key)),
  };
}

function persistenceInput(input) {
  let value = input;
  if (typeof input === 'string') {
    try {
      value = JSON.parse(input);
    } catch {
      fail('PERSISTENCE_INVALID', 'Handoff persistence is not valid JSON.');
    }
  }
  requiredObject(value, 'persistence');
  if (value.version !== HANDOFF_PERSISTENCE_VERSION) {
    fail('PERSISTENCE_VERSION_UNSUPPORTED', 'Handoff persistence version is unsupported.', { version: value.version });
  }
  if (!Array.isArray(value.handoffs)) fail('PERSISTENCE_INVALID', 'Handoff persistence handoffs must be an array.');
  return value;
}

function validatorFrom(options) {
  const validator = options.validateUiIntent;
  if (validator !== undefined && typeof validator !== 'function') {
    fail('CONFIG_INVALID', 'validateUiIntent must be a function.', { field: 'validateUiIntent' });
  }
  return validator ?? null;
}

function missionBindingValidatorFrom(options) {
  if (typeof options.validateMissionBinding !== 'function') {
    fail('CONFIG_INVALID', 'validateMissionBinding must be a function.', { field: 'validateMissionBinding' });
  }
  return options.validateMissionBinding;
}

function completionProofValidatorFrom(options) {
  const validator = options.validateCompletionProof;
  if (validator !== undefined && typeof validator !== 'function') {
    fail('CONFIG_INVALID', 'validateCompletionProof must be a function.', { field: 'validateCompletionProof' });
  }
  return validator ?? null;
}

function intentForRecord(record, intent) {
  const binding = bindingFromRecord(record);
  return Object.freeze({
    handoffId: record.handoffId,
    type: record.type,
    ...binding,
    origin: record.safeOrigin,
    binding: Object.freeze({ ...binding }),
    intent,
  });
}

function missionBindingContext(binding, { handoffId, type }) {
  return Object.freeze({
    handoffId,
    type,
    ...binding,
    origin: binding.safeOrigin,
    binding: Object.freeze({ ...binding }),
  });
}

const BINDING_FIELDS = Object.freeze([
  'missionId',
  'memberId',
  'sessionId',
  'pageFingerprint',
  'targetFingerprint',
  'purpose',
  'safeOrigin',
]);

function hasOwn(value, field) {
  return Object.prototype.hasOwnProperty.call(value, field);
}

function canonicalCompletionBinding(input, proof, record) {
  if (!isPlainObject(proof)
      || typeof proof.kind !== 'string'
      || !SAFE_ID.test(proof.kind)
      || proof.fresh !== true
      || proof.handoffId !== record.handoffId
      || proof.type !== record.type) {
    fail('COMPLETION_PROOF_INVALID', 'Completion proof must be fresh and exactly bound to this handoff.');
  }
  if (input.completionBinding !== undefined
      || input.binding !== undefined
      || BINDING_FIELDS.some((field) => hasOwn(input, field))
      || proof.completionBinding !== undefined
      || proof.origin !== undefined
      || proof.url !== undefined
      || BINDING_FIELDS.some((field) => hasOwn(proof, field))) {
    fail('COMPLETION_PROOF_BINDING_INVALID', 'Completion proof must use one canonical binding representation.');
  }
  if (!isPlainObject(proof.binding)) {
    fail('COMPLETION_PROOF_BINDING_REQUIRED', 'Completion proof must carry the exact handoff binding.');
  }
  const keys = Object.keys(proof.binding).sort();
  const expectedKeys = [...BINDING_FIELDS].sort();
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) {
    fail('COMPLETION_PROOF_BINDING_INVALID', 'Completion proof binding must contain only the canonical fields.');
  }
  let supplied;
  try {
    supplied = normalizeBinding(proof.binding);
  } catch (error) {
    if (error instanceof HandoffBrokerError && error.code === 'SAFE_ORIGIN_INVALID') throw error;
    fail('COMPLETION_PROOF_BINDING_INVALID', 'Completion proof binding is invalid.');
  }
  if (!sameBinding(bindingFromRecord(record), supplied)) {
    fail('HANDOFF_BINDING_MISMATCH', 'Completion proof does not match the exact handoff binding.');
  }
  return supplied;
}

function sameValue(left, right) {
  if (Object.is(left, right)) return true;
  try {
    return stableStringify(left) === stableStringify(right);
  } catch {
    return false;
  }
}

function visibleIntentBindingMatches(record, token) {
  if (!isPlainObject(token)
      || typeof token.kind !== 'string'
      || !SAFE_ID.test(token.kind)
      || token.handoffId !== record.handoffId
      || token.type !== record.type
      || token.binding !== undefined
      || token.origin !== undefined
      || token.url !== undefined) return false;
  const expected = bindingFromRecord(record);
  if (BINDING_FIELDS.some((field) => !hasOwn(token, field))) return false;
  try {
    return sameBinding(expected, normalizeBinding(token));
  } catch {
    return false;
  }
}

function tokenFingerprint(token) {
  try {
    return sha256Hex(stableStringify(token));
  } catch {
    return null;
  }
}

function assertNotAgent(input, field) {
  if (input.actor === 'agent' || input.source === 'agent' || input.caller === 'agent') {
    fail('UI_INTENT_REQUIRED', `${field} requires a trusted UI caller.`);
  }
}

function transitionError(record, expected) {
  fail('HANDOFF_STATE_INVALID', `Handoff must be in ${expected.join(' or ')} state.`, { expected, actual: record.state });
}

/**
 * A deliberately browser-independent handoff state machine.  It owns no
 * window, tab, browser, or service-worker side effects; callers supply a
 * separately validated UI-intent token before opening or completing a handoff.
 */
export class HandoffBroker {
  constructor(options = {}) {
    requiredObject(options, 'options');
    this.now = typeof options.now === 'function' ? options.now : () => new Date();
    this.idFactory = normalizeIdFactory(options.idFactory);
    this.validateMissionBinding = missionBindingValidatorFrom(options);
    this.validateUiIntent = validatorFrom(options);
    this.validateCompletionProof = completionProofValidatorFrom(options);
    this.persistenceKey = persistenceKeyFrom(options);
    this.defaultTtlMs = normalizeTtl(
      options.defaultTtlMs ?? options.defaultTtl ?? options.ttlMs,
      HANDOFF_TTL_LIMITS.DEFAULT_MS,
    );
    this.handoffs = new Map();
    if (options.persistence !== undefined) this.restore(options.persistence);
  }

  request(input = {}) {
    requiredObject(input, 'request');
    const handoffId = handoffIdFrom(input, this.idFactory);
    if (this.handoffs.has(handoffId)) fail('HANDOFF_ALREADY_EXISTS', 'Handoff already exists.', { handoffId });
    const type = normalizeType(input.type ?? input.kind);
    const binding = normalizeBinding(input);
    this.#requireMissionBinding(binding, { handoffId, type });
    const ttlMs = normalizeTtl(input.ttlMs ?? input.ttl, this.defaultTtlMs);
    const created = nowDate(this.now);
    const record = {
      handoffId,
      type,
      ...binding,
      state: HANDOFF_STATES.REQUESTED,
      createdAt: created.toISOString(),
      updatedAt: created.toISOString(),
      expiresAt: new Date(created.getTime() + ttlMs).toISOString(),
      ttlMs,
      captchaCheckboxAttempts: 0,
      revalidationRequired: false,
      uiAuthority: null,
      failureCode: null,
      stillRequiredCode: null,
      uiIntentFingerprints: new Set(),
      completionProofFingerprints: new Set(),
    };
    this.handoffs.set(handoffId, record);
    return this.state(handoffId);
  }

  has(handoffId) {
    return typeof handoffId === 'string' && this.handoffs.has(handoffId);
  }

  list() {
    return [...this.handoffs.keys()].map((handoffId) => this.state(handoffId));
  }

  state(handoffId) {
    const record = this.#record(handoffId);
    this.#expireIfNeeded(record);
    return publicClone(publicRecord(record));
  }

  awaitUiGesture(input = {}) {
    const record = this.#recordFromInput(input, 'awaitUiGesture');
    this.#expireIfNeeded(record);
    if (record.state === HANDOFF_STATES.AWAITING_UI_GESTURE) return this.state(record.handoffId);
    this.#assertMutable(record);
    if (record.state !== HANDOFF_STATES.REQUESTED) transitionError(record, [HANDOFF_STATES.REQUESTED]);
    this.#setState(record, HANDOFF_STATES.AWAITING_UI_GESTURE);
    return this.state(record.handoffId);
  }

  open(input = {}) {
    requiredObject(input, 'open');
    assertNotAgent(input, 'open');
    const record = this.#record(input.handoffId ?? input.requestId ?? input.id);
    this.#expireIfNeeded(record);
    this.#assertMutable(record);
    if (record.state !== HANDOFF_STATES.AWAITING_UI_GESTURE) {
      transitionError(record, [HANDOFF_STATES.AWAITING_UI_GESTURE]);
    }
    this.#requireUiIntent(
      record,
      input.uiIntent ?? input.uiIntentToken ?? input.intentToken ?? input.trustedUiIntent ?? input.token,
      'open',
    );
    record.revalidationRequired = false;
    this.#setState(record, HANDOFF_STATES.OPENING);
    return this.state(record.handoffId);
  }

  humanActive(input = {}) {
    return this.#transition(input, HANDOFF_STATES.OPENING, HANDOFF_STATES.HUMAN_ACTIVE);
  }

  returnRequested(input = {}) {
    return this.#transition(input, HANDOFF_STATES.HUMAN_ACTIVE, HANDOFF_STATES.RETURN_REQUESTED);
  }

  validate(input = {}) {
    return this.#transition(input, HANDOFF_STATES.RETURN_REQUESTED, HANDOFF_STATES.VALIDATING);
  }

  complete(input = {}) {
    requiredObject(input, 'complete');
    assertNotAgent(input, 'complete');
    const record = this.#record(input.handoffId ?? input.requestId ?? input.id);
    this.#expireIfNeeded(record);
    this.#assertMutable(record);
    if (record.state !== HANDOFF_STATES.VALIDATING) {
      transitionError(record, [HANDOFF_STATES.VALIDATING]);
    }
    const uiIntent = input.uiIntent ?? input.uiIntentToken ?? input.intentToken ?? input.trustedUiIntent ?? input.token;
    const completionProof = input.completionProof ?? input.completionBindingProof ?? input.proof;
    if (completionProof === undefined || completionProof === null) {
      fail('COMPLETION_PROOF_REQUIRED', 'A fresh completion proof is required.');
    }
    if (sameValue(uiIntent, completionProof)) {
      fail('COMPLETION_PROOF_INVALID', 'Completion proof must be separate from the UI intent.');
    }
    const suppliedBinding = canonicalCompletionBinding(input, completionProof, record);
    this.#requireUiIntent(record, uiIntent, 'complete');
    try {
      this.#requireCompletionProof(record, completionProof, suppliedBinding);
    } catch (error) {
      record.uiAuthority = null;
      throw error;
    }
    record.uiAuthority = null;
    this.#setState(record, HANDOFF_STATES.COMPLETED);
    return this.state(record.handoffId);
  }

  stillRequired(input = {}) {
    requiredObject(input, 'stillRequired');
    const record = this.#record(input.handoffId ?? input.requestId ?? input.id);
    this.#expireIfNeeded(record);
    this.#assertMutable(record);
    if (record.state !== HANDOFF_STATES.VALIDATING) {
      transitionError(record, [HANDOFF_STATES.VALIDATING]);
    }
    record.stillRequiredCode = boundedCode(input.reasonCode ?? input.reason, 'reasonCode', null);
    record.uiAuthority = null;
    this.#setState(record, HANDOFF_STATES.STILL_REQUIRED);
    return this.state(record.handoffId);
  }

  expire(input = {}) {
    const handoffId = typeof input === 'string' ? input : input?.handoffId ?? input?.requestId ?? input?.id;
    const record = this.#record(handoffId);
    if (record.state === HANDOFF_STATES.EXPIRED) return this.state(record.handoffId);
    if (TERMINAL_STATES.has(record.state)) fail('HANDOFF_TERMINAL', 'Handoff is already terminal.', { handoffId: record.handoffId });
    this.#setState(record, HANDOFF_STATES.EXPIRED);
    record.uiAuthority = null;
    return this.state(record.handoffId);
  }

  cancel(input = {}) {
    return this.#terminal(input, HANDOFF_STATES.CANCELLED);
  }

  fail(input = {}) {
    requiredObject(input, 'fail');
    const record = this.#record(input.handoffId ?? input.requestId ?? input.id);
    this.#expireIfNeeded(record);
    this.#assertMutable(record);
    record.failureCode = boundedCode(input.code ?? input.reasonCode ?? input.reason, 'reasonCode', 'HANDOFF_FAILED');
    this.#setState(record, HANDOFF_STATES.FAILED);
    record.uiAuthority = null;
    return this.state(record.handoffId);
  }

  captchaCheckboxAttempt(input = {}) {
    requiredObject(input, 'captchaAttempt');
    assertNotAgent(input, 'captcha-checkbox');
    const record = this.#record(input.handoffId ?? input.requestId ?? input.id);
    this.#expireIfNeeded(record);
    this.#assertMutable(record);
    if (record.type !== HANDOFF_TYPES.CAPTCHA) {
      fail('CAPTCHA_TYPE_REQUIRED', 'Checkbox attempts are only valid for CAPTCHA handoffs.');
    }
    if (record.state !== HANDOFF_STATES.HUMAN_ACTIVE) {
      transitionError(record, [HANDOFF_STATES.HUMAN_ACTIVE]);
    }
    if (input.safeOrigin === undefined || input.safeOrigin === null) {
      fail('FIELD_REQUIRED', 'safeOrigin is required for a CAPTCHA checkbox attempt.', { field: 'safeOrigin' });
    }
    const supplied = normalizeAttemptBinding(input);
    const expectedBinding = bindingFromRecord(record);
    if (!sameBinding(expectedBinding, supplied)
        || (supplied.safeOrigin !== null && supplied.safeOrigin !== expectedBinding.safeOrigin)) {
      fail('HANDOFF_BINDING_MISMATCH', 'CAPTCHA attempt does not match the exact handoff binding.');
    }
    if (record.captchaCheckboxAttempts >= 1) {
      fail('CAPTCHA_ATTEMPT_LIMIT', 'Only one CAPTCHA checkbox attempt is permitted.');
    }
    this.#requireUiIntent(
      record,
      input.uiIntent ?? input.uiIntentToken ?? input.intentToken ?? input.trustedUiIntent ?? input.token,
      'captcha-checkbox',
    );
    record.captchaCheckboxAttempts = 1;
    record.uiAuthority = null;
    this.#touch(record);
    return this.state(record.handoffId);
  }

  toPersistence() {
    const persistenceKey = requirePersistenceKey(this.persistenceKey);
    return publicClone({
      version: HANDOFF_PERSISTENCE_VERSION,
      handoffs: [...this.handoffs.values()].map((record) => persistenceRecord(record, persistenceKey)),
    });
  }

  toJSON() {
    return this.toPersistence();
  }

  restore(input) {
    const persistence = persistenceInput(input);
    const restored = [];
    const ids = new Set(this.handoffs.keys());
    for (const persisted of persistence.handoffs) {
      const record = this.#rehydrateRecord(persisted);
      if (ids.has(record.handoffId)) {
        fail('HANDOFF_ALREADY_EXISTS', 'Handoff already exists.', { handoffId: record.handoffId });
      }
      ids.add(record.handoffId);
      restored.push(record);
    }
    for (const record of restored) this.handoffs.set(record.handoffId, record);
    return this.list();
  }

  #rehydrateRecord(input) {
    requiredObject(input, 'handoff');
    const handoffId = boundedId(input.handoffId, 'handoffId');
    const type = normalizeType(input.type);
    const missionId = boundedId(input.missionId, 'missionId');
    const memberId = boundedId(input.memberId, 'memberId');
    const sessionId = boundedId(input.sessionId, 'sessionId');
    const pageFingerprint = boundedId(input.pageFingerprint, 'pageFingerprint');
    const targetFingerprint = boundedId(input.targetFingerprint, 'targetFingerprint');
    const purpose = boundedText(input.purpose, 'purpose');
    const safeOriginValue = normalizeSafeOrigin(input.safeOrigin, 'safeOrigin');
    if (!STATE_VALUES.has(input.state)) fail('PERSISTENCE_INVALID', 'Handoff state is unsupported.', { field: 'state' });
    const createdAt = timestamp(input.createdAt, 'createdAt');
    const updatedAt = timestamp(input.updatedAt, 'updatedAt');
    const expiresAt = timestamp(input.expiresAt, 'expiresAt');
    const ttlMs = normalizeTtl(input.ttlMs, null);
    const captchaCheckboxAttempts = integer(input.captchaCheckboxAttempts ?? 0, 'captchaCheckboxAttempts', { max: 1 });
    const uiIntentFingerprints = replayFingerprints(input.uiIntentFingerprints, 'uiIntentFingerprints');
    const completionProofFingerprints = replayFingerprints(input.completionProofFingerprints, 'completionProofFingerprints');
    const failureCode = boundedCode(input.failureCode, 'failureCode', null);
    const stillRequiredCode = boundedCode(input.stillRequiredCode, 'stillRequiredCode', null);
    const restoredNow = nowDate(this.now);
    const createdMs = new Date(createdAt).getTime();
    const updatedMs = new Date(updatedAt).getTime();
    const expiresMs = new Date(expiresAt).getTime();
    if (createdMs > updatedMs
        || updatedMs > restoredNow.getTime()
        || expiresMs <= createdMs
        || expiresMs - createdMs !== ttlMs) {
      fail('PERSISTENCE_TIME_INVALID', 'Handoff persistence has an impossible time or TTL range.');
    }
    const persistedRecord = {
      handoffId,
      type,
      missionId,
      memberId,
      sessionId,
      pageFingerprint,
      targetFingerprint,
      purpose,
      safeOrigin: safeOriginValue,
      state: input.state,
      createdAt,
      updatedAt,
      expiresAt,
      ttlMs,
      captchaCheckboxAttempts,
      failureCode,
      stillRequiredCode,
      uiIntentFingerprints: new Set(uiIntentFingerprints),
      completionProofFingerprints: new Set(completionProofFingerprints),
    };
    const integrity = typeof input.integrity === 'string' ? input.integrity : '';
    const expectedIntegrity = persistenceIntegrity(
      persistenceBase(persistedRecord),
      requirePersistenceKey(this.persistenceKey),
    );
    if (!SHA256_FINGERPRINT.test(integrity) || !equalFingerprint(integrity, expectedIntegrity)) {
      fail('PERSISTENCE_INTEGRITY_INVALID', 'Handoff persistence failed its integrity check.');
    }
    const binding = bindingFromRecord(persistedRecord);
    this.#requireMissionBinding(binding, { handoffId, type });
    const expired = expiresMs <= restoredNow.getTime();
    const state = expired
      ? HANDOFF_STATES.EXPIRED
      : (NON_REHYDRATABLE_STATES.has(input.state) ? HANDOFF_STATES.AWAITING_UI_GESTURE : input.state);
    return {
      ...persistedRecord,
      state,
      revalidationRequired: state === HANDOFF_STATES.AWAITING_UI_GESTURE,
      uiAuthority: null,
    };
  }

  #record(handoffId) {
    const id = boundedId(handoffId, 'handoffId');
    const record = this.handoffs.get(id);
    if (!record) fail('HANDOFF_NOT_FOUND', 'Handoff was not found.', { handoffId: id });
    return record;
  }

  #recordFromInput(input, field) {
    requiredObject(input, field);
    return this.#record(input.handoffId ?? input.requestId ?? input.id);
  }

  #touch(record) {
    record.updatedAt = nowDate(this.now).toISOString();
  }

  #setState(record, state) {
    if (!STATE_VALUES.has(state)) fail('HANDOFF_STATE_INVALID', 'Unknown handoff state.', { field: 'state' });
    record.state = state;
    this.#touch(record);
  }

  #expireIfNeeded(record) {
    if (TERMINAL_STATES.has(record.state)) return false;
    if (nowDate(this.now).getTime() < new Date(record.expiresAt).getTime()) return false;
    this.#setState(record, HANDOFF_STATES.EXPIRED);
    record.uiAuthority = null;
    return true;
  }

  #assertMutable(record) {
    if (record.state === HANDOFF_STATES.EXPIRED) fail('HANDOFF_EXPIRED', 'Handoff has expired.', { handoffId: record.handoffId });
    if (TERMINAL_STATES.has(record.state)) fail('HANDOFF_TERMINAL', 'Handoff is already terminal.', { handoffId: record.handoffId });
  }

  #transition(input, expected, next) {
    const record = this.#recordFromInput(input, 'transition');
    this.#expireIfNeeded(record);
    this.#assertMutable(record);
    if (record.state !== expected) transitionError(record, [expected]);
    this.#setState(record, next);
    return this.state(record.handoffId);
  }

  #terminal(input, next) {
    const record = this.#recordFromInput(input, 'terminal');
    this.#expireIfNeeded(record);
    this.#assertMutable(record);
    this.#setState(record, next);
    record.uiAuthority = null;
    return this.state(record.handoffId);
  }

  #requireUiIntent(record, token, intent) {
    if (token === undefined || token === null) fail('UI_INTENT_REQUIRED', 'A separately validated UI intent is required.');
    if (!this.validateUiIntent) fail('UI_INTENT_INVALID', 'The UI intent validator is unavailable.');
    if (!isPlainObject(token) || token.intent !== intent) {
      fail('UI_INTENT_INVALID', 'The UI intent is invalid or does not match this handoff.');
    }
    if (!visibleIntentBindingMatches(record, token)) {
      fail('UI_INTENT_INVALID', 'The UI intent is invalid or does not match this handoff.');
    }
    const fingerprint = tokenFingerprint(token);
    if (!fingerprint) fail('UI_INTENT_INVALID', 'The UI intent is invalid or does not match this handoff.');
    if (record.uiIntentFingerprints.has(fingerprint)) {
      fail('UI_INTENT_REPLAY', 'The UI intent has already been consumed.');
    }
    let valid = false;
    try {
      const result = this.validateUiIntent(token, intentForRecord(record, intent));
      valid = validatorResultAccepted(result);
      if (result && typeof result.then === 'function') valid = false;
    } catch {
      valid = false;
    }
    if (!valid) fail('UI_INTENT_INVALID', 'The UI intent is invalid or does not match this handoff.');
    record.uiIntentFingerprints.add(fingerprint);
    record.uiAuthority = {
      intent,
      validatedAt: nowDate(this.now).toISOString(),
    };
  }

  #requireMissionBinding(binding, metadata) {
    let valid = false;
    try {
      const result = this.validateMissionBinding(
        Object.freeze({ ...binding }),
        missionBindingContext(binding, metadata),
      );
      valid = validatorResultAccepted(result);
    } catch {
      valid = false;
    }
    if (!valid) fail('MISSION_BINDING_INVALID', 'The mission binding was not trusted or accepted.');
  }

  #requireCompletionProof(record, proof, binding) {
    if (!this.validateCompletionProof) {
      fail('COMPLETION_PROOF_INVALID', 'The completion proof validator is unavailable.');
    }
    const fingerprint = tokenFingerprint(proof);
    if (!fingerprint) fail('COMPLETION_PROOF_INVALID', 'The completion proof is invalid or stale.');
    if (record.completionProofFingerprints.has(fingerprint)) {
      fail('COMPLETION_PROOF_REPLAY', 'The completion proof has already been consumed.');
    }
    const expected = Object.freeze({
      ...intentForRecord(record, 'complete'),
      fresh: true,
      completionBinding: Object.freeze({ ...binding }),
    });
    let valid = false;
    try {
      valid = validatorResultAccepted(this.validateCompletionProof(proof, expected));
    } catch {
      valid = false;
    }
    if (!valid) fail('COMPLETION_PROOF_INVALID', 'The completion proof is invalid or stale.');
    record.completionProofFingerprints.add(fingerprint);
  }
}

export function createHandoffBroker(options = {}) {
  return new HandoffBroker(options);
}

export function rehydrateHandoffBroker(input, options = {}) {
  requiredObject(options, 'options');
  return new HandoffBroker({ ...options, persistence: input });
}

/**
 * Produce a deterministic opaque-looking fixture token.  This helper does
 * not make a token trusted: callers must still install a validator and have
 * that validator independently accept the token.
 */
export function syntheticUiIntent(input = {}) {
  requiredObject(input, 'syntheticUiIntent');
  return clone({
    kind: 'toolbraid.synthetic-ui-intent',
    handoffId: input.handoffId,
    type: input.type,
    missionId: input.missionId,
    memberId: input.memberId,
    sessionId: input.sessionId,
    pageFingerprint: input.pageFingerprint,
    targetFingerprint: input.targetFingerprint,
    purpose: input.purpose,
    safeOrigin: input.safeOrigin,
    intent: input.intent,
  });
}

export function handoffBindingFor(state) {
  requiredObject(state, 'state');
  return publicClone({
    missionId: boundedId(state.missionId, 'missionId'),
    memberId: boundedId(state.memberId, 'memberId'),
    sessionId: boundedId(state.sessionId, 'sessionId'),
    pageFingerprint: boundedId(state.pageFingerprint, 'pageFingerprint'),
    targetFingerprint: boundedId(state.targetFingerprint, 'targetFingerprint'),
    purpose: boundedText(state.purpose, 'purpose'),
    safeOrigin: normalizeSafeOrigin(state.safeOrigin, 'safeOrigin'),
  });
}

export function handoffStateDigest(state) {
  return sha256Hex(stableStringify(handoffBindingFor(state)));
}
