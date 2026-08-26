import { createServer as createHttpServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  createMcpGateway,
  createStdioTransport,
  getToolDefinitions,
  runStdio,
} from './mcp/index.js';

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
  const gateway = options.gateway || (
    options.mcp && typeof options.mcp.handleMessage === 'function' ? options.mcp : createMcpGateway({
    ...(options.mcpOptions || {}),
    serverInfo: options.serverInfo,
    instructions: options.instructions,
    requireIdentity: options.requireIdentity !== false,
    handlers: {
      'capabilities.search': (args) => root.callTool('capabilities.search', args),
      'capabilities.describe': (args) => root.callTool('capabilities.describe', args),
      'plan.propose': (args) => root.callTool('plan.propose', args),
      'workflow.execute': (args) => root.callTool('workflow.execute', args),
      'workflow.status': (args) => root.callTool('workflow.status', args),
      'workflow.replay_readonly': (args) => root.callTool('workflow.replay_readonly', args),
    },
    })
  );
  const session = options.session || gateway.createSession?.();
  const httpOptions = normalizeHttpOptions(options);
  let httpServer;

  const app = {
    root,
    runtime: root,
    gateway,
    session,
    publicToolNames: PUBLIC_TOOL_NAMES,
    publicToolDefinitions: getToolDefinitions(),

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
    async handleRequest(request, requestContext = {}) {
      // The MCP gateway owns protocol negotiation, identity validation, and
      // cancellation semantics.  Stdio/direct callers retain the app session;
      // transports with multiple clients can provide an isolated session.
      if (gateway) return gateway.handleMessage(request, {
        ...(options.context || {}),
        ...requestContext,
        session: requestContext.session ?? session,
      });
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
    handleJsonRpc(request, requestContext) {
      return app.handleRequest(request, requestContext);
    },
    createStdioTransport(transportOptions = {}) {
      return createStdioTransport(gateway, { ...transportOptions, session });
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
        void handleHttpRequest(request, response, app, httpOptions);
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

async function handleHttpRequest(request, response, app, httpOptions) {
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
  if (pathname !== '/mcp') {
    writeJson(response, 404, { error: { code: 'NOT_FOUND', message: 'Not found', retryable: false } });
    return;
  }
  if (request.method !== 'POST') {
    response.setHeader('allow', 'POST');
    writeJson(response, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed', retryable: false } });
    return;
  }
  if (!isAllowedHttpOrigin(request.headers.origin, httpOptions.allowedOrigins)) {
    writeJson(response, 403, protocolError(null, JSON_RPC.invalidRequest, 'Origin is not allowed'));
    return;
  }
  const contentType = singleHeader(request.headers['content-type']);
  if (!contentType || !/^application\/json(?:\s*;|$)/i.test(contentType)) {
    writeJson(response, 415, protocolError(null, JSON_RPC.invalidRequest, 'Content-Type must be application/json'));
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
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      writeJson(response, 400, protocolError(parsed?.id ?? null, JSON_RPC.invalidRequest, 'Invalid Request'));
      return;
    }
    const headerFailure = validateMcpHttpHeaders(request.headers, parsed);
    if (headerFailure) {
      writeJson(response, 400, protocolError(parsed.id ?? null, -32020, 'Header mismatch', {
        reason: headerFailure,
      }));
      return;
    }
    // This HTTP endpoint implements the modern per-request metadata protocol;
    // it has no authenticated MCP session-id mechanism.  Never share the
    // stdio/direct session between unrelated HTTP clients, where one client
    // could otherwise poison protocol negotiation or cancel a colliding id.
    const result = await app.handleRequest(parsed, {
      session: app.gateway.createSession?.(),
      transport: 'http',
    });
    if (result === undefined || result === null) {
      response.writeHead(202, { 'cache-control': 'no-store' });
      response.end();
      return;
    }
    writeJson(response, httpStatusForMcpResult(result), result);
  } catch (error) {
    const tooLarge = error?.code === 'REQUEST_TOO_LARGE';
    writeJson(response, tooLarge ? 413 : 500, {
      jsonrpc: '2.0',
      id: null,
      error: {
        code: tooLarge ? 'REQUEST_TOO_LARGE' : 'INTERNAL_ERROR',
        message: tooLarge ? 'Request body exceeds the maximum size' : 'Request failed',
        retryable: false,
      },
    });
  }
}

function readBody(request, maximum = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    request.setEncoding('utf8');
    const cleanup = () => {
      request.off('data', onData);
      request.off('end', onEnd);
      request.off('error', onError);
    };
    const onData = (chunk) => {
      size += Buffer.byteLength(chunk);
      if (size > maximum) {
        settled = true;
        cleanup();
        reject(new RuntimeError('REQUEST_TOO_LARGE', 'Request body exceeds the maximum size'));
        // Drain the remaining bytes so the server can still send a 413 on the
        // existing connection instead of resetting it mid-response.
        request.resume();
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(chunks.join(''));
    };
    const onError = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    request.on('data', onData);
    request.on('end', onEnd);
    request.on('error', onError);
  });
}

function normalizeHttpOptions(options) {
  const supplied = options.http?.allowedOrigins ?? options.allowedHttpOrigins ?? [];
  if (!Array.isArray(supplied)) {
    throw new RuntimeError('INVALID_HTTP_OPTIONS', 'allowed HTTP origins must be an array');
  }
  const allowedOrigins = new Set();
  for (const value of supplied) {
    if (typeof value !== 'string' || value.trim() !== value) {
      throw new RuntimeError('INVALID_HTTP_OPTIONS', 'allowed HTTP origins must be absolute origins');
    }
    let parsed;
    try {
      parsed = new URL(value);
    } catch {
      throw new RuntimeError('INVALID_HTTP_OPTIONS', 'allowed HTTP origins must be absolute origins');
    }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== value) {
      throw new RuntimeError('INVALID_HTTP_OPTIONS', 'allowed HTTP origins must be canonical HTTP(S) origins');
    }
    allowedOrigins.add(parsed.origin);
  }
  return Object.freeze({ allowedOrigins });
}

function isAllowedHttpOrigin(value, allowedOrigins) {
  // Non-browser clients normally omit Origin.  If it is present, fail closed
  // unless the operator explicitly configured that exact canonical origin.
  if (value === undefined) return true;
  const origin = singleHeader(value);
  if (!origin) return false;
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  return parsed.origin === origin && allowedOrigins.has(parsed.origin);
}

function validateMcpHttpHeaders(headers, message) {
  const version = singleHeader(headers['mcp-protocol-version']);
  const bodyVersion = message.params?._meta?.['io.modelcontextprotocol/protocolVersion'];
  if (!version) return 'MCP-Protocol-Version is required';
  if (version !== bodyVersion) return 'MCP-Protocol-Version does not match request metadata';

  const method = singleHeader(headers['mcp-method']);
  if (!method) return 'Mcp-Method is required';
  if (method !== message.method) return 'Mcp-Method does not match the JSON-RPC method';

  const expectedName = ['tools/call', 'resources/read', 'prompts/get'].includes(message.method)
    ? message.params?.name ?? message.params?.uri
    : undefined;
  const rawName = singleHeader(headers['mcp-name']);
  if (expectedName !== undefined) {
    if (!rawName) return 'Mcp-Name is required for this method';
    const decoded = decodeMcpHeaderValue(rawName);
    if (decoded === undefined) return 'Mcp-Name is malformed';
    if (decoded !== expectedName) return 'Mcp-Name does not match the request body';
  } else if (rawName !== undefined) {
    return 'Mcp-Name is not valid for this method';
  }

  // Keep the transport pinned to the implemented modern revision.  The
  // gateway will return the richer UnsupportedProtocolVersionError body.
  if (typeof bodyVersion !== 'string' || !bodyVersion) return 'protocol metadata is required';
  return null;
}

function decodeMcpHeaderValue(value) {
  const match = /^=\?base64\?([A-Za-z0-9+/]*={0,2})\?=$/.exec(value);
  if (match) {
    try {
      const decoded = Buffer.from(match[1], 'base64');
      if (decoded.toString('base64') !== match[1]) return undefined;
      return decoded.toString('utf8');
    } catch {
      return undefined;
    }
  }
  if (value.startsWith('=?base64?') || value.endsWith('?=')) return undefined;
  if (value.trim() !== value || !/^[\x20-\x7e]+$/.test(value)) return undefined;
  return value;
}

function singleHeader(value) {
  if (Array.isArray(value)) return value.length === 1 ? value[0] : undefined;
  return typeof value === 'string' ? value : undefined;
}

function httpStatusForMcpResult(result) {
  const code = result?.error?.code;
  if (code === JSON_RPC.methodNotFound) return 404;
  if ([JSON_RPC.parse, JSON_RPC.invalidRequest, -32020, -32021, -32022].includes(code)) return 400;
  return 200;
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
    await runStdio(app.gateway, { input: process.stdin, output: process.stdout, session: app.session });
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
