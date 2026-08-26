import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import test from 'node:test';

import { createServer } from '../../src/server.js';

const CURRENT_PROTOCOL_VERSION = '2026-07-28';
const PUBLIC_TOOLS = [
  'capabilities.search',
  'capabilities.describe',
  'plan.propose',
  'workflow.execute',
  'workflow.status',
  'workflow.replay_readonly',
];

const ROOT = new URL('../..', import.meta.url);
const SERVER_ENTRY = new URL('../../src/server.js', import.meta.url);

function metadata() {
  return {
    'io.modelcontextprotocol/protocolVersion': CURRENT_PROTOCOL_VERSION,
    'io.modelcontextprotocol/clientCapabilities': {},
    'io.modelcontextprotocol/clientInfo': {
      name: 'toolbraid-acceptance',
      version: '1.0.0',
    },
  };
}

function modernRequest(id, method, params = {}) {
  return {
    jsonrpc: '2.0',
    id,
    method,
    params: {
      _meta: metadata(),
      ...params,
    },
  };
}

function legacyInitialize(id = 1) {
  return {
    jsonrpc: '2.0',
    id,
    method: 'initialize',
    params: {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'toolbraid-legacy-acceptance', version: '1.0.0' },
    },
  };
}

async function withHttpServer(callback) {
  const app = createServer({ fixture: true });
  const server = await app.listen(0);
  const address = server.address();
  const base = `http://${address.address}:${address.port}`;
  try {
    return await callback({ app, base });
  } finally {
    await app.close();
  }
}

function httpRequest(base, path, {
  method = 'GET',
  body,
  headers = {},
} = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const requestHeaders = { ...headers };
    if (body !== undefined && requestHeaders['content-length'] === undefined) {
      requestHeaders['content-length'] = Buffer.byteLength(body);
    }
    if (body !== undefined && requestHeaders['content-type'] === undefined) {
      requestHeaders['content-type'] = 'application/json';
    }

    const request = http.request(url, {
      method,
      headers: requestHeaders,
    }, (response) => {
      const chunks = [];
      response.setEncoding('utf8');
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body: chunks.join(''),
      }));
    });
    request.setTimeout(5_000, () => {
      request.destroy(new Error(`timed out: ${method} ${path}`));
    });
    request.on('error', (error) => {
      reject(new Error(`${method} ${path}: ${error.message}`, { cause: error }));
    });
    if (body !== undefined) request.end(body);
    else request.end();
  });
}

async function httpJson(base, path, options = {}) {
  const response = await httpRequest(base, path, options);
  let value;
  try {
    value = response.body === '' ? undefined : JSON.parse(response.body);
  } catch (error) {
    throw new Error(`invalid JSON from ${options.method || 'GET'} ${path}: ${error.message}`, {
      cause: error,
    });
  }
  return { ...response, value };
}

function httpRpc(base, message, { path = '/mcp', headers = {} } = {}) {
  const protocolVersion = message.params?._meta?.['io.modelcontextprotocol/protocolVersion'];
  const transportHeaders = {
    'MCP-Protocol-Version': protocolVersion,
    'Mcp-Method': message.method,
    ...(['tools/call', 'resources/read', 'prompts/get'].includes(message.method)
      ? { 'Mcp-Name': message.params?.name ?? message.params?.uri }
      : {}),
    ...headers,
  };
  return httpJson(base, path, {
    method: 'POST',
    headers: transportHeaders,
    body: JSON.stringify(message),
  });
}

