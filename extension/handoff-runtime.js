import {
  HANDOFF_STATES,
  HandoffBrokerError,
  createHandoffBroker,
  normalizeSafeOrigin,
  rehydrateHandoffBroker,
} from '../src/runtime/handoff-broker.js';
import {
  sha256Hex,
  stableStringify,
} from '../src/universal/canonical.js';

const RUNTIME_PERSISTENCE_VERSION = 1;
const RUNTIME_META_KEY = 'toolbraid.extension.handoff.runtime.meta.v1';
const RUNTIME_PROVENANCE = 'toolbraid-extension-handoff-runtime';
const SAFE_CODE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const SURFACE_KIND = 'toolbraid.sidepanel-created-handoff-surface';
const SURFACE_CREATOR = 'sidepanel';
export const HANDOFF_UI_MESSAGE_TYPES = Object.freeze({
  GET_STATE: 'UI_HANDOFF_GET_STATE',
  REQUEST: 'UI_HANDOFF_REQUEST',
  OPEN_SURFACE: 'UI_HANDOFF_OPEN_SURFACE',
  CAPTCHA_ATTEMPT: 'UI_HANDOFF_CAPTCHA_ATTEMPT',
  COMPLETE: 'UI_HANDOFF_COMPLETE',
});
const HANDOFF_UI_MESSAGE_SET = new Set(Object.values(HANDOFF_UI_MESSAGE_TYPES));
const HANDOFF_BINDING_FIELDS = Object.freeze([
  'missionId',
  'memberId',
  'sessionId',
  'pageFingerprint',
  'targetFingerprint',
  'purpose',
  'safeOrigin',
]);
const SOURCE_BINDING_FIELDS = Object.freeze([
  ...HANDOFF_BINDING_FIELDS,
  'tabId',
  'frameId',
  'windowId',
  'documentId',
  'pageInstanceId',
  'origin',
]);
// `purpose` is the handoff's user-facing objective, not a page/lifecycle
// identity field. It is still bound by the broker and proofs, but it may be
// selected per handoff (for example, a CAPTCHA objective on the same page).
const SOURCE_IDENTITY_FIELDS = Object.freeze(SOURCE_BINDING_FIELDS.filter((field) => field !== 'purpose'));
const SURFACE_FIELDS = Object.freeze([
  'kind',
  'createdBy',
  'surfaceId',
  'tabId',
  'frameId',
  'windowId',
  'origin',
]);

export const EXTENSION_HANDOFF_PERSISTENCE_VERSION = RUNTIME_PERSISTENCE_VERSION;

export function isHandoffUiMessageType(type) {
  return HANDOFF_UI_MESSAGE_SET.has(type);
}

