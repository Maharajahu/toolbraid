import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

import {
  BRIDGE_PROTOCOL,
  BRIDGE_PROTOCOL_VERSION,
  JsonLineDecoder,
  LocalBridgeError,
  configPathFromArgs,
  loadBridgeConfig,
  plainObject,
  safeError,
  writeJsonLine,
} from './common.mjs';

const SERVER_NAME = 'toolbraid';
const SERVER_VERSION = '0.1.0';
const SUPPORTED_PROTOCOLS = new Set(['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25']);
const DEFAULT_PROTOCOL = '2025-11-25';
const MAX_MCP_LINE_BYTES = 2 * 1024 * 1024;
const SAFE_TOOL_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

function statusTool() {
  return Object.freeze({
    name: 'toolbraid_status',
    title: 'ToolBraid bridge status',
    description: 'Read the secure local ToolBraid bridge status and the currently bound Chrome page. This never changes browser or external state.',
    inputSchema: Object.freeze({ type: 'object', additionalProperties: false }),
    annotations: Object.freeze({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }),
  });
}

function validTool(tool) {
  return plainObject(tool)
    && typeof tool.name === 'string' && SAFE_TOOL_NAME.test(tool.name)
    && typeof tool.description === 'string' && tool.description.length <= 1_200
    && plainObject(tool.inputSchema) && tool.inputSchema.type === 'object';
}

function resultContent(value, isError = false) {
  const structuredContent = plainObject(value) ? value : { result: value ?? null };
  let text;
  try { text = JSON.stringify(structuredContent); } catch { text = '{"error":"Result could not be serialized."}'; }
  if (Buffer.byteLength(text, 'utf8') > 512 * 1024) {
    text = JSON.stringify({ error: 'ToolBraid result exceeded the MCP response limit.' });
    return { content: [{ type: 'text', text }], structuredContent: JSON.parse(text), isError: true };
  }
  return { content: [{ type: 'text', text }], structuredContent, isError };
}

export class BridgeClient {
  #config;
  #socket = null;
  #decoder = null;
  #authenticated = false;
  #connecting = null;
  #pending = new Map();
  #listeners = new Set();
  #timeoutMs;

  constructor(config, { timeoutMs = 30_000 } = {}) {
    this.#config = config;
    this.#timeoutMs = timeoutMs;
  }

  onEvent(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #close(error = new LocalBridgeError('BRIDGE_DISCONNECTED', 'The ToolBraid native bridge disconnected.')) {
    const socket = this.#socket;
    this.#socket = null;
    this.#decoder = null;
    this.#authenticated = false;
    this.#connecting = null;
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
    try { socket?.destroy(); } catch { /* already closed */ }
  }

  #onMessage(message, authResolve, authReject) {
    if (message.protocol !== BRIDGE_PROTOCOL || message.version !== BRIDGE_PROTOCOL_VERSION) return;
    if (!this.#authenticated && message.kind === 'auth') {
      if (message.ok === true) {
        this.#authenticated = true;
        authResolve();
      } else authReject(new LocalBridgeError('BRIDGE_AUTH_REJECTED', 'The ToolBraid native bridge rejected authentication.'));
      return;
    }
    if (message.kind === 'event') {
      for (const listener of this.#listeners) listener(message.event);
      return;
    }
    if (message.kind !== 'response' || typeof message.requestId !== 'string') return;
    const pending = this.#pending.get(message.requestId);
    if (!pending) return;
    this.#pending.delete(message.requestId);
    clearTimeout(pending.timer);
    if (message.ok === true) pending.resolve(message.result);
    else {
      const error = safeError(message.error, 'BRIDGE_REQUEST_FAILED', 'The ToolBraid bridge request failed.');
      pending.reject(new LocalBridgeError(error.code, error.message));
    }
  }

  async connect() {
    if (this.#socket && this.#authenticated) return;
    if (this.#connecting) return this.#connecting;
    this.#connecting = new Promise((resolve, reject) => {
      const socket = net.createConnection(this.#config.pipe);
      this.#socket = socket;
      let settled = false;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        callback(value);
      };
      const timer = setTimeout(() => {
        finish(reject, new LocalBridgeError('BRIDGE_CONNECT_TIMEOUT', 'Timed out connecting to the ToolBraid native bridge.'));
        this.#close();
      }, Math.min(this.#timeoutMs, 5_000));
      const authResolve = () => {
        clearTimeout(timer);
        finish(resolve);
      };
      const authReject = (error) => {
        clearTimeout(timer);
        finish(reject, error);
        this.#close(error);
      };
      this.#decoder = new JsonLineDecoder({
        onMessage: (message) => this.#onMessage(message, authResolve, authReject),
        onError: authReject,
      });
      socket.on('connect', () => writeJsonLine(socket, {
        protocol: BRIDGE_PROTOCOL,
        version: BRIDGE_PROTOCOL_VERSION,
        kind: 'auth',
        token: this.#config.token,
      }));
      socket.on('data', (chunk) => this.#decoder?.push(chunk));
      socket.on('error', authReject);
      socket.on('close', () => this.#close());
    }).finally(() => { this.#connecting = null; });
    return this.#connecting;
  }

  async request(method, params = {}) {
    await this.connect();
    if (!this.#socket || !this.#authenticated) throw new LocalBridgeError('BRIDGE_DISCONNECTED', 'The ToolBraid native bridge is unavailable.');
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(requestId);
        reject(new LocalBridgeError('BRIDGE_REQUEST_TIMEOUT', 'The ToolBraid bridge request timed out.'));
      }, this.#timeoutMs);
      this.#pending.set(requestId, { resolve, reject, timer });
      try {
        writeJsonLine(this.#socket, {
          protocol: BRIDGE_PROTOCOL,
          version: BRIDGE_PROTOCOL_VERSION,
          kind: 'request',
          requestId,
          method,
          params,
        });
      } catch (error) {
        clearTimeout(timer);
        this.#pending.delete(requestId);
        reject(error);
      }
    });
  }

  close() {
    this.#close();
  }
}

export class ToolBraidMcpServer {
  #bridge;
  #output;
  #initialized = false;
  #listedTools = new Map();
  #unsubscribe;

