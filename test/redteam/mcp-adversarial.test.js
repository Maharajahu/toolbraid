import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import {
  CURRENT_PROTOCOL_VERSION,
  JSON_RPC_ERROR_CODES,
  McpGateway,
  StdioTransport,
} from '../../src/mcp/index.js';
import { createServer } from '../../src/server.js';

function metadata() {
  return {
    'io.modelcontextprotocol/protocolVersion': CURRENT_PROTOCOL_VERSION,
    'io.modelcontextprotocol/clientCapabilities': {},
  };
}

function modernCall(id, name = 'workflow.status') {
  return {
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: {
      _meta: metadata(),
      name,
      arguments: {
        tenantId: 'tenant-a',
        subjectId: 'subject-a',
        workflowId: 'workflow-a',
      },
    },
  };
}

test('conflicting explicit identity aliases never reach a tool handler', async () => {
  let calls = 0;
  const gateway = new McpGateway({
    handlers: {
      'workflow.status': () => {
        calls += 1;
        return { ok: true };
      },
    },
  });
  const result = await gateway.callTool('workflow.status', {
    tenantId: 'tenant-a',
    subject: 'subject-a',
    subjectId: 'subject-b',
    workflowId: 'workflow-a',
  });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.code, 'identity_required');
  assert.equal(calls, 0);
});

test('duplicate in-flight JSON-RPC ids cannot replace cancellation state', async () => {
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  let calls = 0;
  const gateway = new McpGateway({
    handlers: {
      'workflow.status': async () => {
        calls += 1;
        await blocked;
        return { ok: true };
      },
    },
  });
  const session = gateway.createSession();
  const first = gateway.handleMessage(modernCall(7), { session });
  await new Promise((resolve) => setImmediate(resolve));
  const duplicate = await gateway.handleMessage(modernCall(7), { session });
  assert.equal(duplicate.error.code, JSON_RPC_ERROR_CODES.INVALID_REQUEST);
  assert.match(duplicate.error.data.reason, /already in flight/);
  assert.equal(calls, 1);
  release();
  const completed = await first;
  assert.equal(completed.result.isError, false);
});

test('stdio rejects complete oversized lines before dispatch', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let calls = 0;
  const gateway = {
    createSession: () => ({}),
    async handleMessage() {
      calls += 1;
      return { jsonrpc: '2.0', id: 1, result: {} };
    },
  };
  const transport = new StdioTransport(gateway, { input, output, maxLineBytes: 16 }).start();
  input.write(`${'x'.repeat(17)}\n`);
  await new Promise((resolve) => setImmediate(resolve));
  await transport.drain();
  assert.equal(calls, 0);
  transport.close();
});

test('stdio discards an oversized frame through its delimiter, not just one chunk', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const calls = [];
  const gateway = {
    createSession: () => ({}),
    async handleMessage(line) {
      calls.push(line);
      return { jsonrpc: '2.0', id: 1, result: {} };
    },
  };
  const transport = new StdioTransport(gateway, { input, output, maxLineBytes: 8 }).start();
  input.write('x'.repeat(9));
  await new Promise((resolve) => setImmediate(resolve));
  // This is the tail of the rejected frame, even though it is valid JSON by
  // itself.  It must be discarded up to the original frame delimiter.
  input.write('{"id":1}\n');
  await new Promise((resolve) => setImmediate(resolve));
  await transport.drain();
  assert.deepEqual(calls, []);

  input.write('{}\n');
  await new Promise((resolve) => setImmediate(resolve));
  await transport.drain();
  assert.deepEqual(calls, ['{}']);
  transport.close();
});

test('HTTP clients do not share protocol negotiation state', async () => {
  let sequence = 0;
  const gateway = {
    createSession() {
      return { marker: ++sequence };
    },
    async handleMessage(message, context) {
      return {
        jsonrpc: '2.0',
        id: message.id,
        result: { marker: context.session.marker },
      };
    },
  };
  const app = createServer({ fixture: true, gateway });
  const server = await app.listen(0, '127.0.0.1');
  const address = server.address();
  const url = `http://127.0.0.1:${address.port}/mcp`;
  const post = async (body) => {
    const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'mcp-protocol-version': CURRENT_PROTOCOL_VERSION,
      'mcp-method': body.method,
    },
    body: JSON.stringify(body),
    });
    return response.json();
  };
  try {
    const first = await post({
      jsonrpc: '2.0',
      id: 1,
      method: 'ping',
      params: { _meta: metadata() },
    });
    const second = await post({
      jsonrpc: '2.0',
      id: 2,
      method: 'ping',
      params: { _meta: metadata() },
    });
    assert.notEqual(first.result.marker, second.result.marker);
  } finally {
    await app.close();
  }
});