export class ExtensionHandoffRuntimeError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ExtensionHandoffRuntimeError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details = {}) {
  throw new ExtensionHandoffRuntimeError(code, message, details);
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

function clone(value, field = 'value') {
  try {
    return structuredClone(value);
  } catch {
    fail('DATA_INVALID', `${field} is not JSON-safe.`, { field });
  }
}

function safeCode(error, fallback) {
  return typeof error?.code === 'string' && SAFE_CODE.test(error.code) ? error.code : fallback;
}

function safeError(error, fallbackCode = 'HANDOFF_RUNTIME_FAILED', fallbackMessage = 'The handoff runtime rejected the operation.') {
  if (error instanceof ExtensionHandoffRuntimeError) return error;
  if (error instanceof HandoffBrokerError) {
    return new ExtensionHandoffRuntimeError(safeCode(error, fallbackCode), fallbackMessage, {});
  }
  return new ExtensionHandoffRuntimeError(fallbackCode, fallbackMessage, {});
}

function validatorAccepted(result) {
  if (result && typeof result.then === 'function') return false;
  return result === true || result?.valid === true || result?.ok === true || result?.accepted === true;
}

function hasOwn(value, field) {
  return Object.prototype.hasOwnProperty.call(value, field);
}

function sameValue(left, right) {
  if (Object.is(left, right)) return true;
  try {
    return stableStringify(left) === stableStringify(right);
  } catch {
    return false;
  }
}

function positiveInteger(value, field, { optional = false } = {}) {
  if (value === undefined || value === null) {
    if (optional) return null;
    fail('FIELD_REQUIRED', `${field} is required.`, { field });
  }
  if (!Number.isInteger(value) || value < 0) fail('FIELD_INVALID', `${field} must be a non-negative integer.`, { field });
  return value;
}

function boundedString(value, field, { optional = false } = {}) {
  if (value === undefined || value === null) {
    if (optional) return null;
    fail('FIELD_REQUIRED', `${field} is required.`, { field });
  }
  if (typeof value !== 'string' || value.length < 1 || value.length > 512 || value.includes('\u0000')) {
    fail('FIELD_INVALID', `${field} is invalid.`, { field });
  }
  return value;
}

function canonicalOrigin(value, field = 'origin') {
  return normalizeSafeOrigin(value, field);
}

function callStorage(area, method, argument) {
  if (!area || typeof area[method] !== 'function') {
    return Promise.reject(new ExtensionHandoffRuntimeError(
      'STORAGE_UNAVAILABLE',
      'Handoff persistence storage is unavailable.',
    ));
  }
  const operation = area[method];
  if (operation.length >= 2) {
    return new Promise((resolve, reject) => {
      try {
        operation.call(area, argument, (value) => {
          const runtimeError = globalThis.chrome?.runtime?.lastError;
          if (runtimeError) reject(new ExtensionHandoffRuntimeError(
            method === 'get' ? 'STORAGE_READ_FAILED' : 'STORAGE_WRITE_FAILED',
            method === 'get' ? 'Handoff persistence could not be read.' : 'Handoff persistence could not be written.',
          ));
          else resolve(value);
        });
      } catch {
        reject(new ExtensionHandoffRuntimeError(
          method === 'get' ? 'STORAGE_READ_FAILED' : 'STORAGE_WRITE_FAILED',
          method === 'get' ? 'Handoff persistence could not be read.' : 'Handoff persistence could not be written.',
        ));
      }
    });
  }
  try {
    const result = operation.call(area, argument);
    return result && typeof result.then === 'function' ? result : Promise.resolve(result);
  } catch {
    return Promise.reject(new ExtensionHandoffRuntimeError(
      method === 'get' ? 'STORAGE_READ_FAILED' : 'STORAGE_WRITE_FAILED',
      method === 'get' ? 'Handoff persistence could not be read.' : 'Handoff persistence could not be written.',
    ));
  }
}

async function storageGet(area, key) {
  try {
    const result = await callStorage(area, 'get', key);
    if (isPlainObject(result) && hasOwn(result, key)) return result[key];
    // Chrome returns an empty object for a missing key. A direct-value test
    // double may instead return the persistence/metadata object itself.
    if (isPlainObject(result)
        && (hasOwn(result, 'handoffs') || hasOwn(result, 'keyFingerprint'))) return result;
    if (isPlainObject(result) && Object.keys(result).length === 0) return undefined;
    return result;
  } catch (error) {
    throw safeError(error, 'STORAGE_READ_FAILED', 'Handoff persistence could not be read.');
  }
}

async function storageSet(area, values) {
  try {
    await callStorage(area, 'set', clone(values, 'persistence'));
  } catch (error) {
    throw safeError(error, 'STORAGE_WRITE_FAILED', 'Handoff persistence could not be written.');
  }
}

function persistenceMetadata(key) {
  const keyFingerprint = sha256Hex(key);
  const base = {
    version: RUNTIME_PERSISTENCE_VERSION,
    provenance: RUNTIME_PROVENANCE,
    keyFingerprint,
  };
  return {
    ...base,
    integrity: sha256Hex(base),
  };
}

function validatePersistenceMetadata(value, key) {
  if (!isPlainObject(value)) fail('PERSISTENCE_INVALID', 'Handoff persistence metadata is invalid.');
  const expected = persistenceMetadata(key);
  if (value.version !== expected.version
      || value.provenance !== expected.provenance
      || value.keyFingerprint !== expected.keyFingerprint
      || value.integrity !== expected.integrity) {
    fail('PERSISTENCE_KEY_MISMATCH', 'Handoff persistence belongs to a different extension key.');
  }
  return expected;
}

function normalizePersistenceKey(value) {
  if (typeof value !== 'string' || value.length < 32 || value.length > 256) {
    fail('CONFIG_INVALID', 'persistenceKey must be a secret string of 32 to 256 characters.', { field: 'persistenceKey' });
  }
  if (value === RUNTIME_META_KEY) fail('CONFIG_INVALID', 'persistenceKey is reserved.', { field: 'persistenceKey' });
  return value;
}

function chooseStorage(options) {
  const area = options.storageArea
    ?? options.storage
    ?? options.chromeApi?.storage?.session
    ?? options.chromeApi?.storage?.local
    ?? globalThis.chrome?.storage?.session
    ?? globalThis.chrome?.storage?.local;
  if (!area || typeof area.get !== 'function' || typeof area.set !== 'function') {
    fail('STORAGE_UNAVAILABLE', 'Handoff persistence storage is unavailable.');
  }
  return area;
}

function missionBindingFrom(mission, input) {
  if (!mission || typeof mission.getBinding !== 'function') return null;
  try {
    const value = mission.getBinding(input.missionId, input.memberId);
    return isPlainObject(value) ? clone(value, 'mission binding') : null;
  } catch {
    fail('MISSION_BINDING_INVALID', 'The mission binding could not be read.');
  }
}

function lifecycleBindingFrom(lifecycle, tabId, frameId) {
  if (!lifecycle || typeof lifecycle.get !== 'function') {
    fail('LIFECYCLE_UNAVAILABLE', 'The exact page lifecycle is unavailable.');
  }
  try {
    const value = lifecycle.get(tabId, frameId);
    if (!isPlainObject(value)) fail('LIFECYCLE_BINDING_INVALID', 'The exact page lifecycle binding is unavailable.');
    return clone(value, 'lifecycle binding');
  } catch (error) {
    if (error instanceof ExtensionHandoffRuntimeError) throw error;
    fail('LIFECYCLE_BINDING_INVALID', 'The exact page lifecycle binding is unavailable.');
  }
}

function compareField(expected, supplied, field) {
  if (supplied === undefined || supplied === null) return;
  if (expected === undefined || expected === null) return;
  let left = supplied;
  let right = expected;
  if (field === 'origin' || field === 'safeOrigin') {
    try {
      left = canonicalOrigin(supplied, field);
      right = canonicalOrigin(expected, field);
    } catch {
      fail('HANDOFF_BINDING_MISMATCH', 'The exact handoff binding is invalid.');
    }
  }
  if (!sameValue(left, right)) fail('HANDOFF_BINDING_MISMATCH', 'The exact handoff binding is not current.');
}

function extractOrigin(value) {
  if (value?.origin !== undefined) return canonicalOrigin(value.origin, 'origin');
  if (value?.url !== undefined && typeof value.url === 'string') return canonicalOrigin(value.url, 'origin');
  return null;
}

function sourceBinding(input, lifecycle, mission, configuredMissionValidator = null) {
  requiredObject(input, 'request');
  const tabId = positiveInteger(input.tabId ?? input.sourceTabId, 'tabId');
  const frameId = positiveInteger(input.frameId ?? input.sourceFrameId ?? 0, 'frameId');
  const live = lifecycleBindingFrom(lifecycle, tabId, frameId);
  const missionBinding = missionBindingFrom(mission, input);
  const suppliedOrigin = input.origin === undefined ? null : canonicalOrigin(input.origin, 'origin');
  const suppliedSafeOrigin = input.safeOrigin === undefined
    ? (input.url === undefined ? null : canonicalOrigin(input.url, 'safeOrigin'))
    : canonicalOrigin(input.safeOrigin, 'safeOrigin');
  const liveOrigin = extractOrigin(live);
  const missionOrigin = extractOrigin(missionBinding);
  if (liveOrigin && suppliedOrigin) compareField(liveOrigin, suppliedOrigin, 'origin');
  if (missionOrigin && suppliedOrigin) compareField(missionOrigin, suppliedOrigin, 'origin');
  if (liveOrigin && suppliedSafeOrigin) compareField(liveOrigin, suppliedSafeOrigin, 'safeOrigin');
  if (missionOrigin && suppliedSafeOrigin) compareField(missionOrigin, suppliedSafeOrigin, 'safeOrigin');

  for (const field of SOURCE_IDENTITY_FIELDS) {
    const supplied = input[field];
    if (supplied === undefined || supplied === null) continue;
    compareField(live[field], supplied, field);
    compareField(missionBinding?.[field], supplied, field);
  }
  for (const field of SOURCE_IDENTITY_FIELDS) {
    if (live[field] !== undefined && missionBinding?.[field] !== undefined) {
      compareField(live[field], missionBinding[field], field);
    }
  }

  const source = {};
  for (const field of SOURCE_BINDING_FIELDS) {
    source[field] = input[field] ?? missionBinding?.[field] ?? live[field];
  }
  source.tabId = tabId;
  source.frameId = frameId;
  if (source.targetFingerprint === undefined) {
    source.targetFingerprint = input.target?.targetFingerprint
      ?? input.target?.fingerprint
      ?? input.target;
  }
  if (source.pageFingerprint === undefined) {
    source.pageFingerprint = input.pageId ?? input.page;
  }
  if (source.sessionId === undefined) source.sessionId = input.sessionId;
  if (source.missionId === undefined) source.missionId = input.missionId;
  if (source.memberId === undefined) source.memberId = input.memberId;
  if (source.purpose === undefined) source.purpose = input.purpose;
  source.origin = canonicalOrigin(source.origin ?? source.safeOrigin ?? input.url, 'origin');
  source.safeOrigin = canonicalOrigin(suppliedSafeOrigin ?? source.safeOrigin ?? source.origin, 'safeOrigin');
  source.origin = canonicalOrigin(source.origin, 'origin');
  for (const field of ['missionId', 'memberId', 'sessionId', 'pageFingerprint', 'targetFingerprint', 'purpose']) {
    boundedString(source[field], field);
  }
  if (source.windowId !== undefined && source.windowId !== null) positiveInteger(source.windowId, 'windowId');
  for (const field of ['documentId', 'pageInstanceId']) {
    if (source[field] !== undefined && source[field] !== null) boundedString(source[field], field);
  }
  if (mission && typeof mission.validateBinding === 'function') {
    let valid = false;
    try {
      const validationSource = missionBinding?.purpose && source.purpose !== missionBinding.purpose
        ? { ...source, purpose: missionBinding.purpose }
        : source;
      valid = validatorAccepted(mission.validateBinding(clone(validationSource, 'binding')));
    } catch {
      valid = false;
    }
    if (!valid) fail('MISSION_BINDING_INVALID', 'The mission binding was not trusted or accepted.');
  }
  if (mission && typeof mission.validateMissionBinding === 'function') {
    let valid = false;
    try {
      const validationSource = missionBinding?.purpose && source.purpose !== missionBinding.purpose
        ? { ...source, purpose: missionBinding.purpose }
        : source;
      valid = validatorAccepted(mission.validateMissionBinding(clone(validationSource, 'binding')));
    } catch {
      valid = false;
    }
    if (!valid) fail('MISSION_BINDING_INVALID', 'The mission binding was not trusted or accepted.');
  }
  if (typeof configuredMissionValidator === 'function') {
    let validationSource = source;
    if (missionBinding?.purpose && source.purpose !== missionBinding.purpose) {
      validationSource = { ...source, purpose: missionBinding.purpose };
    }
    if (!validatorCall(configuredMissionValidator, clone(validationSource, 'binding'), {
      missionId: source.missionId,
      memberId: source.memberId,
      type: input.type ?? input.kind,
      binding: clone(validationSource, 'binding'),
    })) {
      fail('MISSION_BINDING_INVALID', 'The mission binding was not trusted or accepted.');
    }
  }
  return Object.freeze(source);
}

function bindingFromState(state) {
  return {
    missionId: state.missionId,
    memberId: state.memberId,
    sessionId: state.sessionId,
    pageFingerprint: state.pageFingerprint,
    targetFingerprint: state.targetFingerprint,
    purpose: state.purpose,
    safeOrigin: state.safeOrigin,
  };
}

function reducedBindingMatches(source, state) {
  const expected = bindingFromState(state);
  return HANDOFF_BINDING_FIELDS.every((field) => source[field] === expected[field]);
}

function liveEquivalent(expected, live, { surface = false } = {}) {
  if (!isPlainObject(live)) return false;
  if (live.state !== undefined && live.state !== 'active') return false;
  const candidate = surface && isPlainObject(live.binding) ? live.binding : live;
  const fields = surface
    ? ['tabId', 'frameId', 'windowId', 'origin']
    : ['tabId', 'frameId', 'windowId', 'sessionId', 'documentId', 'pageInstanceId', 'pageFingerprint', 'origin'];
  for (const field of fields) {
    const expectedValue = surface ? expected[field] : expected[field];
    if (expectedValue === undefined || expectedValue === null) continue;
    const liveValue = surface ? live[field] : candidate[field];
    if (liveValue !== undefined && liveValue !== null) {
      if (field === 'origin') {
        try {
          if (canonicalOrigin(liveValue, field) !== canonicalOrigin(expectedValue, field)) return false;
        } catch {
          return false;
        }
      } else if (liveValue !== expectedValue) return false;
    }
  }
  if (surface && isPlainObject(live.binding)) {
    if (live.kind !== undefined && live.kind !== SURFACE_KIND) return false;
    if (live.createdBy !== undefined && live.createdBy !== SURFACE_CREATOR) return false;
    for (const field of SOURCE_BINDING_FIELDS) {
      if (live.binding[field] !== undefined && expected.binding?.[field] !== undefined) {
        if (field === 'origin' || field === 'safeOrigin') {
          try {
            if (canonicalOrigin(live.binding[field], field) !== canonicalOrigin(expected.binding[field], field)) return false;
          } catch {
            return false;
          }
        } else if (live.binding[field] !== expected.binding[field]) return false;
      }
    }
  }
  return true;
}

function normalizeSurface(surface, source) {
  requiredObject(surface, 'surface');
  if (surface.kind !== SURFACE_KIND || surface.createdBy !== SURFACE_CREATOR) {
    fail('SURFACE_INVALID', 'Only the canonical side-panel handoff surface is accepted.');
  }
  const surfaceId = boundedString(surface.surfaceId, 'surfaceId');
  if (!SAFE_CODE.test(surfaceId)) fail('SURFACE_INVALID', 'The handoff surface identifier is invalid.');
  const tabId = positiveInteger(surface.tabId, 'surface.tabId');
  const frameId = positiveInteger(surface.frameId, 'surface.frameId');
  const windowId = positiveInteger(surface.windowId, 'surface.windowId');
  const origin = canonicalOrigin(surface.origin, 'surface.origin');
  if (surface.origin !== origin) fail('SURFACE_INVALID', 'The handoff surface origin must be canonical.');
  if (origin !== source.origin) fail('SURFACE_BINDING_MISMATCH', 'The handoff surface origin is not exact.');
  requiredObject(surface.binding, 'surface.binding');
  const bindingKeys = Object.keys(surface.binding).sort();
  const expectedBindingKeys = [...SOURCE_BINDING_FIELDS].sort();
  if (bindingKeys.length !== expectedBindingKeys.length
      || bindingKeys.some((key, index) => key !== expectedBindingKeys[index])) {
    fail('SURFACE_BINDING_MISMATCH', 'The handoff surface binding is not canonical.');
  }
  for (const field of SOURCE_IDENTITY_FIELDS) {
    if (!hasOwn(surface.binding, field)) fail('SURFACE_BINDING_MISMATCH', 'The handoff surface binding is incomplete.');
    compareField(source[field], surface.binding[field], field);
  }
  // A surface may be a reusable side-panel shell whose descriptive purpose
  // predates this particular CAPTCHA/login objective; identity fields above
  // remain exact and the broker binds the selected purpose separately.
  if (surface.binding.safeOrigin !== source.safeOrigin) {
    fail('SURFACE_BINDING_MISMATCH', 'The handoff surface binding is not exact.');
  }
  return Object.freeze({
    kind: SURFACE_KIND,
    createdBy: SURFACE_CREATOR,
    surfaceId,
    tabId,
    frameId,
    windowId,
    origin,
    binding: Object.freeze(clone(surface.binding, 'surface.binding')),
  });
}

function intentFor(state, intent) {
  return {
    handoffId: state.handoffId,
    type: state.type,
    missionId: state.missionId,
    memberId: state.memberId,
    sessionId: state.sessionId,
    pageFingerprint: state.pageFingerprint,
    targetFingerprint: state.targetFingerprint,
    purpose: state.purpose,
    safeOrigin: state.safeOrigin,
    intent,
  };
}

function extractUiIntent(input) {
  return input.uiIntent ?? input.uiIntentToken ?? input.intentToken ?? input.trustedUiIntent ?? input.token;
}

function validateUiIntentShape(token, state, intent) {
  if (!isPlainObject(token) || token.kind !== 'toolbraid.synthetic-ui-intent' || token.intent !== intent) {
    fail('UI_INTENT_INVALID', 'The UI intent is invalid or does not match this handoff.');
  }
  const expected = intentFor(state, intent);
  for (const field of ['handoffId', 'type', ...HANDOFF_BINDING_FIELDS, 'intent']) {
    if (!hasOwn(token, field) || token[field] !== expected[field]) {
      fail('UI_INTENT_INVALID', 'The UI intent is invalid or does not match this handoff.');
    }
  }
  if (token.binding !== undefined || token.origin !== undefined || token.url !== undefined) {
    fail('UI_INTENT_INVALID', 'The UI intent is invalid or does not match this handoff.');
  }
  return token;
}

function validateCompletionProofShape(proof, state) {
  if (!isPlainObject(proof)
      || proof.kind !== 'toolbraid.completion-proof'
      || proof.fresh !== true
      || proof.handoffId !== state.handoffId
      || proof.type !== state.type
      || !isPlainObject(proof.binding)) {
    fail('COMPLETION_PROOF_INVALID', 'A fresh canonical completion proof is required.');
  }
  const allowed = new Set(['kind', 'fresh', 'handoffId', 'type', 'binding']);
  if (Object.keys(proof).some((key) => !allowed.has(key))) {
    fail('COMPLETION_PROOF_BINDING_INVALID', 'Completion proof must use one canonical binding representation.');
  }
  const keys = Object.keys(proof.binding).sort();
  const expectedKeys = [...HANDOFF_BINDING_FIELDS].sort();
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) {
    fail('COMPLETION_PROOF_BINDING_INVALID', 'Completion proof binding must contain only the canonical fields.');
  }
  const expected = bindingFromState(state);
  for (const field of HANDOFF_BINDING_FIELDS) {
    if (proof.binding[field] !== expected[field]) fail('HANDOFF_BINDING_MISMATCH', 'Completion proof does not match this handoff.');
  }
  return proof;
}

