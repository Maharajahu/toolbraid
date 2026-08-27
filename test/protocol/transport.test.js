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

class FlowInput extends FakeInput {
  constructor() {
    super();
    this.pauseCalls = 0;
    this.resumeCalls = 0;
  }

  pause() {
    this.pauseCalls += 1;
    return this;
  }

  resume() {
    this.resumeCalls += 1;
    return this;
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

class NeverDrainOutput extends EventEmitter {
  constructor() {
    super();
    this.writes = [];
  }

  write(value) {
    this.writes.push(value);
    return false;
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

test('stdio admission bounds active work, queue bytes, and overload replies', async () => {
  const input = new FlowInput();
  const output = new FakeOutput();
  const started = [];
  const releases = [];
  const gateway = {
    async handleMessage(line) {
      const message = JSON.parse(line);
      started.push(message.id);
      await new Promise((resolve) => releases.push(resolve));
      return { jsonrpc: '2.0', id: message.id, result: { ok: true } };
    },
  };
  const transport = createStdioTransport(gateway, {
    input,
    output,
    maxActiveTasks: 1,
    maxQueuedTasks: 2,
    maxQueuedBytes: 96,
    maxOverflowResponses: 4,
    logToStderr: false,
  });
  transport.start();

  const flood = Array.from({ length: 20 }, (_, id) =>
    `${JSON.stringify({ jsonrpc: '2.0', id: id + 1, method: 'slow' })}\n`).join('');
  input.emit('data', flood);
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(started, [1]);
  assert.equal(transport.activeTaskCount, 1);
  assert.equal(transport.queue.length, 2);
  assert.ok(transport.queueBytes <= 96);
  assert.equal(input.pauseCalls, 1);
  assert.ok(output.writes.length <= 4);
  assert.ok(output.writes.every((line) => JSON.parse(line).error?.code === -32024));

  releases.shift()();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, [1, 2]);
  releases.shift()();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, [1, 2, 3]);
  releases.shift()();
  await transport.drain();
  assert.equal(transport.queue.length, 0);
  assert.ok(input.resumeCalls >= 1);
  transport.close();
});

test('stdio cancellation uses a reserved bounded lane behind a hanging gateway', async () => {
  const input = new FlowInput();
  const output = new FakeOutput();
  const calls = [];
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  const gateway = {
    async handleMessage(line) {
      const message = JSON.parse(line);
      calls.push(message.id ?? message.method);
      if (message.id === 1) await blocked;
      return message.id === undefined ? null : { jsonrpc: '2.0', id: message.id, result: {} };
    },
  };
  const transport = createStdioTransport(gateway, {
    input,
    output,
    maxActiveTasks: 1,
    maxQueuedTasks: 1,
    maxCancellationTasks: 1,
    maxCancellationQueue: 1,
    logToStderr: false,
  });
  transport.start();

  input.emit('data', `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'slow' })}\n`);
  input.emit('data', `${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'slow' })}\n`);
  input.emit('data', `${JSON.stringify({
    jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 },
  })}\n`);
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(calls, [1, 'notifications/cancelled']);
  assert.equal(transport.activeTaskCount, 1);
  assert.equal(transport.activeCancellationCount, 0);
  assert.ok(transport.tasks.size <= 2);

  release();
  await transport.drain();
  assert.deepEqual(calls, [1, 'notifications/cancelled', 2]);
  transport.close();
});

test('stdio stops normal dispatch when output never drains, but still admits cancellation', async () => {
  const input = new FlowInput();
  const output = new NeverDrainOutput();
  const calls = [];
  const gateway = {
    async handleMessage(line) {
      const message = JSON.parse(line);
      calls.push(message.id ?? message.method);
      if (message.id === undefined) return null;
      return {
        jsonrpc: '2.0',
        id: message.id,
        result: { payload: 'x'.repeat(100 * 1024) },
      };
    },
  };
  const transport = createStdioTransport(gateway, {
    input,
    output,
    maxActiveTasks: 2,
    maxQueuedTasks: 4,
    maxQueuedBytes: 4096,
    maxOverflowResponses: 0,
    logToStderr: false,
  });
  transport.start();

  const flood = Array.from({ length: 40 }, (_, id) =>
    `${JSON.stringify({ jsonrpc: '2.0', id: id + 1, method: 'large' })}\n`).join('');
  input.emit('data', flood);
  await new Promise((resolve) => setImmediate(resolve));
  await transport.drain();

  assert.equal(transport.outputBackpressured, true);
  assert.deepEqual(calls, [1, 2]);
  assert.equal(output.writes.length, 2);
  assert.equal(transport.queue.length, 4);
  assert.ok(transport.tasks.size <= 2);

  input.emit('data', `${JSON.stringify({
    jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 },
  })}\n`);
  await new Promise((resolve) => setImmediate(resolve));
  await transport.drain();
  assert.deepEqual(calls, [1, 2, 'notifications/cancelled']);
  assert.equal(output.writes.length, 2);
  transport.close();
});
