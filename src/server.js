import { createServer as createHttpServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import readline from 'node:readline';

import {
  PUBLIC_TOOL_DEFINITIONS,
  PUBLIC_TOOL_NAMES,
  RuntimeError,
  createCompositionRoot,
  createFixtureRuntime,
} from './runtime/composition-root.js';

export {
  PUBLIC_TOOL_DEFINITIONS,
  PUBLIC_TOOL_NAMES,
  RuntimeError,
  createCompositionRoot,
  createFixtureRuntime,
};

/** JSON-RPC errors; protocol errors never contain provider exception text. */
const JSON_RPC = Object.freeze({
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
});

/**
 * Create an in-process MCP application.  The returned object is intentionally
 * transport-neutral: tests and hosts can call handleRequest() directly, while
 * listen() exposes the same dispatcher over HTTP.
 */
export function createServer(options = {}) {
  const root = options.root || options.runtime || (
    options.fixture || options.fixtures ? createFixtureRuntime(options) : createCompositionRoot(options)
  );
  const externalDispatcher = options.dispatcher || options.mcp?.dispatcher || options.mcp?.dispatch;
  let httpServer;

  const app = {
    root,
    runtime: root,
    publicToolNames: PUBLIC_TOOL_NAMES,
    publicToolDefinitions: PUBLIC_TOOL_DEFINITIONS,

    /** Dispatch a semantic tool directly, without JSON-RPC envelopes. */
    async callTool(name, args = {}) {
      if (typeof externalDispatcher === 'function') {
        const value = await externalDispatcher.call(options.dispatcher || options.mcp, name, args, root);
        if (value !== undefined) return value;
      }
      return root.callTool(name, args);
    },
    dispatch(name, args = {}) {
      return app.callTool(name, args);
    },
    handle(nameOrRequest, args = {}) {
      if (typeof nameOrRequest === 'string') return app.callTool(nameOrRequest, args);
      return app.handleRequest(nameOrRequest);
    },

    /** Handle a parsed JSON-RPC request or a batch. */
    async handleRequest(request) {
      if (Array.isArray(request)) {
        if (request.length === 0) return protocolError(null, JSON_RPC.invalidRequest, 'Invalid Request');
        const responses = [];
        for (const entry of request) {
          const response = await handleOne(entry);
          if (response !== undefined) responses.push(response);
        }
        return responses.length === 0 ? undefined : responses;
      }
      return handleOne(request);
    },
    handleJsonRpc(request) {
      return app.handleRequest(request);
    },

    /** Internal host hook; never registered as an MCP tool. */
    injectTrustedApproval(input) {
      if (typeof root.injectTrustedApproval !== 'function') {
        throw new RuntimeError('APPROVAL_UNAVAILABLE', 'This runtime does not support approval injection');
      }
      return root.injectTrustedApproval(input);
    },
    trustApproval(input) {
      return app.injectTrustedApproval(input);
    },

    /** Start an HTTP listener; the promise resolves after the port is bound. */
    async listen(port = options.port ?? Number(process.env.PORT || 0), host = options.host || '127.0.0.1') {
      if (httpServer) return httpServer;
      httpServer = createHttpServer((request, response) => {
        void handleHttpRequest(request, response, app);
      });
      await new Promise((resolve, reject) => {
        const onError = (error) => {
          httpServer.off('listening', onListening);
          reject(error);
        };
        const onListening = () => {
          httpServer.off('error', onError);
          resolve();
        };
        httpServer.once('error', onError);
        httpServer.once('listening', onListening);
        httpServer.listen(port, host);
      });
      return httpServer;
    },
    server() {
      return httpServer;
    },
    async close() {
      if (!httpServer) return;
      const server = httpServer;
      httpServer = undefined;
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };

  return app;

  async function handleOne(request) {
    if (!request || typeof request !== 'object' || Array.isArray(request) || request.jsonrpc !== '2.0' ||
        (typeof request.method !== 'string' || request.method.length === 0)) {
      return protocolError(request?.id ?? null, JSON_RPC.invalidRequest, 'Invalid Request');
    }
    const isNotification = request.id === undefined;
    try {
      const result = await dispatchProtocol(request.method, request.params);
      if (isNotification) return undefined;
      return { jsonrpc: '2.0', id: request.id, result: jsonSafe(result) };
    } catch (error) {
      if (isNotification) return undefined;
      return protocolError(request.id, errorCode(error), errorMessage(error), errorData(error));
    }
  }

  async function dispatchProtocol(method, params = {}) {
    if (method === 'initialize') {
      return {
        protocolVersion: '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'toolbraid', version: '0.1.0' },
      };
    }
    if (method === 'notifications/initialized' || method === 'ping') return {};
    if (method === 'tools/list') return { tools: PUBLIC_TOOL_DEFINITIONS.map((entry) => jsonSafe(entry)) };
    if (method === 'tools/call') {
      if (!params || typeof params !== 'object' || Array.isArray(params)) {
        throw new RuntimeError('INVALID_ARGUMENT', 'tools/call params must be an object');
      }
      const name = params.name;
      if (typeof name !== 'string' || !PUBLIC_TOOL_NAMES.includes(name)) {
        throw new RuntimeError('TOOL_NOT_FOUND', `Unknown public tool: ${String(name || '')}`, {
          details: { name },
        });
      }
      const result = await app.callTool(name, params.arguments || params.input || {});
      return toolResult(result);
    }
    if (PUBLIC_TOOL_NAMES.includes(method)) return app.callTool(method, params || {});
    throw new RuntimeError('METHOD_NOT_FOUND', `Method not found: ${method}`, { details: { method } });
  }
}

/** Start a server and return the HTTP server decorated with app/root handles. */
export async function startServer(options = {}) {
  const app = options.app || createServer(options);
  const server = await app.listen(options.port ?? Number(process.env.PORT || 0), options.host || '127.0.0.1');
  server.app = app;
  server.root = app.root;
  return server;
}

/** Alias used by some hosts. */
export const createApp = createServer;
export const start = startServer;

async function handleHttpRequest(request, response, app) {
  const pathname = new URL(request.url || '/', 'http://toolbraid.local').pathname;
  if (request.method === 'GET' && (pathname === '/healthz' || pathname === '/health')) {
    writeJson(response, 200, { ok: true, service: 'toolbraid' });
    return;
  }
  if (request.method === 'GET' && pathname === '/') {
    writeJson(response, 200, {
      name: 'toolbraid',
      protocol: 'json-rpc-2.0',
      tools: PUBLIC_TOOL_NAMES,
    });
    return;
  }
  if (request.method !== 'POST' || !['/', '/mcp', '/rpc'].includes(pathname)) {
    writeJson(response, 404, { error: { code: 'NOT_FOUND', message: 'Not found', retryable: false } });
    return;
  }
  try {
    const body = await readBody(request);
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      writeJson(response, 400, protocolError(null, JSON_RPC.parse, 'Parse error'));
      return;
    }
    const result = await app.handleRequest(parsed);
    if (result === undefined) {
      response.writeHead(204);
      response.end();
      return;
    }
    writeJson(response, 200, result);
  } catch (error) {
    writeJson(response, 413, {
      jsonrpc: '2.0',
      id: null,
      error: { code: 'REQUEST_TOO_LARGE', message: error?.message || 'Request rejected', retryable: false },
    });
  }
}

function readBody(request, maximum = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      size += Buffer.byteLength(chunk);
      if (size > maximum) {
        reject(new RuntimeError('REQUEST_TOO_LARGE', 'Request body exceeds the maximum size'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(chunks.join('')));
    request.on('error', reject);
  });
}

function writeJson(response, status, value) {
  const body = JSON.stringify(jsonSafe(value));
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  response.end(body);
}

function toolResult(value) {
  const safe = jsonSafe(value);
  return {
    content: [{ type: 'text', text: JSON.stringify(safe) }],
    structuredContent: safe,
    isError: Boolean(safe && safe.error && safe.error.code),
  };
}

function protocolError(id, code, message, data) {
  const error = { code, message };
  if (data !== undefined) error.data = jsonSafe(data);
  return { jsonrpc: '2.0', id, error };
}

function errorCode(error) {
  if (error?.code === 'METHOD_NOT_FOUND') return JSON_RPC.methodNotFound;
  if (error?.code === 'TOOL_NOT_FOUND') return JSON_RPC.methodNotFound;
  if (error?.code === 'INVALID_ARGUMENT' || error?.code === 'IDENTITY_REQUIRED' || error?.code === 'INVALID_PLAN') return JSON_RPC.invalidParams;
  if (Number.isInteger(error?.jsonRpcCode)) return error.jsonRpcCode;
  return JSON_RPC.internal;
}

function errorMessage(error) {
  if (error?.code === 'METHOD_NOT_FOUND' || error?.code === 'TOOL_NOT_FOUND') return 'Method not found';
  if (error?.code === 'INVALID_ARGUMENT' || error?.code === 'IDENTITY_REQUIRED' || error?.code === 'INVALID_PLAN') return 'Invalid params';
  return error?.message || 'Internal error';
}

function errorData(error) {
  if (!error) return undefined;
  if (typeof error.toJSON === 'function') return error.toJSON();
  if (error.code && error.message) return { code: error.code, message: error.message, retryable: error.retryable === true };
  return undefined;
}

function jsonSafe(value, seen = new Set()) {
  if (value === undefined || value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'bigint') return String(value);
  if (typeof value !== 'object') return String(value);
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  let output;
  if (Array.isArray(value)) output = value.map((entry) => jsonSafe(entry, seen));
  else {
    output = {};
    for (const key of Object.keys(value).sort()) output[key] = jsonSafe(value[key], seen);
  }
  seen.delete(value);
  return output;
}

async function runCli() {
  const fixture = process.env.TOOLBRAID_FIXTURE === '1';
  if (process.env.TOOLBRAID_TRANSPORT === 'stdio') {
    const app = createServer({ fixture });
    const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
    for await (const line of input) {
      if (!line.trim()) continue;
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        process.stdout.write(`${JSON.stringify(protocolError(null, JSON_RPC.parse, 'Parse error'))}\n`);
        continue;
      }
      const response = await app.handleRequest(parsed);
      if (response !== undefined) process.stdout.write(`${JSON.stringify(response)}\n`);
    }
    return;
  }
  const server = await startServer({ fixture });
  const address = server.address();
  process.stderr.write(`toolbraid listening on http://${address.address}:${address.port}\n`);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath && invokedPath === path.resolve(fileURLToPath(import.meta.url))) {
  runCli().catch((error) => {
    process.stderr.write(`${error?.message || error}\n`);
    process.exitCode = 1;
  });
}