function validatorCall(validator, value, expected) {
  if (typeof validator !== 'function') return true;
  try {
    return validatorAccepted(validator(value, expected));
  } catch {
    return false;
  }
}

/**
 * Extension/service-worker handoff boundary. The worker owns only the
 * broker and its redacted persistence. A side panel must create and report
 * the human surface; this module never opens, navigates, injects, messages,
 * or captures browser content.
 */
export async function createExtensionHandoffRuntime(options = {}) {
  requiredObject(options, 'options');
  const persistenceKey = normalizePersistenceKey(options.persistenceKey);
  const storage = chooseStorage(options);
  const mission = options.missionCoordinator ?? options.mission ?? null;
  const lifecycle = options.lifecycleRegistry ?? options.lifecycle ?? null;
  const metadata = await storageGet(storage, RUNTIME_META_KEY);
  if (metadata !== undefined) validatePersistenceMetadata(metadata, persistenceKey);
  const persisted = await storageGet(storage, persistenceKey);

  const brokerOptions = { ...options, persistenceKey };
  delete brokerOptions.storage;
  delete brokerOptions.storageArea;
  delete brokerOptions.chromeApi;
  delete brokerOptions.mission;
  delete brokerOptions.missionCoordinator;
  delete brokerOptions.lifecycle;
  delete brokerOptions.lifecycleRegistry;
  delete brokerOptions.persistence;

  // The broker receives the canonical handoff binding. A mission coordinator
  // may carry a default objective/purpose, while each handoff can narrow that
  // objective (notably login versus CAPTCHA) on the same live page. Keep the
  // coordinator's identity checks intact and let the broker bind the selected
  // purpose to this handoff's proofs.
  if (typeof brokerOptions.validateMissionBinding === 'function') {
    const configuredMissionValidator = brokerOptions.validateMissionBinding;
    brokerOptions.validateMissionBinding = (binding, context) => {
      const canonicalMission = missionBindingFrom(mission, context?.binding ?? context ?? binding);
      let candidate = canonicalMission ? { ...canonicalMission, ...binding } : binding;
      if (canonicalMission?.purpose && binding.purpose !== canonicalMission.purpose) {
        candidate = { ...candidate, purpose: canonicalMission.purpose };
      }
      return configuredMissionValidator(candidate, context);
    };
  }

  let broker;
  if (persisted === undefined) {
    if (metadata !== undefined) fail('PERSISTENCE_INVALID', 'Handoff persistence metadata has no matching state.');
    broker = createHandoffBroker(brokerOptions);
  } else {
    broker = rehydrateHandoffBroker(persisted, brokerOptions);
  }

  const sourceBindings = new Map();
  const surfaces = new Map();
  let fatalError = null;
  let queue = Promise.resolve();

  function ensureReady() {
    if (fatalError) throw fatalError;
  }

  function rememberFatal(error) {
    const value = safeError(error, 'STORAGE_WRITE_FAILED', 'Handoff persistence could not be written.');
    fatalError = value;
    return value;
  }

  async function persist() {
    ensureReady();
    try {
      await storageSet(storage, {
        [persistenceKey]: broker.toPersistence(),
        [RUNTIME_META_KEY]: persistenceMetadata(persistenceKey),
      });
    } catch (error) {
      throw rememberFatal(error);
    }
  }

  function enqueue(operation) {
    const task = queue.then(async () => {
      ensureReady();
      try {
        return await operation();
      } catch (error) {
        throw safeError(error);
      }
    });
    queue = task.catch(() => undefined);
    return task;
  }

  function currentState(handoffId) {
    ensureReady();
    try {
      return broker.state(handoffId);
    } catch (error) {
      throw safeError(error, 'HANDOFF_STATE_INVALID', 'The handoff state is unavailable.');
    }
  }

  function sourceFor(handoffId, state = currentState(handoffId)) {
    const source = sourceBindings.get(handoffId);
    if (!source || !reducedBindingMatches(source, state)) {
      fail('HANDOFF_REVALIDATION_REQUIRED', 'This handoff requires a fresh page binding.');
    }
    const canonicalMission = missionBindingFrom(mission, source);
    const missionValidationSource = canonicalMission?.purpose && source.purpose !== canonicalMission.purpose
      ? { ...source, purpose: canonicalMission.purpose }
      : source;
    if (typeof options.validateMissionBinding === 'function'
        && !validatorCall(options.validateMissionBinding, missionValidationSource, {
          handoffId: state.handoffId,
          type: state.type,
          binding: missionValidationSource,
        })) {
      fail('MISSION_BINDING_INVALID', 'The mission binding is no longer current.');
    }
    if (mission && typeof mission.isBindingCurrent === 'function'
        && !validatorCall(
          mission.isBindingCurrent.bind(mission),
          missionValidationSource,
          state,
        )) {
      fail('MISSION_BINDING_INVALID', 'The mission binding is no longer current.');
    }
    const live = lifecycleBindingFrom(lifecycle, source.tabId, source.frameId);
    if (!liveEquivalent(source, live)) {
      fail('LIFECYCLE_BINDING_INVALID', 'The source page binding is no longer current.');
    }
    return source;
  }

  function surfaceFor(handoffId, supplied, source) {
    const remembered = surfaces.get(handoffId);
    if (!remembered) fail('HANDOFF_SURFACE_REQUIRED', 'The human handoff surface is not active.');
    const canonical = normalizeSurface(supplied, source);
    if (!sameValue(canonical, remembered)) fail('SURFACE_BINDING_MISMATCH', 'The handoff surface is not exact.');
    const live = lifecycleBindingFrom(lifecycle, canonical.tabId, canonical.frameId);
    if (!liveEquivalent(canonical, live, { surface: true })) {
      fail('LIFECYCLE_BINDING_INVALID', 'The human handoff surface is no longer current.');
    }
    if (isPlainObject(live.binding)) {
      const liveSurface = normalizeSurface({ ...live, binding: live.binding }, source);
      if (!sameValue(liveSurface, canonical)) fail('SURFACE_BINDING_MISMATCH', 'The human handoff surface is not exact.');
    }
    return canonical;
  }

  function proofAndIntent(input, state) {
    const uiIntent = validateUiIntentShape(extractUiIntent(input), state, 'complete');
    const completionProof = input.completionProof ?? input.completionBindingProof ?? input.proof;
    validateCompletionProofShape(completionProof, state);
    if (sameValue(uiIntent, completionProof)) fail('COMPLETION_PROOF_INVALID', 'Completion proof must be separate from the UI intent.');
    if (!validatorCall(options.validateUiIntent, uiIntent, intentFor(state, 'complete'))) {
      fail('UI_INTENT_INVALID', 'The UI intent is invalid or does not match this handoff.');
    }
    const expectedProof = {
      ...intentFor(state, 'complete'),
      fresh: true,
      completionBinding: clone(bindingFromState(state), 'completion binding'),
    };
    if (!validatorCall(options.validateCompletionProof, completionProof, expectedProof)) {
      fail('COMPLETION_PROOF_INVALID', 'A fresh canonical completion proof is required.');
    }
    return { uiIntent, completionProof };
  }

  const runtime = {
    async request(input = {}) {
      return enqueue(async () => {
        requiredObject(input, 'request');
        const source = sourceBinding(input, lifecycle, mission, options.validateMissionBinding);
        const brokerInput = {
          handoffId: input.handoffId ?? input.requestId ?? input.id,
          type: input.type ?? input.kind,
          ttlMs: input.ttlMs ?? input.ttl,
          ...source,
          safeOrigin: source.safeOrigin,
        };
        if (brokerInput.handoffId === undefined) delete brokerInput.handoffId;
        if (brokerInput.type === undefined) delete brokerInput.type;
        if (brokerInput.ttlMs === undefined) delete brokerInput.ttlMs;
        const created = broker.request(brokerInput);
        const awaiting = broker.awaitUiGesture({ handoffId: created.handoffId });
        sourceBindings.set(awaiting.handoffId, source);
        try {
          await persist();
        } catch (error) {
          sourceBindings.delete(awaiting.handoffId);
          throw error;
        }
        return clone(awaiting, 'handoff state');
      });
    },

    async open(input = {}) {
      return enqueue(async () => {
        requiredObject(input, 'open');
        const handoffId = input.handoffId ?? input.requestId ?? input.id;
        const state = currentState(handoffId);
        sourceFor(state.handoffId, state);
        const uiIntent = validateUiIntentShape(extractUiIntent(input), state, 'open');
        const opened = broker.open({ handoffId: state.handoffId, uiIntent });
        await persist();
        return clone(opened, 'handoff state');
      });
    },

    async commit(input = {}) {
      return enqueue(async () => {
        requiredObject(input, 'commit');
        const state = currentState(input.handoffId ?? input.requestId ?? input.id);
        const source = sourceFor(state.handoffId, state);
        const surface = normalizeSurface(input.surface, source);
        const live = lifecycleBindingFrom(lifecycle, surface.tabId, surface.frameId);
        if (!liveEquivalent(surface, live, { surface: true })) {
          fail('LIFECYCLE_BINDING_INVALID', 'The human handoff surface is no longer current.');
        }
        if (isPlainObject(live.binding)) {
          const liveSurface = normalizeSurface({ ...live, binding: live.binding }, source);
          if (!sameValue(liveSurface, surface)) fail('SURFACE_BINDING_MISMATCH', 'The handoff surface is not exact.');
        }
        const active = broker.humanActive({ handoffId: state.handoffId });
        surfaces.set(state.handoffId, surface);
        try {
          await persist();
        } catch (error) {
          surfaces.delete(state.handoffId);
          throw error;
        }
        return clone(active, 'handoff state');
      });
    },

    async captchaCheckboxAttempt(input = {}) {
      return enqueue(async () => {
        requiredObject(input, 'captchaAttempt');
        const state = currentState(input.handoffId ?? input.requestId ?? input.id);
        const source = sourceFor(state.handoffId, state);
        surfaceFor(state.handoffId, input.surface, source);
        const uiIntent = validateUiIntentShape(extractUiIntent(input), state, 'captcha-checkbox');
        const attempted = broker.captchaCheckboxAttempt({
          handoffId: state.handoffId,
          ...source,
          uiIntent,
        });
        await persist();
        return clone(attempted, 'handoff state');
      });
    },

    async return(input = {}) {
      return enqueue(async () => {
        requiredObject(input, 'return');
        const state = currentState(input.handoffId ?? input.requestId ?? input.id);
        const source = sourceFor(state.handoffId, state);
        surfaceFor(state.handoffId, input.surface, source);
        const { uiIntent, completionProof } = proofAndIntent(input, state);

        sourceFor(state.handoffId, currentState(state.handoffId));
        const returning = broker.returnRequested({ handoffId: state.handoffId });
        await persist();
        sourceFor(state.handoffId, currentState(state.handoffId));
        const validating = broker.validate({ handoffId: state.handoffId });
        await persist();
        sourceFor(state.handoffId, currentState(state.handoffId));
        surfaceFor(state.handoffId, input.surface, source);
        const completed = broker.complete({
          handoffId: state.handoffId,
          uiIntent,
          completionProof,
        });
        surfaces.delete(state.handoffId);
        await persist();
        void returning;
        void validating;
        return clone(completed, 'handoff state');
      });
    },

    state(handoffId) {
      return clone(currentState(handoffId), 'handoff state');
    },

    list() {
      ensureReady();
      try {
        return clone(broker.list(), 'handoff list');
      } catch (error) {
        throw safeError(error, 'HANDOFF_STATE_INVALID', 'The handoff state is unavailable.');
      }
    },

    has(handoffId) {
      ensureReady();
      return broker.has(handoffId);
    },
  };

  return Object.freeze(runtime);
}
