import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import {
  CURRENT_PROTOCOL_VERSION,
  createMcpGateway,
  createStdioTransport,
} from '../../src/mcp/index.js';

function modernRequest(id, method, params = {}) {
  return JSON.stringify({
    jsonrpc: '2.0',
    id,
    method,
    params: {
      _meta: {
        'io.modelcontextprotocol/protocolVersion': CURRENT_PROTOCOL_VERSION,
        'io.modelcontextprotocol/clientCapabilities': {},
      },
      ...params,
    },
  });
}

class FakeInput extends EventEmitter {
  once(event, listener) {
    return super.once(event, listener);
  }
}

class FakeOutput {
  constructor() {
    this.writes = [];
  }

  write(value) {
    this.writes.push(value);
    return true;
  }
}

test('stdio transport frames one JSON-RPC message per output line', async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const gateway = createMcpGateway({ requireIdentity: false });
  const transport = createStdioTransport(gateway, { input, output, logToStderr: false });
  transport.start();

  const request = modernRequest(1, 'tools/list');
  input.emit('data', request.slice(0, 17));
  input.emit('data', `${request.slice(17)}\n`);
  await new Promise((resolve) => setImmediate(resolve));
  await transport.drain();

  assert.equal(output.writes.length, 1);
  assert.equal(output.writes[0].endsWith('\n'), true);
  const response = JSON.parse(output.writes[0]);
  assert.equal(response.id, 1);
  assert.equal(response.result.tools.length, 6);
  transport.close();
});

test('stdio transport emits parse errors for blank and oversized frames', async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const gateway = createMcpGateway({ requireIdentity: false });
  const transport = createStdioTransport(gateway, {
    input,
    output,
    maxLineBytes: 32,
    logToStderr: false,
  });
  transport.start();
  input.emit('data', '\n');
  input.emit('data', `${'x'.repeat(40)}\n`);
  await new Promise((resolve) => setImmediate(resolve));
  await transport.drain();

  assert.equal(output.writes.length, 2);
  assert.equal(JSON.parse(output.writes[0]).error.code, -32700);
  assert.equal(JSON.parse(output.writes[1]).error.code, -32700);
  transport.close();
});

test('cancellation notification suppresses a late tool response', async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  let release;
  const waiting = new Promise((resolve) => { release = resolve; });
  const gateway = createMcpGateway({
    handlers: {
      'workflow.status': async () => {
        await waiting;
        return { done: true };
      },
    },
  });
  const transport = createStdioTransport(gateway, { input, output, logToStderr: false });
  transport.start();
  input.emit('data', `${modernRequest(42, 'tools/call', {
    name: 'workflow.status',
    arguments: { tenantId: 't', subjectId: 's', workflowId: 'w' },
  })}\n`);
  await new Promise((resolve) => setImmediate(resolve));
  input.emit('data', `${JSON.stringify({
    jsonrpc: '2.0',
    method: 'notifications/cancelled',
    params: { requestId: 42 },
  })}\n`);
  await new Promise((resolve) => setImmediate(resolve));
  release();
  await new Promise((resolve) => setImmediate(resolve));
  await transport.drain();
  assert.equal(output.writes.length, 0);
  transport.close();
});

