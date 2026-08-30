import { sha256Hex } from './approval-store.js';

export const NATIVE_MCP_HOST = 'com.toolbraid.mcp_bridge';
export const NATIVE_MCP_PROTOCOL = 'toolbraid.native-mcp';
export const NATIVE_MCP_VERSION = 1;

const MAX_TOOLS = 32;
const MAX_MESSAGE_BYTES = 256 * 1024;
const MAX_TOOL_DESCRIPTION = 1_200;
const SAFE_REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SAFE_METHODS = new Set(['bridge.status', 'tools.list', 'tools.call']);

export class NativeMcpBridgeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'NativeMcpBridgeError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new NativeMcpBridgeError(code, message);
}

function plainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function byteLength(value) {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function boundedText(value, fallback = '', max = 512) {
  if (typeof value !== 'string') return fallback;
  const normalized = value.normalize('NFKC').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return normalized ? normalized.slice(0, max) : fallback;
}

function exactOrigin(value) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)
      || url.username || url.password || url.origin !== value) return null;
    return url.origin;
  } catch {
    return null;
  }
}

function safeSchema(value) {
  if (!plainObject(value) || value.type !== 'object' || byteLength(value) > 32 * 1024) {
    return Object.freeze({ type: 'object', additionalProperties: false });
  }
  return Object.freeze(clone(value));
}

function currentBinding(state) {
  const tabId = state?.tab?.id;
  const windowId = state?.tab?.windowId;
  const sessionId = state?.sessionId;
  const origin = exactOrigin(state?.tab?.origin);
  const pageFingerprint = state?.snapshot?.pageFingerprint;
  if (!Number.isInteger(tabId) || tabId < 0
    || !Number.isInteger(windowId) || windowId < 0
    || typeof sessionId !== 'string' || sessionId.length < 8
    || !origin
    || typeof pageFingerprint !== 'string' || pageFingerprint.length < 8) {
    fail('MCP_CONTEXT_INVALID', 'The active ToolBraid page binding is incomplete.');
  }
  return Object.freeze({ tabId, windowId, frameId: 0, sessionId, origin, pageFingerprint });
}

function sameBinding(left, right) {
  return left?.tabId === right?.tabId
    && left?.windowId === right?.windowId
    && left?.frameId === right?.frameId
    && left?.sessionId === right?.sessionId
    && left?.origin === right?.origin
    && left?.pageFingerprint === right?.pageFingerprint;
}

function publicContext(state) {
  return Object.freeze({
    connected: true,
    page: Object.freeze({
      tabId: state.tab.id,
      windowId: state.tab.windowId,
      url: boundedText(state.tab.url, '', 2_048),
      origin: exactOrigin(state.tab.origin),
      title: boundedText(state.tab.title, '', 512),
      pageFingerprint: boundedText(state.snapshot?.pageFingerprint, '', 128),
    }),
    toolCount: Array.isArray(state.tools) ? state.tools.length : 0,
    pendingActionCount: Array.isArray(state.pendingActions) ? state.pendingActions.length : 0,
    receiptCount: Array.isArray(state.receipts) ? state.receipts.length : 0,
    missionCount: Array.isArray(state.missions) ? state.missions.length : 0,
    humanStepCount: Array.isArray(state.handoffs) ? state.handoffs.length : 0,
  });
}

async function proxyName(tool, binding) {
  const original = boundedText(tool?.name, 'page_tool', 128);
  const readable = original.replace(/[^A-Za-z0-9_.-]/g, '_').replace(/^[^A-Za-z0-9]+/, '').slice(0, 72) || 'page_tool';
  const digest = await sha256Hex({
    tabId: binding.tabId,
    windowId: binding.windowId,
    sessionId: binding.sessionId,
    origin: binding.origin,
    pageFingerprint: binding.pageFingerprint,
    name: original,
  });
  return `toolbraid.${readable}.${digest.slice(0, 16)}`.slice(0, 128);
}

async function toolFingerprint(tool) {
  return sha256Hex({
    name: tool?.name ?? null,
    title: tool?.title ?? null,
    description: tool?.description ?? null,
    classification: tool?.classification ?? null,
    requiresApproval: tool?.requiresApproval ?? null,
    inputSchema: tool?.inputSchema ?? null,
    effect: tool?.effect ?? null,
    provenance: tool?.provenance ?? null,
  });
}

