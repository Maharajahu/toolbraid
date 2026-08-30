import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import net from 'node:net';
import { Writable } from 'node:stream';
import test from 'node:test';

import {
  BRIDGE_PROTOCOL,
  BRIDGE_PROTOCOL_VERSION,
  JsonLineDecoder,
  validateBridgeConfig,
  writeJsonLine,
} from '../../bridge/common.mjs';
import { BridgeClient, ToolBraidMcpServer } from '../../bridge/mcp-server.mjs';

function outputCollector() {
  const messages = [];
  let pending = '';
  const output = new Writable({
    write(chunk, _encoding, callback) {
      pending += chunk.toString('utf8');
      while (pending.includes('\n')) {
        const index = pending.indexOf('\n');
        const line = pending.slice(0, index);
        pending = pending.slice(index + 1);
        if (line) messages.push(JSON.parse(line));
      }
      callback();
    },
  });
  return { output, messages };
}

test('MCP lifecycle lists live page tools and preserves human approval ownership', async () => {
  let eventListener = null;
  const bridgeCalls = [];
  const dynamicTool = {
    name: 'toolbraid.read_post.0123456789abcdef',
    title: 'Read post',
    description: 'Read the current post from the exact active page.',
    inputSchema: { type: 'object', additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false },
  };
  const bridge = {
    onEvent(listener) { eventListener = listener; return () => { eventListener = null; }; },
    async request(method, params) {
      bridgeCalls.push({ method, params });
      if (method === 'tools.list') return { tools: [dynamicTool] };
      if (method === 'bridge.status') return { connected: true, page: { origin: 'https://example.test' } };
      if (method === 'tools.call') return { ok: true, result: { status: 'read-completed', data: { text: 'hello' } } };
      throw new Error('unexpected method');
    },
    close() {},
  };
  const { output, messages } = outputCollector();
  const server = new ToolBraidMcpServer({ bridge, output });

  await server.handle({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
  });
  assert.equal(messages[0].result.capabilities.tools.listChanged, true);
  assert.match(messages[0].result.instructions, /approval and dispatch remain human-owned/i);
  await server.handle({ jsonrpc: '2.0', method: 'notifications/initialized' });
  await server.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  assert.deepEqual(messages[1].result.tools.map((tool) => tool.name), ['toolbraid_status', dynamicTool.name]);

  await server.handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: dynamicTool.name, arguments: {} } });
  assert.equal(messages[2].result.isError, false);
  assert.equal(messages[2].result.structuredContent.result.status, 'read-completed');
  assert.equal(bridgeCalls.at(-1).method, 'tools.call');

  eventListener('tools_changed');
  assert.equal(messages.at(-1).method, 'notifications/tools/list_changed');
  await server.handle({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: dynamicTool.name, arguments: {} } });
  assert.equal(messages.at(-1).result.isError, true);
  assert.equal(messages.at(-1).result.structuredContent.code, 'MCP_TOOL_NOT_LISTED');
  server.close();
});

test('status remains callable and truthful while Chrome is disconnected', async () => {
  const bridge = {
    onEvent() { return () => {}; },
    async request() { throw Object.assign(new Error('offline detail'), { code: 'BRIDGE_DISCONNECTED' }); },
    close() {},
  };
  const { output, messages } = outputCollector();
  const server = new ToolBraidMcpServer({ bridge, output });
  await server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
  await server.handle({ jsonrpc: '2.0', method: 'notifications/initialized' });
  await server.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  assert.deepEqual(messages[1].result.tools.map((tool) => tool.name), ['toolbraid_status']);
  await server.handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'toolbraid_status', arguments: {} } });
  assert.equal(messages[2].result.isError, false);
  assert.equal(messages[2].result.structuredContent.connected, false);
  assert.equal(messages[2].result.structuredContent.error.code, 'BRIDGE_DISCONNECTED');
  server.close();
});

test('authenticated named-pipe client rejects ambient unauthenticated access', async (context) => {
  const token = randomBytes(32).toString('hex');
  const pipe = process.platform === 'win32'
    ? `\\\\.\\pipe\\toolbraid-mcp-${randomBytes(16).toString('hex')}`
    : `/tmp/toolbraid-mcp-${randomBytes(16).toString('hex')}.sock`;
  const config = validateBridgeConfig({
    version: 1,
    token,
    pipe,
    allowedOrigin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/',
  });
  const server = net.createServer((socket) => {
    let authenticated = false;
    const decoder = new JsonLineDecoder({
      onMessage(message) {
        if (!authenticated) {
          authenticated = message.kind === 'auth' && message.token === token;
          writeJsonLine(socket, { protocol: BRIDGE_PROTOCOL, version: BRIDGE_PROTOCOL_VERSION, kind: 'auth', ok: authenticated });
          if (!authenticated) socket.end();
          return;
        }
        writeJsonLine(socket, {
          protocol: BRIDGE_PROTOCOL,
          version: BRIDGE_PROTOCOL_VERSION,
          kind: 'response',
          requestId: message.requestId,
          ok: true,
          result: { connected: true },
        });
      },
      onError() { socket.destroy(); },
    });
    socket.on('data', (chunk) => decoder.push(chunk));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(pipe, resolve);
  });
  context.after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  const client = new BridgeClient(config, { timeoutMs: 2_000 });
  const result = await client.request('bridge.status', {});
  assert.deepEqual(result, { connected: true });
  client.close();

  const wrong = new BridgeClient({ ...config, token: '0'.repeat(64) }, { timeoutMs: 2_000 });
  await assert.rejects(wrong.request('bridge.status', {}), (error) => error.code === 'BRIDGE_AUTH_REJECTED');
  wrong.close();
});