  constructor({ bridge, output = process.stdout } = {}) {
    if (!bridge || typeof bridge.request !== 'function') throw new TypeError('bridge is required.');
    this.#bridge = bridge;
    this.#output = output;
    this.#unsubscribe = bridge.onEvent?.((event) => {
      if (event !== 'tools_changed' && event !== 'extension_ready') return;
      this.#listedTools.clear();
      if (this.#initialized) this.#send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
    });
  }

  #send(message) {
    writeJsonLine(this.#output, message);
  }

  async #listTools() {
    const tools = [statusTool()];
    try {
      const result = await this.#bridge.request('tools.list', {});
      for (const tool of Array.isArray(result?.tools) ? result.tools : []) {
        if (tools.length >= 33 || !validTool(tool) || tools.some((entry) => entry.name === tool.name)) continue;
        tools.push(tool);
      }
    } catch { /* status remains callable while Chrome is disconnected */ }
    this.#listedTools = new Map(tools.map((tool) => [tool.name, tool]));
    return tools;
  }

  async #callTool(params) {
    const name = params?.name;
    const args = params?.arguments ?? {};
    if (typeof name !== 'string' || !plainObject(args)) {
      return resultContent({ code: 'MCP_TOOL_CALL_INVALID', message: 'A tool name and object arguments are required.' }, true);
    }
    if (name === 'toolbraid_status') {
      try {
        return resultContent(await this.#bridge.request('bridge.status', {}));
      } catch (error) {
        return resultContent({ connected: false, error: safeError(error) });
      }
    }
    if (!this.#listedTools.has(name)) {
      return resultContent({ code: 'MCP_TOOL_NOT_LISTED', message: 'Refresh the ToolBraid tool list before calling this page tool.' }, true);
    }
    try {
      return resultContent(await this.#bridge.request('tools.call', { name, arguments: args }));
    } catch (error) {
      return resultContent(safeError(error), true);
    }
  }

  async handle(message) {
    if (!plainObject(message) || message.jsonrpc !== '2.0') {
      this.#send({ jsonrpc: '2.0', id: message?.id ?? null, error: { code: -32600, message: 'Invalid Request' } });
      return;
    }
    if (message.method === 'notifications/initialized') {
      this.#initialized = true;
      return;
    }
    if (message.method === 'notifications/cancelled') return;
    if (!Object.prototype.hasOwnProperty.call(message, 'id')) return;
    try {
      if (message.method === 'initialize') {
        const requested = message.params?.protocolVersion;
        const protocolVersion = SUPPORTED_PROTOCOLS.has(requested) ? requested : DEFAULT_PROTOCOL;
        this.#send({
          jsonrpc: '2.0',
          id: message.id,
          result: {
            protocolVersion,
            capabilities: { tools: { listChanged: true } },
            serverInfo: {
              name: SERVER_NAME,
              title: 'ToolBraid Chrome Bridge',
              version: SERVER_VERSION,
              description: 'Secure local access to the exact ToolBraid tools active in Chrome.',
            },
            instructions: 'Read tools may run directly. Mutation tools only prepare a bound action; approval and dispatch remain human-owned in the ToolBraid Chrome side panel.',
          },
        });
        return;
      }
      if (!this.#initialized) {
        this.#send({ jsonrpc: '2.0', id: message.id, error: { code: -32002, message: 'Server not initialized' } });
        return;
      }
      if (message.method === 'ping') {
        this.#send({ jsonrpc: '2.0', id: message.id, result: {} });
        return;
      }
      if (message.method === 'tools/list') {
        this.#send({ jsonrpc: '2.0', id: message.id, result: { tools: await this.#listTools() } });
        return;
      }
      if (message.method === 'tools/call') {
        this.#send({ jsonrpc: '2.0', id: message.id, result: await this.#callTool(message.params) });
        return;
      }
      this.#send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } });
    } catch (error) {
      this.#send({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: safeError(error).message } });
    }
  }

  close() {
    this.#unsubscribe?.();
    this.#bridge.close?.();
  }
}

export async function runMcpServer({ args = process.argv.slice(2), input = process.stdin, output = process.stdout } = {}) {
  const config = await loadBridgeConfig(configPathFromArgs(args));
  const bridge = new BridgeClient(config);
  const server = new ToolBraidMcpServer({ bridge, output });
  let bufferedBytes = 0;
  const decoder = new JsonLineDecoder({
    onMessage: (message) => { bufferedBytes = 0; void server.handle(message); },
    onError: () => {
      bufferedBytes = 0;
      writeJsonLine(output, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    },
  });
  input.on('data', (chunk) => {
    bufferedBytes += chunk.length;
    if (bufferedBytes > MAX_MCP_LINE_BYTES) {
      writeJsonLine(output, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      input.destroy();
      return;
    }
    decoder.push(chunk);
  });
  input.on('end', () => server.close());
  input.resume();
  return server;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  runMcpServer().catch((error) => {
    const safe = safeError(error);
    process.stderr.write(`${safe.code}: ${safe.message}\n`);
    process.exitCode = 1;
  });
}
