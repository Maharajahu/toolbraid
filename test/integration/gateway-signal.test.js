import test from 'node:test';
import assert from 'node:assert/strict';

import { createServer } from '../../src/server.js';
import { createCompositionRoot } from '../../src/runtime/composition-root.js';
import { createStructuredAdapter } from '../../src/adapters/structured.js';

const ORIGIN = 'https://signals.example.test';
const IDENTITY = { tenantId: 'tenant-signals', subject: 'subject-signals', origin: ORIGIN };

function modernCall(id, name, argumentsValue) {
  return {
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: {
      _meta: {
        'io.modelcontextprotocol/protocolVersion': '2026-07-28',
        'io.modelcontextprotocol/clientCapabilities': {},
      },
      name,
      arguments: argumentsValue,
    },
  };
}

test('gateway signal reaches a read adapter through server, runtime, broker, and typed adapter boundaries', async () => {
  let receivedSignal;
  const runtime = createCompositionRoot({
    identity: IDENTITY,
    allowReadOnly: true,
    capabilities: [{
      id: 'signals.read',
      version: '1',
      name: 'Read signal fixture',
      readOnly: true,
      adapters: [{ id: 'signal-adapter' }],
      origins: [ORIGIN],
      inputSchema: { type: 'object', additionalProperties: false },
      outputSchema: { type: 'object', additionalProperties: true },
    }],
    adapters: {
      'signal-adapter': {
        id: 'signal-adapter',
        origin: ORIGIN,
        origins: [ORIGIN],
        capabilities: [{ id: 'signals.read' }],
        execute(request) {
          receivedSignal = request.context?.signal;
          return { ok: true, output: { observed: receivedSignal?.aborted === false } };
        },
      },
    },
  });
  const app = createServer({ root: runtime });
  const proposed = await app.callTool('plan.propose', {
    ...IDENTITY,
    nodes: [{ id: 'read-node', capabilityId: 'signals.read', args: {} }],
  });
  const response = await app.handleRequest(modernCall(1, 'workflow.execute', {
    ...IDENTITY,
    workflowId: proposed.workflowId,
    revision: proposed.revision,
  }));

  assert.equal(response.result.isError, false);
  assert.equal(response.result.structuredContent.status, 'completed');
  assert.ok(receivedSignal, 'adapter did not receive a signal');
  assert.equal(typeof receivedSignal.aborted, 'boolean');
  assert.equal(receivedSignal.aborted, false);
});

test('read signal survives the JSON-only typed adapter envelope without becoming provider data', async () => {
  let receivedSignal;
  const structuredAdapter = createStructuredAdapter({
    id: 'structured-signal-adapter',
    origin: ORIGIN,
    capabilities: [{
      name: 'signals.structured-read',
      readOnly: true,
      inputSchema: { type: 'object', additionalProperties: false },
      outputSchema: { type: 'object', additionalProperties: true },
    }],
    handlers: {
      'signals.structured-read': ({ context }) => {
        receivedSignal = context.signal;
        return { observed: context.signal?.aborted === false };
      },
    },
  });
  const runtime = createCompositionRoot({
    identity: IDENTITY,
    allowReadOnly: true,
    capabilities: [{
      id: 'signals.structured-read',
      version: '1',
      name: 'Structured signal fixture',
      readOnly: true,
      adapters: [{ id: 'structured-signal-adapter' }],
      origins: [ORIGIN],
      inputSchema: { type: 'object', additionalProperties: false },
      outputSchema: { type: 'object', additionalProperties: true },
    }],
    adapters: [structuredAdapter],
  });
  const app = createServer({ root: runtime });
  const proposed = await app.callTool('plan.propose', {
    ...IDENTITY,
    nodes: [{ id: 'structured-read-node', capabilityId: 'signals.structured-read', args: {} }],
  });
  const response = await app.handleRequest(modernCall(2, 'workflow.execute', {
    ...IDENTITY,
    workflowId: proposed.workflowId,
    revision: proposed.revision,
  }));

  assert.equal(response.result.isError, false);
  assert.ok(receivedSignal, 'base typed adapter did not receive a signal');
  assert.equal(receivedSignal.aborted, false);
});

test('gateway signal is withheld from mutation adapter requests', async () => {
  let receivedContext;
  const runtime = createCompositionRoot({
    identity: IDENTITY,
    capabilities: [{
      id: 'signals.write',
      version: '1',
      name: 'Mutation signal fixture',
      readOnly: false,
      adapters: [{ id: 'mutation-signal-adapter' }],
      origins: [ORIGIN],
      inputSchema: { type: 'object', additionalProperties: false },
      outputSchema: { type: 'object', additionalProperties: true },
    }],
    policyRules: [{
      effect: 'allow',
      capabilities: ['signals.write'],
      origins: [ORIGIN],
      adapters: ['mutation-signal-adapter'],
    }],
    adapters: {
      'mutation-signal-adapter': {
        id: 'mutation-signal-adapter',
        origin: ORIGIN,
        origins: [ORIGIN],
        capabilities: [{ id: 'signals.write' }],
        execute(request) {
          receivedContext = request.context;
          return { ok: true, output: { committed: true } };
        },
      },
    },
  });
  const app = createServer({ root: runtime });
  const proposed = await app.callTool('plan.propose', {
    ...IDENTITY,
    nodes: [{ id: 'write-node', capabilityId: 'signals.write', args: {} }],
  });
  const waiting = await app.callTool('workflow.execute', {
    ...IDENTITY,
    workflowId: proposed.workflowId,
    revision: proposed.revision,
  });
  assert.equal(waiting.status, 'awaiting_approval');
  await runtime.injectTrustedApproval(waiting.approvalRequest);

  const response = await app.handleRequest(modernCall(3, 'workflow.execute', {
    ...IDENTITY,
    workflowId: proposed.workflowId,
    revision: proposed.revision,
  }));
  assert.equal(response.result.isError, false);
  assert.equal(response.result.structuredContent.status, 'completed');
  assert.ok(receivedContext, 'mutation adapter did not receive its normal context');
  assert.equal(Object.prototype.hasOwnProperty.call(receivedContext, 'signal'), false);
});
