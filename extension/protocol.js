/**
 * ToolBraid Universal wire protocol.
 *
 * This module is intentionally dependency-free so the service worker and the
 * Node protocol tests can share the same validation rules. The page-world
 * scripts use the equivalent classic-script implementation in
 * `protocol-runtime.js` because Chrome's scripting API does not load ES module
 * imports for injected files.
 */

export const CHANNEL = 'toolbraid-universal';
export const PROTOCOL_VERSION = 1;
export const PROVENANCE = 'generated-by-toolbraid';
export const REQUEST_TIMEOUT_MS = 30_000;

export const MESSAGE_TYPES = Object.freeze({
  PAGE_READY: 'toolbraid:page-ready',
  CHANNEL_INIT: 'toolbraid:channel-init',
  CHANNEL_CLOSE: 'toolbraid:channel-close',
  MAIN_READY: 'toolbraid:main-ready',
  REGISTER_TOOLS: 'toolbraid:register-tools',
  REGISTER_RESULT: 'toolbraid:register-result',
  EXECUTE_REQUEST: 'toolbraid:execute-request',
  EXECUTE_RESULT: 'toolbraid:execute-result',
  EXECUTE_CANCEL: 'toolbraid:execute-cancel',
  PAGE_EVENT: 'toolbraid:page-event',
  PAGE_SNAPSHOT: 'toolbraid:page-snapshot',
  PAGE_EXTRACT_SNAPSHOT: 'toolbraid:extract-snapshot',
  PAGE_CAPTURE_RENDERED_MEDIA: 'toolbraid:capture-rendered-media',
  PAGE_CAPTURE_RENDERED_MEDIA_CANCEL: 'toolbraid:cancel-rendered-media-capture',
  PAGE_ACTION_EXECUTE: 'toolbraid:page-action-execute',
  BRIDGE_REGISTER_TOOLS: 'toolbraid:bridge-register-tools',
});

const MESSAGE_TYPE_SET = new Set(Object.values(MESSAGE_TYPES));
const TOOL_NAME = /^[A-Za-z0-9_.-]{1,128}$/;
const TOOL_ID = /^[A-Za-z0-9_.:-]{1,160}$/;

export class ProtocolError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ProtocolError';
    this.code = code;
    this.details = details;
  }
}