function mcpDescriptor(name, tool, binding) {
  const classification = tool.classification === 'read' ? 'read' : (tool.classification === 'stage' ? 'stage' : 'mutation');
  const approval = classification === 'mutation'
    ? ' This call only prepares the exact action; a human must approve and dispatch it in the ToolBraid side panel.'
    : (classification === 'stage' ? ' This applies only a reversible local page stage and does not dispatch an external action.' : '');
  const source = boundedText(tool.sourceType ?? tool.provenance, 'ToolBraid', 96);
  return Object.freeze({
    name,
    title: boundedText(tool.title, tool.name, 256),
    description: `${boundedText(tool.description, tool.title ?? tool.name, MAX_TOOL_DESCRIPTION - approval.length - 96)}${approval} Source: ${source}; active origin: ${binding.origin}.`.slice(0, MAX_TOOL_DESCRIPTION),
    inputSchema: safeSchema(tool.inputSchema),
    annotations: Object.freeze({
      readOnlyHint: classification === 'read',
      destructiveHint: false,
      idempotentHint: classification === 'read',
      openWorldHint: classification !== 'stage',
    }),
    _meta: Object.freeze({
      'toolbraid/originalName': boundedText(tool.name, '', 128),
      'toolbraid/classification': classification,
      'toolbraid/requiresApproval': classification === 'mutation',
      'toolbraid/origin': binding.origin,
      'toolbraid/pageFingerprint': binding.pageFingerprint,
    }),
  });
}

function requireOk(response) {
  if (response?.ok === true) return response;
  fail(
    boundedText(response?.error?.code, 'MCP_EXTENSION_REJECTED', 64),
    boundedText(response?.error?.message, 'ToolBraid rejected the MCP request.', 320),
  );
}

export function createExtensionMcpEndpoint({
  getState,
  executeRead,
  prepareAction,
} = {}) {
  if (typeof getState !== 'function' || typeof executeRead !== 'function' || typeof prepareAction !== 'function') {
    throw new TypeError('getState, executeRead, and prepareAction are required.');
  }

  const handles = new Map();
  const changeListeners = new Set();

  async function stateFor(target = {}) {
    const response = requireOk(await getState(target));
    if (!plainObject(response.state)) fail('MCP_STATE_INVALID', 'ToolBraid returned an invalid public state.');
    return response.state;
  }

  async function listTools() {
    const state = await stateFor();
    const binding = currentBinding(state);
    const tools = Array.isArray(state.tools) ? state.tools.slice(0, MAX_TOOLS) : [];
    const nextHandles = new Map();
    const descriptors = [];
    for (const tool of tools) {
      if (!plainObject(tool) || typeof tool.name !== 'string') continue;
      const name = await proxyName(tool, binding);
      if (nextHandles.has(name)) fail('MCP_TOOL_NAME_COLLISION', 'Two active page tools produced the same MCP name.');
      const fingerprint = await toolFingerprint(tool);
      nextHandles.set(name, Object.freeze({
        name,
        toolName: tool.name,
        classification: tool.classification,
        binding,
        fingerprint,
      }));
      descriptors.push(mcpDescriptor(name, tool, binding));
    }
    handles.clear();
    for (const [name, handle] of nextHandles) handles.set(name, handle);
    return Object.freeze({ tools: Object.freeze(descriptors), context: publicContext(state) });
  }

  async function callTool(params) {
    if (!plainObject(params)
      || typeof params.name !== 'string'
      || !plainObject(params.arguments ?? {})) {
      fail('MCP_TOOL_CALL_INVALID', 'An exact MCP tool name and object arguments are required.');
    }
    const handle = handles.get(params.name);
    if (!handle) fail('MCP_TOOL_HANDLE_STALE', 'Refresh ToolBraid tools before calling this page tool.');
    const target = { targetTabId: handle.binding.tabId, targetWindowId: handle.binding.windowId };
    const state = await stateFor();
    const binding = currentBinding(state);
    if (!sameBinding(handle.binding, binding)) {
      handles.delete(params.name);
      fail('MCP_PAGE_BINDING_DRIFT', 'The active ToolBraid page changed after this MCP tool was listed.');
    }
    const tool = state.tools.find((candidate) => candidate?.name === handle.toolName);
    if (!tool || await toolFingerprint(tool) !== handle.fingerprint) {
      handles.delete(params.name);
      fail('MCP_TOOL_DESCRIPTOR_DRIFT', 'The live ToolBraid descriptor changed after this MCP tool was listed.');
    }
    const payload = {
      ...target,
      ...(tool.classification === 'read' ? { toolId: tool.name } : { actionId: tool.name }),
      arguments: clone(params.arguments ?? {}),
    };
    const response = tool.classification === 'read'
      ? await executeRead(payload)
      : await prepareAction(payload);
    return requireOk(response);
  }

  async function handle(method, params = {}) {
    if (!SAFE_METHODS.has(method)) fail('MCP_METHOD_UNSUPPORTED', 'The native bridge method is not allowed.');
    if (!plainObject(params) || byteLength(params) > MAX_MESSAGE_BYTES) {
      fail('MCP_PARAMS_INVALID', 'The native bridge parameters are invalid or too large.');
    }
    if (method === 'bridge.status') return publicContext(await stateFor());
    if (method === 'tools.list') return listTools();
    return callTool(params);
  }

  function invalidate() {
    const changed = handles.size > 0;
    handles.clear();
    if (changed) for (const listener of changeListeners) listener();
  }

  function onToolsChanged(listener) {
    if (typeof listener !== 'function') throw new TypeError('listener must be a function.');
    changeListeners.add(listener);
    return () => changeListeners.delete(listener);
  }

  return Object.freeze({ handle, listTools, invalidate, onToolsChanged, handleCount: () => handles.size });
}