class StdioProcess {
  constructor() {
    this.child = spawn(process.execPath, [SERVER_ENTRY.pathname], {
      cwd: ROOT.pathname,
      env: {
        ...process.env,
        TOOLBRAID_FIXTURE: '1',
        TOOLBRAID_TRANSPORT: 'stdio',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.messages = [];
    this.waiters = [];
    this.stdout = '';
    this.stderr = '';
    this.closed = false;
    this.child.stdout.setEncoding('utf8');
    this.child.stderr.setEncoding('utf8');
    this.child.stdout.on('data', (chunk) => this.#receiveStdout(chunk));
    this.child.stderr.on('data', (chunk) => { this.stderr += chunk; });
    this.child.once('error', (error) => this.#failWaiters(error));
    this.child.once('close', (code, signal) => {
      this.closed = true;
      if (code !== 0) {
        this.#failWaiters(new Error(`stdio server exited (${code ?? signal}): ${this.stderr}`));
      }
    });
  }

  send(message) {
    if (this.closed) throw new Error('stdio server is closed');
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  sendRaw(frame) {
    if (this.closed) throw new Error('stdio server is closed');
    this.child.stdin.write(frame);
  }

  async request(message, timeoutMs = 5_000) {
    const id = message.id;
    assert.notEqual(id, undefined, 'request() requires a JSON-RPC id');
    const response = this.#next((candidate) => candidate.id === id, timeoutMs);
    this.send(message);
    return response;
  }

  async waitForMessage(predicate = () => true, timeoutMs = 5_000) {
    return this.#next(predicate, timeoutMs);
  }

  async assertNoMessage(durationMs = 100) {
    await new Promise((resolve) => setTimeout(resolve, durationMs));
    assert.equal(this.messages.length, 0, `unexpected stdio output: ${JSON.stringify(this.messages)}`);
  }

  async close() {
    if (this.closed) return;
    this.child.stdin.end();
    await new Promise((resolve) => {
      let finished = false;
      let timer;
      const finish = () => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        this.child.off('close', finish);
        resolve();
      };
      this.child.once('close', finish);
      if (this.closed) {
        finish();
        return;
      }
      timer = setTimeout(() => {
        if (!this.closed) this.child.kill('SIGTERM');
        finish();
      }, 5_000);
    });
  }

  #next(predicate, timeoutMs) {
    const index = this.messages.findIndex(predicate);
    if (index !== -1) return Promise.resolve(this.messages.splice(index, 1)[0]);
    return new Promise((resolve, reject) => {
      const waiter = {
        predicate,
        resolve: (message) => {
          clearTimeout(waiter.timer);
          resolve(message);
        },
        reject: (error) => {
          clearTimeout(waiter.timer);
          reject(error);
        },
        timer: setTimeout(() => {
          const indexInWaiters = this.waiters.indexOf(waiter);
          if (indexInWaiters !== -1) this.waiters.splice(indexInWaiters, 1);
          reject(new Error(`timed out waiting for stdio response; stderr: ${this.stderr}`));
        }, timeoutMs),
      };
      this.waiters.push(waiter);
    });
  }

  #receiveStdout(chunk) {
    this.stdout += chunk;
    let newline;
    while ((newline = this.stdout.indexOf('\n')) !== -1) {
      const line = this.stdout.slice(0, newline).replace(/\r$/, '');
      this.stdout = this.stdout.slice(newline + 1);
      if (line.length === 0) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch (error) {
        this.#failWaiters(new Error(`stdio emitted invalid JSON: ${error.message}`));
        continue;
      }
      const waiterIndex = this.waiters.findIndex((waiter) => waiter.predicate(message));
      if (waiterIndex === -1) this.messages.push(message);
      else this.waiters.splice(waiterIndex, 1)[0].resolve(message);
    }
  }

  #failWaiters(error) {
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
  }
}

test('HTTP health, current metadata, and exactly six public tools are exposed', async () => {
  await withHttpServer(async ({ base }) => {
    for (const path of ['/healthz', '/health']) {
      const health = await httpJson(base, path);
      assert.equal(health.status, 200);
      assert.deepEqual(health.value, { ok: true, service: 'toolbraid' });
    }

    const root = await httpJson(base, '/');
    assert.equal(root.status, 200);
    assert.deepEqual(root.value, {
      name: 'toolbraid',
      protocol: 'json-rpc-2.0',
      tools: PUBLIC_TOOLS,
    });

    const discover = await httpRpc(base, modernRequest('discover', 'server/discover'));
    assert.equal(discover.status, 200);
    assert.equal(discover.value.id, 'discover');
    assert.equal(discover.value.result.resultType, 'complete');
    assert.deepEqual(discover.value.result.supportedVersions, [CURRENT_PROTOCOL_VERSION]);
    assert.deepEqual(discover.value.result.capabilities, { tools: { listChanged: false } });
    assert.deepEqual(
      discover.value.result._meta['io.modelcontextprotocol/serverInfo'],
      { name: 'ToolBraid', version: '0.1.0', description: 'Secure semantic workflow control plane' },
    );

    const listed = await httpRpc(base, modernRequest(1, 'tools/list'));
    assert.equal(listed.status, 200);
    assert.equal(listed.value.result.resultType, 'complete');
    assert.deepEqual(listed.value.result.tools.map((tool) => tool.name), PUBLIC_TOOLS);
    assert.equal(listed.value.result.tools.length, 6);
    assert.equal(JSON.stringify(listed.value.result.tools).includes('approval.grant'), false);
  });
});

test('HTTP enforces current metadata and rejects hidden approval operations', async () => {
  await withHttpServer(async ({ base }) => {
    const missingMetadata = await httpJson(base, '/mcp', {
      method: 'POST',
      headers: {
        'MCP-Protocol-Version': CURRENT_PROTOCOL_VERSION,
        'Mcp-Method': 'tools/list',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
    });
    assert.equal(missingMetadata.status, 400);
    assert.equal(missingMetadata.value.error.code, -32020);

    const unsupportedRequest = modernRequest(3, 'tools/list', {
        _meta: {
          ...metadata(),
          'io.modelcontextprotocol/protocolVersion': '1900-01-01',
        },
      });
    const unsupported = await httpRpc(base, unsupportedRequest, {
      headers: { 'MCP-Protocol-Version': '1900-01-01' },
    });
    assert.equal(unsupported.status, 400);
    assert.equal(unsupported.value.error.code, -32022);
    assert.deepEqual(unsupported.value.error.data.supported, [CURRENT_PROTOCOL_VERSION]);

    const hiddenCall = await httpRpc(base, modernRequest(4, 'tools/call', {
        name: 'approval.grant',
        arguments: {},
      }));
    assert.equal(hiddenCall.status, 200);
    assert.equal(hiddenCall.value.error.code, -32602);
    assert.equal(hiddenCall.value.error.message, 'Unknown tool');

    const hiddenMethod = await httpRpc(base, modernRequest(5, 'approval.grant'));
    assert.equal(hiddenMethod.value.error.code, -32601);
  });
});

test('HTTP returns no response for notifications and standard errors for invalid frames', async () => {
  await withHttpServer(async ({ base }) => {
    const notification = await httpRpc(base, modernRequest(undefined, 'notifications/initialized'));
    assert.equal(notification.status, 202);
    assert.equal(notification.body, '');

    const unknownNotification = await httpRpc(base, modernRequest(undefined, 'notifications/not-a-real-event'));
    assert.equal(unknownNotification.status, 202);
    assert.equal(unknownNotification.body, '');

    const malformed = await httpJson(base, '/mcp', {
      method: 'POST',
      body: '{not json',
    });
    assert.equal(malformed.status, 400);
    assert.equal(malformed.value.error.code, -32700);
    assert.equal(malformed.value.id, null);

    const invalidRequest = await httpRpc(base, {
      jsonrpc: '1.0',
      id: 6,
      method: 'ping',
      params: { _meta: metadata() },
    });
    assert.equal(invalidRequest.status, 400);
    assert.equal(invalidRequest.value.error.code, -32600);

    const batch = await httpJson(base, '/mcp', {
      method: 'POST',
      headers: {
        'MCP-Protocol-Version': CURRENT_PROTOCOL_VERSION,
        'Mcp-Method': 'ping',
      },
      body: JSON.stringify([modernRequest(7, 'ping')]),
    });
    assert.equal(batch.status, 400);
    assert.equal(batch.value.error.code, -32600);
    assert.equal(batch.value.id, null);
  });
});

test('HTTP rejects request bodies over one MiB with a 413 error response', async () => {
  await withHttpServer(async ({ base }) => {
    const body = JSON.stringify({ payload: 'x'.repeat(1024 * 1024) });
    assert.ok(Buffer.byteLength(body) > 1024 * 1024);
    const response = await httpJson(base, '/mcp', {
      method: 'POST',
      body,
    });
    assert.equal(response.status, 413);
    assert.equal(response.value.jsonrpc, '2.0');
    assert.equal(response.value.id, null);
    assert.equal(response.value.error.code, 'REQUEST_TOO_LARGE');
  });
});

test('stdio serves current metadata and exactly six tools without stdout contamination', async () => {
  const process_ = new StdioProcess();
  try {
    const response = await process_.request(modernRequest(1, 'tools/list'));
    assert.equal(response.jsonrpc, '2.0');
    assert.equal(response.id, 1);
    assert.equal(response.result.resultType, 'complete');
    assert.deepEqual(response.result.tools.map((tool) => tool.name), PUBLIC_TOOLS);
    assert.equal(response.result.tools.length, 6);
    assert.deepEqual(
      response.result._meta['io.modelcontextprotocol/serverInfo'],
      { name: 'ToolBraid', version: '0.1.0', description: 'Secure semantic workflow control plane' },
    );
    assert.equal(process_.stderr, '');
  } finally {
    await process_.close();
  }
});

test('stdio rejects hidden approval calls, invalid frames, and notifications without replies', async () => {
  const process_ = new StdioProcess();
  try {
    const hidden = await process_.request(modernRequest(2, 'tools/call', {
      name: 'approval.grant',
      arguments: {},
    }));
    assert.equal(hidden.error.code, -32602);

    process_.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    await process_.assertNoMessage();

    process_.send({ jsonrpc: '2.0', method: 'notifications/not-a-real-event' });
    await process_.assertNoMessage();
  } finally {
    await process_.close();
  }
});

test('stdio emits parse errors for malformed frames and keeps sessions isolated', async () => {
  const first = new StdioProcess();
  const second = new StdioProcess();
  try {
    const firstModern = await first.request(modernRequest(10, 'ping'));
    assert.equal(firstModern.result.resultType, 'complete');

    first.sendRaw('{not json\n');
    const parse = await first.waitForMessage((message) => message.error?.code === -32700);
    assert.equal(parse.jsonrpc, '2.0');
    assert.equal('id' in parse, false);

    first.sendRaw('\n');
    const blankParse = await first.waitForMessage((message) => message.error?.code === -32700);
    assert.equal('id' in blankParse, false);

    // A modern session cannot silently fall back to the legacy handshake.
    const mixed = await first.request(legacyInitialize(11));
    assert.equal(mixed.error.code, -32600);

    // A separate stdio process has a fresh, independent protocol session.
    const secondModern = await second.request(modernRequest(12, 'tools/list'));
    assert.deepEqual(secondModern.result.tools.map((tool) => tool.name), PUBLIC_TOOLS);
  } finally {
    await Promise.all([first.close(), second.close()]);
  }
});