export function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isPlainRecord(value) {
  if (!isRecord(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function cloneStructured(value) {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function isJsonValue(value, depth = 0, seen = new Set()) {
  if (depth > 12) return false;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (!value || typeof value !== 'object') return false;
  if (seen.has(value)) return false;
  seen.add(value);
  const valid = Array.isArray(value)
    ? value.every((entry) => isJsonValue(entry, depth + 1, seen))
    : isPlainRecord(value)
      && Object.entries(value).every(([key, entry]) => !['__proto__', 'constructor', 'prototype'].includes(key)
        && isJsonValue(entry, depth + 1, seen));
  seen.delete(value);
  return valid;
}

function assertTabId(tabId) {
  if (!Number.isInteger(tabId) || tabId < 0) {
    throw new ProtocolError('TAB_ID_INVALID', 'A non-negative integer tab id is required.', { tabId });
  }
}

function assertFrameId(frameId) {
  if (!Number.isInteger(frameId) || frameId < 0) {
    throw new ProtocolError('FRAME_ID_INVALID', 'A non-negative integer frame id is required.', { frameId });
  }
}

function assertNonce(nonce) {
  if (typeof nonce !== 'string' || nonce.length < 16 || nonce.length > 256) {
    throw new ProtocolError('NONCE_INVALID', 'A cryptographically generated channel nonce is required.');
  }
}

function assertSessionId(sessionId) {
  if (typeof sessionId !== 'string' || !/^tab-[0-9]+-[A-Za-z0-9_-]{8,160}$/.test(sessionId)) {
    throw new ProtocolError('SESSION_INVALID', 'A canonical ToolBraid session id is required.', { sessionId });
  }
}

/**
 * Create a nonce without falling back to Math.random. A missing secure random
 * source is a hard failure because reusing or guessing a nonce breaks the
 * tab/document binding.
 */
export function createNonce(randomSource = globalThis.crypto) {
  if (randomSource && typeof randomSource.randomUUID === 'function') {
    return randomSource.randomUUID();
  }
  if (!randomSource || typeof randomSource.getRandomValues !== 'function') {
    throw new ProtocolError('SECURE_RANDOM_UNAVAILABLE', 'Secure randomness is unavailable for the ToolBraid channel.');
  }
  const bytes = new Uint8Array(32);
  randomSource.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function createRequestId(randomSource = globalThis.crypto) {
  return `req-${createNonce(randomSource)}`;
}

/**
 * Supports both `createEnvelope({ ... })` and the compact
 * `createEnvelope(type, payload, session)` form used by browser scripts.
 */
export function createEnvelope(typeOrOptions, payload = {}, session = {}) {
  const options = typeof typeOrOptions === 'string'
    ? { ...session, type: typeOrOptions, payload }
    : (typeOrOptions ?? {});
  const {
    type,
    nonce,
    sessionId,
    tabId,
    frameId = 0,
    requestId = null,
    payload: body = {},
  } = options;

  if (!MESSAGE_TYPE_SET.has(type)) {
    throw new ProtocolError('MESSAGE_TYPE_INVALID', `Unknown ToolBraid message type: ${String(type)}`);
  }
  assertNonce(nonce);
  assertSessionId(sessionId);
  assertTabId(tabId);
  assertFrameId(frameId);
  if (requestId !== null && (typeof requestId !== 'string' || requestId.length < 8 || requestId.length > 256)) {
    throw new ProtocolError('REQUEST_ID_INVALID', 'Request ids must be bounded strings.', { requestId });
  }
  if (!isPlainRecord(body) || !isJsonValue(body)) {
    throw new ProtocolError('PAYLOAD_INVALID', 'ToolBraid envelopes require a JSON object payload.');
  }

  return Object.freeze({
    channel: CHANNEL,
    version: PROTOCOL_VERSION,
    type,
    nonce,
    sessionId,
    tabId,
    frameId,
    requestId,
    payload: cloneStructured(body),
  });
}

function invalid(code, message, details = {}) {
  return { ok: false, error: { code, message, details } };
}

/**
 * Parse and bind a message. This never throws: callers handling untrusted
 * window/runtime messages can drop the result when `ok` is false.
 */
export function parseEnvelope(value, expected = {}) {
  try {
    if (!isPlainRecord(value)) return invalid('MESSAGE_INVALID', 'ToolBraid message must be a plain object.');
    if (value.channel !== CHANNEL) return invalid('CHANNEL_INVALID', 'ToolBraid channel marker did not match.');
    if (value.version !== PROTOCOL_VERSION) return invalid('VERSION_UNSUPPORTED', 'ToolBraid protocol version did not match.');
    if (!MESSAGE_TYPE_SET.has(value.type)) return invalid('MESSAGE_TYPE_INVALID', 'ToolBraid message type is not recognized.');

    assertNonce(value.nonce);
    assertSessionId(value.sessionId);
    assertTabId(value.tabId);
    assertFrameId(value.frameId);
  if (value.requestId !== null && value.requestId !== undefined
      && (typeof value.requestId !== 'string' || value.requestId.length < 8 || value.requestId.length > 256)) {
    return invalid('REQUEST_ID_INVALID', 'Request ids must be bounded strings.');
  }
  if (!isPlainRecord(value.payload) || !isJsonValue(value.payload)) {
    return invalid('PAYLOAD_INVALID', 'ToolBraid envelopes require a JSON object payload.');
  }

  for (const key of ['nonce', 'sessionId', 'tabId', 'frameId']) {
    if (expected[key] !== undefined && value[key] !== expected[key]) {
      return invalid('BINDING_MISMATCH', `ToolBraid ${key} did not match the active session.`, {
        expected: expected[key],
        received: value[key],
      });
    }
  }
  if (expected.type !== undefined && value.type !== expected.type) {
    return invalid('MESSAGE_TYPE_UNEXPECTED', `Expected ${expected.type}, received ${value.type}.`);
  }
  return { ok: true, value };
  } catch {
    return invalid('MESSAGE_INVALID', 'ToolBraid message could not be parsed safely.');
  }
}

export function assertEnvelope(value, expected = {}) {
  const parsed = parseEnvelope(value, expected);
  if (!parsed.ok) throw new ProtocolError(parsed.error.code, parsed.error.message, parsed.error.details);
  return parsed.value;
}

export function normalizeGeneratedToolDescription(raw, { index = 0 } = {}) {
  if (!isPlainRecord(raw)) {
    throw new ProtocolError('TOOL_DESCRIPTION_INVALID', `Generated tool ${index} must be a plain object.`);
  }
  if ('execute' in raw || 'handler' in raw || 'callback' in raw) {
    throw new ProtocolError('TOOL_DESCRIPTION_EXECUTABLE', 'Executable functions cannot cross the ToolBraid channel.');
  }
  const name = raw.name;
  if (typeof name !== 'string' || !TOOL_NAME.test(name)) {
    throw new ProtocolError('TOOL_NAME_INVALID', `Generated tool ${index} has an invalid name.`, { name });
  }
  const id = raw.id ?? name;
  if (typeof id !== 'string' || !TOOL_ID.test(id)) {
    throw new ProtocolError('TOOL_ID_INVALID', `Generated tool ${name} has an invalid id.`, { id });
  }
  if (typeof raw.description !== 'string' || raw.description.length < 1 || raw.description.length > 4096) {
    throw new ProtocolError('TOOL_DESCRIPTION_INVALID', `Generated tool ${name} requires a bounded description.`);
  }
  if (raw.title !== undefined && (typeof raw.title !== 'string' || raw.title.length > 512)) {
    throw new ProtocolError('TOOL_TITLE_INVALID', `Generated tool ${name} has an invalid title.`);
  }
  const inputSchema = raw.inputSchema ?? { type: 'object', properties: {} };
  if (!isPlainRecord(inputSchema) || !isJsonValue(inputSchema)) {
    throw new ProtocolError('TOOL_SCHEMA_INVALID', `Generated tool ${name} has a non-JSON input schema.`);
  }
  let sourceProvenance;
  if (raw.provenance !== undefined && raw.provenance !== PROVENANCE) {
    if (!isPlainRecord(raw.provenance) || !isJsonValue(raw.provenance)) {
      throw new ProtocolError('TOOL_PROVENANCE_INVALID', `Generated tool ${name} has an invalid provenance marker.`);
    }
    sourceProvenance = cloneStructured(raw.provenance);
  }
  const annotations = raw.annotations ?? {};
  if (!isPlainRecord(annotations) || !isJsonValue(annotations)) {
    throw new ProtocolError('TOOL_ANNOTATIONS_INVALID', `Generated tool ${name} has invalid annotations.`);
  }

  const normalized = {
    id,
    name,
    ...(raw.title === undefined ? {} : { title: raw.title }),
    description: raw.description,
    inputSchema: cloneStructured(inputSchema),
    annotations: cloneStructured({ ...annotations, provenance: PROVENANCE }),
    provenance: PROVENANCE,
    ...(sourceProvenance === undefined ? {} : { sourceProvenance }),
  };
  return Object.freeze(normalized);
}

export function normalizeGeneratedToolDescriptions(tools) {
  if (!Array.isArray(tools) || tools.length > 128) {
    throw new ProtocolError('TOOLS_INVALID', 'A bounded array of generated tool descriptions is required.');
  }
  const normalized = tools.map((tool, index) => normalizeGeneratedToolDescription(tool, { index }));
  const ids = new Set();
  const names = new Set();
  for (const tool of normalized) {
    if (ids.has(tool.id)) throw new ProtocolError('TOOL_DUPLICATE', `Duplicate generated tool id: ${tool.id}`);
    if (names.has(tool.name)) throw new ProtocolError('TOOL_DUPLICATE', `Duplicate generated tool name: ${tool.name}`);
    ids.add(tool.id);
    names.add(tool.name);
  }
  return Object.freeze(normalized);
}

export function isInjectableUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

export function errorPayload(error, fallbackCode = 'TOOLBRAID_ERROR') {
  return {
    ok: false,
    error: {
      code: error?.code ?? fallbackCode,
      message: typeof error?.message === 'string' ? error.message : 'ToolBraid operation failed.',
    },
    provenance: PROVENANCE,
  };
}
