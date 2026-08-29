/* global crypto */

// Classic-script protocol helpers shared by the isolated and MAIN worlds.
// This file is injected before content-script.js and injector-main.js because
// Chrome does not resolve ES module imports for scripting.executeScript files.
(function installToolBraidProtocol(global) {
  if (global.ToolBraidUniversalProtocol) return;

  const CHANNEL = 'toolbraid-universal';
  const VERSION = 1;
  const PROVENANCE = 'generated-by-toolbraid';
  const REQUEST_TIMEOUT_MS = 30000;
  const TYPES = Object.freeze({
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
  const TYPES_SET = new Set(Object.values(TYPES));
  const TOOL_NAME = /^[A-Za-z0-9_.-]{1,128}$/;
  const TOOL_ID = /^[A-Za-z0-9_.:-]{1,160}$/;

  function record(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  function plain(value) {
    if (!record(value)) return false;
    try {
      const prototype = Object.getPrototypeOf(value);
      return prototype === Object.prototype || prototype === null;
    } catch {
      return false;
    }
  }

  function jsonValue(value, depth, seen) {
    if (depth > 12) return false;
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
    if (typeof value === 'number') return Number.isFinite(value);
    if (!value || typeof value !== 'object') return false;
    if (seen.has(value)) return false;
    seen.add(value);
    const valid = Array.isArray(value)
      ? value.every((entry) => jsonValue(entry, depth + 1, seen))
      : plain(value) && Object.entries(value).every(([key, entry]) => !['__proto__', 'constructor', 'prototype'].includes(key)
        && jsonValue(entry, depth + 1, seen));
    seen.delete(value);
    return valid;
  }

  function copy(value) {
    if (typeof global.structuredClone === 'function') return global.structuredClone(value);
    return JSON.parse(JSON.stringify(value));
  }

  function nonce() {
    if (global.crypto && typeof global.crypto.randomUUID === 'function') return global.crypto.randomUUID();
    if (!global.crypto || typeof global.crypto.getRandomValues !== 'function') return null;
    const bytes = new Uint8Array(32);
    global.crypto.getRandomValues(bytes);
    return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  }

  function requestId() {
    const value = nonce();
    return value ? `req-${value}` : null;
  }

  function createEnvelope(type, payload, binding, id = null) {
    if (!TYPES_SET.has(type) || !binding || typeof binding.nonce !== 'string' || typeof binding.sessionId !== 'string') return null;
    if (!Number.isInteger(binding.tabId) || binding.tabId < 0 || !Number.isInteger(binding.frameId) || binding.frameId < 0) return null;
    if (!plain(payload) || !jsonValue(payload, 0, new Set())) return null;
    return Object.freeze({
      channel: CHANNEL,
      version: VERSION,
      type,
      nonce: binding.nonce,
      sessionId: binding.sessionId,
      tabId: binding.tabId,
      frameId: binding.frameId,
      requestId: id,
      payload: copy(payload),
    });
  }

  function parseEnvelope(value, expected = {}) {
    try {
      if (!plain(value)) return { ok: false, error: { code: 'MESSAGE_INVALID', message: 'ToolBraid message must be a plain object.' } };
      if (value.channel !== CHANNEL) return { ok: false, error: { code: 'CHANNEL_INVALID', message: 'ToolBraid channel marker did not match.' } };
      if (value.version !== VERSION) return { ok: false, error: { code: 'VERSION_UNSUPPORTED', message: 'ToolBraid protocol version did not match.' } };
      if (!TYPES_SET.has(value.type)) return { ok: false, error: { code: 'MESSAGE_TYPE_INVALID', message: 'ToolBraid message type is not recognized.' } };
      if (typeof value.nonce !== 'string' || value.nonce.length < 16 || value.nonce.length > 256) return { ok: false, error: { code: 'NONCE_INVALID', message: 'ToolBraid channel nonce is invalid.' } };
      if (typeof value.sessionId !== 'string' || !/^tab-[0-9]+-[A-Za-z0-9_-]{8,160}$/.test(value.sessionId)) return { ok: false, error: { code: 'SESSION_INVALID', message: 'ToolBraid session id is invalid.' } };
      if (!Number.isInteger(value.tabId) || value.tabId < 0 || !Number.isInteger(value.frameId) || value.frameId < 0) return { ok: false, error: { code: 'BINDING_INVALID', message: 'ToolBraid tab/frame binding is invalid.' } };
      if (value.requestId !== null && value.requestId !== undefined && (typeof value.requestId !== 'string' || value.requestId.length < 8 || value.requestId.length > 256)) return { ok: false, error: { code: 'REQUEST_ID_INVALID', message: 'ToolBraid request id is invalid.' } };
      if (!plain(value.payload) || !jsonValue(value.payload, 0, new Set())) return { ok: false, error: { code: 'PAYLOAD_INVALID', message: 'ToolBraid payload is invalid.' } };
      for (const key of ['nonce', 'sessionId', 'tabId', 'frameId']) {
        if (expected[key] !== undefined && value[key] !== expected[key]) return { ok: false, error: { code: 'BINDING_MISMATCH', message: `ToolBraid ${key} did not match the active session.` } };
      }
      if (expected.type !== undefined && value.type !== expected.type) return { ok: false, error: { code: 'MESSAGE_TYPE_UNEXPECTED', message: `Expected ${expected.type}, received ${value.type}.` } };
      return { ok: true, value };
    } catch {
      return { ok: false, error: { code: 'MESSAGE_INVALID', message: 'ToolBraid message could not be parsed safely.' } };
    }
  }

  function normalizeTool(raw, index) {
    if (!plain(raw) || 'execute' in raw || 'handler' in raw || 'callback' in raw) return null;
    if (typeof raw.name !== 'string' || !TOOL_NAME.test(raw.name)) return null;
    const id = raw.id ?? raw.name;
    if (typeof id !== 'string' || !TOOL_ID.test(id)) return null;
    if (typeof raw.description !== 'string' || raw.description.length < 1 || raw.description.length > 4096) return null;
    if (raw.title !== undefined && (typeof raw.title !== 'string' || raw.title.length > 512)) return null;
    const schema = raw.inputSchema ?? { type: 'object', properties: {} };
    if (!plain(schema) || !jsonValue(schema, 0, new Set())) return null;
    let sourceProvenance;
    if (raw.provenance !== undefined && raw.provenance !== PROVENANCE) {
      if (!plain(raw.provenance) || !jsonValue(raw.provenance, 0, new Set())) return null;
      sourceProvenance = copy(raw.provenance);
    }
    const annotations = raw.annotations ?? {};
    if (!plain(annotations) || !jsonValue(annotations, 0, new Set())) return null;
    return Object.freeze({
      id,
      name: raw.name,
      ...(raw.title === undefined ? {} : { title: raw.title }),
      description: raw.description,
      inputSchema: copy(schema),
      annotations: copy({ ...annotations, provenance: PROVENANCE }),
      provenance: PROVENANCE,
      ...(sourceProvenance === undefined ? {} : { sourceProvenance }),
      index,
    });
  }

  global.ToolBraidUniversalProtocol = Object.freeze({
    CHANNEL,
    VERSION,
    PROVENANCE,
    REQUEST_TIMEOUT_MS,
    TYPES,
    isRecord: record,
    createNonce: nonce,
    createRequestId: requestId,
    createEnvelope,
    parseEnvelope,
    normalizeTool,
    clone: copy,
  });
}(globalThis));
