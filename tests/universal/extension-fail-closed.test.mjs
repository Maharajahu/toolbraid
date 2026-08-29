import assert from 'node:assert/strict';
import test from 'node:test';

import { MESSAGE_TYPES, PROVENANCE, parseEnvelope } from '../../extension/protocol.js';
import { TabLifecycleRegistry } from '../../extension/lifecycle.js';
import { createServiceWorkerController } from '../../extension/service-worker.js';

const EXTENSION_ID = 'toolbraid-test-extension';
const PAGE = 'https://example.test/workspace';
const TOOLS = [{
  id: 'workspace.inspect',
  name: 'workspace.inspect',
  description: 'Inspect the current workspace.',
  inputSchema: { type: 'object', properties: {} },
}];

function mockChrome() {
  const calls = [];
  return {
    calls,
    api: {
      runtime: { id: EXTENSION_ID },
      tabs: {
        sendMessage: async (tabId, message, options) => {
          calls.push({ operation: 'sendMessage', tabId, message, options });
          return undefined;
        },
      },
      scripting: {
        executeScript: async (details) => {
          calls.push({ operation: 'executeScript', details });
          return [];
        },
      },
    },
  };
}

function pageSender() {
  return {
    id: EXTENSION_ID,
    tab: { id: 7, url: PAGE },
    frameId: 0,
    url: PAGE,
    documentId: 'document-0123456789abcdef',
  };
}

function bridgeSender() {
  return { id: EXTENSION_ID, url: `chrome-extension://${EXTENSION_ID}/bridge.html` };
}

async function ready(controller) {
  const response = await controller.handleRuntimeMessage({
    type: MESSAGE_TYPES.PAGE_READY,
    pageInstanceId: 'page-0123456789abcdef',
  }, pageSender());
  assert.equal(response.ok, true);
  return response.channel;
}

test('registration fails closed until a live tab session exists', async () => {
  const { api } = mockChrome();
  const controller = createServiceWorkerController({ chromeApi: api });
  const response = await controller.handleRuntimeMessage({
    type: MESSAGE_TYPES.BRIDGE_REGISTER_TOOLS,
    tabId: 7,
    tools: TOOLS,
  }, bridgeSender());
  assert.equal(response.ok, false);
  assert.equal(response.error.code, 'SESSION_NOT_FOUND');
});

test('bridge accepts generated descriptions only from the extension and routes them to content', async () => {
  const { api, calls } = mockChrome();
  const controller = createServiceWorkerController({ chromeApi: api });
  await ready(controller);
  const response = await controller.handleRuntimeMessage({
    type: MESSAGE_TYPES.BRIDGE_REGISTER_TOOLS,
    tabId: 7,
    tools: TOOLS,
  }, bridgeSender());
  assert.equal(response.ok, true);
  assert.equal(response.count, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].message.type, MESSAGE_TYPES.REGISTER_TOOLS);
  assert.equal(calls[0].message.payload.provenance, PROVENANCE);
  assert.equal(calls[0].message.payload.tools[0].annotations.provenance, PROVENANCE);

  const forged = await controller.handleRuntimeMessage({
    type: MESSAGE_TYPES.BRIDGE_REGISTER_TOOLS,
    tabId: 7,
    tools: TOOLS,
  }, { id: 'other-extension', url: `chrome-extension://${EXTENSION_ID}/bridge.html` });
  assert.equal(forged.ok, false);
  assert.equal(forged.error.code, 'BRIDGE_SENDER_INVALID');
});

