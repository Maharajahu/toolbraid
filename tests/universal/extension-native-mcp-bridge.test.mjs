import assert from 'node:assert/strict';
import test from 'node:test';

import {
  NATIVE_MCP_PROTOCOL,
  NATIVE_MCP_VERSION,
  createExtensionMcpEndpoint,
  installNativeMcpBridge,
} from '../../extension/native-mcp-bridge.js';

function pageState(overrides = {}) {
  return {
    tab: { id: 42, windowId: 8, url: 'https://example.test/post/7', origin: 'https://example.test', title: 'Post 7' },
    sessionId: 'session-0123456789',
    snapshot: { pageFingerprint: 'fingerprint-0123456789' },
    tools: [
      {
        name: 'read_post',
        title: 'Read post',
        description: 'Read the current post.',
        classification: 'read',
        requiresApproval: false,
        sourceType: 'verified-adapter',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        effect: { classification: 'read', externalStateChange: false },
      },
      {
        name: 'like_post',
        title: 'Like post',
        description: 'Prepare a like for the current post.',
        classification: 'mutate',
        requiresApproval: true,
        sourceType: 'verified-adapter',
        inputSchema: { type: 'object', properties: { enabled: { type: 'boolean' } }, required: ['enabled'], additionalProperties: false },
        effect: { classification: 'mutation', externalStateChange: true },
      },
    ],
    pendingActions: [],
    receipts: [],
    ...overrides,
  };
}

test('lists exact-bound MCP proxies and routes reads without exposing mutation authority', async () => {
  let state = pageState();
  const calls = [];
  const endpoint = createExtensionMcpEndpoint({
    getState: async () => ({ ok: true, state: structuredClone(state) }),
    executeRead: async (payload) => {
      calls.push({ kind: 'read', payload });
      return { ok: true, result: { status: 'read-completed', data: { text: 'hello' } } };
    },
    prepareAction: async (payload) => {
      calls.push({ kind: 'prepare', payload });
      return { ok: true, result: { status: 'approval-required' }, preparedAction: { actionId: 'action-7' } };
    },
  });

  const listed = await endpoint.handle('tools.list', {});
  assert.equal(listed.tools.length, 2);
  assert.equal(listed.context.page.origin, 'https://example.test');
  const read = listed.tools.find((tool) => tool._meta['toolbraid/originalName'] === 'read_post');
  const mutation = listed.tools.find((tool) => tool._meta['toolbraid/originalName'] === 'like_post');
  assert.match(read.name, /^toolbraid\.read_post\.[a-f0-9]{16}$/);
  assert.equal(read.annotations.readOnlyHint, true);
  assert.equal(mutation.annotations.readOnlyHint, false);
  assert.match(mutation.description, /human must approve and dispatch/i);

  const readResult = await endpoint.handle('tools.call', { name: read.name, arguments: {} });
  assert.equal(readResult.result.status, 'read-completed');
  assert.deepEqual(calls[0], {
    kind: 'read',
    payload: { targetTabId: 42, targetWindowId: 8, toolId: 'read_post', arguments: {} },
  });

  const prepared = await endpoint.handle('tools.call', { name: mutation.name, arguments: { enabled: true } });
  assert.equal(prepared.result.status, 'approval-required');
  assert.deepEqual(calls[1], {
    kind: 'prepare',
    payload: { targetTabId: 42, targetWindowId: 8, actionId: 'like_post', arguments: { enabled: true } },
  });

  state = pageState({ snapshot: { pageFingerprint: 'fingerprint-drift-9876' } });
  await assert.rejects(
    endpoint.handle('tools.call', { name: read.name, arguments: {} }),
    (error) => error.code === 'MCP_PAGE_BINDING_DRIFT',
  );
});

test('invalidates handles and notifies only after a listed tool surface existed', async () => {
  const endpoint = createExtensionMcpEndpoint({
    getState: async () => ({ ok: true, state: pageState() }),
    executeRead: async () => ({ ok: true }),
    prepareAction: async () => ({ ok: true }),
  });
  let notifications = 0;
  endpoint.onToolsChanged(() => { notifications += 1; });
  endpoint.invalidate();
  assert.equal(notifications, 0);
  await endpoint.listTools();
  endpoint.invalidate();
  assert.equal(notifications, 1);
  assert.equal(endpoint.handleCount(), 0);
});

test('native port accepts only the bounded allowlisted protocol', async () => {
  const messageListeners = [];
  const disconnectListeners = [];
  const posted = [];
  const port = {
    onMessage: { addListener(listener) { messageListeners.push(listener); } },
    onDisconnect: { addListener(listener) { disconnectListeners.push(listener); } },
    postMessage(message) { posted.push(message); },
    disconnect() {},
  };
  const endpoint = {
    onToolsChanged() { return () => {}; },
    handle: async (method) => ({ method, connected: true }),
  };
  const bridge = installNativeMcpBridge({
    chromeApi: { runtime: { connectNative: () => port } },
    endpoint,
    schedule: () => 1,
  });
  assert.equal(bridge.state().connected, true);
  assert.equal(posted[0].event, 'extension_ready');

  messageListeners[0]({ protocol: 'wrong', version: 1, kind: 'request', requestId: 'x', method: 'bridge.status', params: {} });
  await Promise.resolve();
  assert.equal(posted.length, 1);

  messageListeners[0]({
    protocol: NATIVE_MCP_PROTOCOL,
    version: NATIVE_MCP_VERSION,
    kind: 'request',
    requestId: 'request-1',
    method: 'bridge.status',
    params: {},
  });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(posted.at(-1).kind, 'response');
  assert.equal(posted.at(-1).ok, true);
  assert.equal(posted.at(-1).result.connected, true);
  bridge.stop();
});