function nativeRequest(message) {
  return plainObject(message)
    && message.protocol === NATIVE_MCP_PROTOCOL
    && message.version === NATIVE_MCP_VERSION
    && message.kind === 'request'
    && typeof message.requestId === 'string'
    && SAFE_REQUEST_ID.test(message.requestId)
    && SAFE_METHODS.has(message.method)
    && plainObject(message.params ?? {})
    && byteLength(message) <= MAX_MESSAGE_BYTES;
}

function nativeError(error) {
  return Object.freeze({
    code: boundedText(error?.code, 'MCP_EXTENSION_FAILED', 64),
    message: boundedText(error?.message, 'ToolBraid rejected the native MCP request.', 320),
  });
}

export function installNativeMcpBridge({
  chromeApi = globalThis.chrome,
  endpoint,
  hostName = NATIVE_MCP_HOST,
  reconnectDelayMs = 5_000,
  schedule = globalThis.setTimeout?.bind(globalThis),
} = {}) {
  if (!endpoint || typeof endpoint.handle !== 'function') throw new TypeError('endpoint is required.');
  let port = null;
  let stopped = false;
  let reconnectTimer = null;
  let connected = false;

  function post(message) {
    if (!port) return false;
    try {
      port.postMessage(message);
      return true;
    } catch {
      return false;
    }
  }

  function toolsChanged() {
    post({
      protocol: NATIVE_MCP_PROTOCOL,
      version: NATIVE_MCP_VERSION,
      kind: 'event',
      event: 'tools_changed',
    });
  }
  const unsubscribe = endpoint.onToolsChanged(toolsChanged);

  function scheduleReconnect() {
    if (stopped || reconnectTimer || typeof schedule !== 'function') return;
    reconnectTimer = schedule(() => {
      reconnectTimer = null;
      connect();
    }, reconnectDelayMs);
  }

  function connect() {
    if (stopped || port || typeof chromeApi?.runtime?.connectNative !== 'function') return false;
    try {
      const candidate = chromeApi.runtime.connectNative(hostName);
      if (!candidate?.onMessage?.addListener || !candidate?.onDisconnect?.addListener) return false;
      port = candidate;
      connected = true;
      candidate.onMessage.addListener((message) => {
        if (!nativeRequest(message)) return;
        Promise.resolve(endpoint.handle(message.method, message.params ?? {}))
          .then((result) => post({
            protocol: NATIVE_MCP_PROTOCOL,
            version: NATIVE_MCP_VERSION,
            kind: 'response',
            requestId: message.requestId,
            ok: true,
            result,
          }))
          .catch((error) => post({
            protocol: NATIVE_MCP_PROTOCOL,
            version: NATIVE_MCP_VERSION,
            kind: 'response',
            requestId: message.requestId,
            ok: false,
            error: nativeError(error),
          }));
      });
      candidate.onDisconnect.addListener(() => {
        if (port !== candidate) return;
        port = null;
        connected = false;
        scheduleReconnect();
      });
      post({
        protocol: NATIVE_MCP_PROTOCOL,
        version: NATIVE_MCP_VERSION,
        kind: 'event',
        event: 'extension_ready',
      });
      return true;
    } catch {
      port = null;
      connected = false;
      scheduleReconnect();
      return false;
    }
  }

  function stop() {
    stopped = true;
    unsubscribe();
    if (reconnectTimer && typeof globalThis.clearTimeout === 'function') globalThis.clearTimeout(reconnectTimer);
    reconnectTimer = null;
    try { port?.disconnect?.(); } catch { /* already disconnected */ }
    port = null;
    connected = false;
  }

  connect();
  return Object.freeze({ connect, stop, state: () => Object.freeze({ connected, hostName }) });
}