test('page execution returns a bound fail-closed error when no executor is attached', async () => {
  const { api } = mockChrome();
  const controller = createServiceWorkerController({ chromeApi: api });
  const channel = await ready(controller);
  const request = {
    channel: channel.channel,
    version: channel.version,
    type: MESSAGE_TYPES.EXECUTE_REQUEST,
    nonce: channel.nonce,
    sessionId: channel.sessionId,
    tabId: channel.tabId,
    frameId: channel.frameId,
    requestId: 'req-0123456789abcdef',
    payload: { toolId: 'workspace.inspect', name: 'workspace.inspect', input: {} },
  };
  const response = await controller.handleRuntimeMessage({ type: MESSAGE_TYPES.PAGE_EVENT, envelope: request }, pageSender());
  assert.equal(response.ok, true);
  const result = parseEnvelope(response.envelope, {
    nonce: channel.nonce,
    sessionId: channel.sessionId,
    tabId: channel.tabId,
    frameId: channel.frameId,
  });
  assert.equal(result.ok, true);
  assert.equal(result.value.type, MESSAGE_TYPES.EXECUTE_RESULT);
  assert.equal(result.value.payload.ok, false);
  assert.equal(result.value.payload.error.code, 'EXECUTOR_UNAVAILABLE');

  const stale = await controller.handleRuntimeMessage({
    type: MESSAGE_TYPES.PAGE_EVENT,
    envelope: { ...request, nonce: 'forged-nonce-0123456789' },
  }, pageSender());
  assert.equal(stale.ok, false);
  assert.equal(stale.error.code, 'BINDING_MISMATCH');
});

test('cross-origin navigation invalidates the old session before any further bridge operation', async () => {
  const { api } = mockChrome();
  const controller = createServiceWorkerController({ chromeApi: api });
  await ready(controller);
  controller.handleTabUpdated(
    7,
    { status: 'loading', url: 'https://other.test/next' },
    { pendingUrl: 'https://other.test/next' },
  );
  const response = await controller.handleRuntimeMessage({
    type: MESSAGE_TYPES.BRIDGE_REGISTER_TOOLS,
    tabId: 7,
    tools: TOOLS,
  }, bridgeSender());
  assert.equal(response.ok, false);
  assert.equal(response.error.code, 'SESSION_NOT_FOUND');
});

test('a same-document URL update preserves the document-bound session for fingerprint drift handling', async () => {
  const { api } = mockChrome();
  const controller = createServiceWorkerController({ chromeApi: api });
  const channel = await ready(controller);

  const invalidated = controller.handleTabUpdated(7, {
    status: 'loading',
    url: 'https://example.test/workspace/detail',
  }, { url: 'https://example.test/workspace/detail' });

  assert.deepEqual(invalidated, []);
  assert.equal(controller.registry.get(7)?.sessionId, channel.sessionId);
});

test('a same-origin document navigation replaces authority when the new document announces itself', async () => {
  const { api } = mockChrome();
  const controller = createServiceWorkerController({ chromeApi: api });
  const first = await ready(controller);
  const preserved = controller.handleTabUpdated(7, {
    status: 'loading',
    url: 'https://example.test/next',
  }, { url: 'https://example.test/next' });
  assert.deepEqual(preserved, []);

  const next = await controller.handleRuntimeMessage({
    type: MESSAGE_TYPES.PAGE_READY,
    pageInstanceId: 'page-fedcba9876543210',
  }, {
    ...pageSender(),
    documentId: 'document-fedcba9876543210',
    url: 'https://example.test/next',
    tab: { id: 7, url: 'https://example.test/next' },
  });

  assert.equal(next.ok, true);
  assert.equal(next.reused, false);
  assert.notEqual(next.channel.sessionId, first.sessionId);
  assert.equal(controller.registry.get(7)?.sessionId, next.channel.sessionId);
});

test('activation refuses non-HTTP(S) pages and only then injects explicit worlds', async () => {
  const { api, calls } = mockChrome();
  const controller = createServiceWorkerController({ chromeApi: api });
  const blocked = await controller.activateTab({ id: 7, url: 'chrome://settings/' });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.error.code, 'URL_NOT_INJECTABLE');
  assert.equal(calls.length, 0);

  const active = await controller.activateTab({ id: 7, url: PAGE });
  assert.equal(active.ok, true);
  assert.deepEqual(calls.map((call) => call.details.world), ['MAIN', 'ISOLATED']);
  assert.deepEqual(calls.map((call) => call.details.target), [{ tabId: 7, frameIds: [0] }, { tabId: 7, frameIds: [0] }]);
});
