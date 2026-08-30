import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { installServiceWorker } from '../../extension/service-worker.js';

const protocolSource = await readFile(new URL('../../extension/protocol-runtime.js', import.meta.url), 'utf8');
const contentScriptSource = await readFile(new URL('../../extension/content-script.js', import.meta.url), 'utf8');

const firstBinding = {
  nonce: '12345678-1234-4234-8234-123456789abc',
  sessionId: 'tab-7-session-one-abcdefgh',
  tabId: 7,
  frameId: 0,
};
const nextBinding = {
  nonce: 'abcdefab-cdef-4abc-8def-abcdefabcdef',
  sessionId: 'tab-7-session-two-abcdefgh',
  tabId: 7,
  frameId: 0,
};

function makeChannel(context, binding) {
  context.__tbBindingJson = JSON.stringify(binding);
  return vm.runInContext(`ToolBraidUniversalProtocol.createEnvelope(
    ToolBraidUniversalProtocol.TYPES.CHANNEL_INIT,
    { provenance: ToolBraidUniversalProtocol.PROVENANCE },
    JSON.parse(__tbBindingJson),
  )`, context);
}

function makePageEnvelope(context, type, binding, payload, requestId = null) {
  context.__tbBindingJson = JSON.stringify(binding);
  context.__tbPayloadJson = JSON.stringify(payload);
  context.__tbType = type;
  context.__tbRequestId = requestId;
  return vm.runInContext(`ToolBraidUniversalProtocol.createEnvelope(
    __tbType,
    JSON.parse(__tbPayloadJson),
    JSON.parse(__tbBindingJson),
    __tbRequestId,
  )`, context);
}

function makeHarness({ readyResponses, onSnapshot, onPageEvent } = {}) {
  const timers = [];
  const sent = [];
  const posts = [];
  const snapshots = [];
  const pageEvents = [];
  const ports = [];
  const sandbox = {
    Map,
    Promise,
    Set,
    clearInterval() {},
    clearTimeout(id) {
      const timer = timers.find((entry) => entry.id === id);
      if (timer) timer.cleared = true;
    },
    crypto: webcrypto,
    setInterval() {
      return 1;
    },
    setTimeout(callback, delay) {
      const timer = { id: timers.length + 1, callback, delay, cleared: false, fired: false };
      timers.push(timer);
      return timer.id;
    },
  };
  const context = vm.createContext(sandbox);
  vm.runInContext(`
    globalThis.window = globalThis;
    globalThis.location = { href: 'https://example.test/page', origin: 'https://example.test' };
    globalThis.document = { documentElement: {} };
    globalThis.addEventListener = (type, listener) => {
      if (type === 'message') globalThis.__tbWindowListener = listener;
    };
    globalThis.postMessage = (message, targetOrigin) => globalThis.__tbPosts(message, targetOrigin);
    globalThis.MutationObserver = class {
      observe() {}
      disconnect() {}
    };
  `, context);
  context.__tbPosts = (message, targetOrigin) => posts.push({ message, targetOrigin });
  vm.runInContext(protocolSource, context, { filename: 'protocol-runtime.js' });
  context.ToolBraidUniversalPageExtractor = {
    extractPageSnapshot() {
      return { pageFingerprint: 'f'.repeat(64), mainText: 'Current page' };
    },
  };
  context.chrome = {
    runtime: {
      id: 'toolbraid-test-extension',
      getManifest() { return { manifest_version: 3 }; },
      lastError: undefined,
      onMessage: { addListener(listener) { context.__tbRuntimeListener = listener; } },
      connect({ name }) {
        const disconnectListeners = [];
        const messageListeners = [];
        const port = {
          name,
          disconnected: false,
          onDisconnect: { addListener(listener) { disconnectListeners.push(listener); } },
          onMessage: { addListener(listener) { messageListeners.push(listener); } },
          postMessage(message) {
            if (port.disconnected) throw new Error('Port is disconnected.');
            sent.push(message);
            if (message.type !== context.ToolBraidUniversalProtocol.TYPES.PAGE_READY) return;
            const response = readyResponses.shift();
            const value = response?.binding
              ? { ok: true, channel: makeChannel(context, response.binding), reused: response.reused === true }
              : response;
            for (const listener of messageListeners) listener(value);
          },
          disconnect() {
            if (port.disconnected) return;
            port.disconnected = true;
            for (const listener of disconnectListeners) listener();
          },
        };
        ports.push(port);
        return port;
      },
      sendMessage(message, callback) {
        sent.push(message);
        if (message.type === context.ToolBraidUniversalProtocol.TYPES.PAGE_READY) {
          const response = readyResponses.shift();
          callback(response?.binding
            ? { ok: true, channel: makeChannel(context, response.binding), reused: response.reused === true }
            : response);
          return;
        }
        if (message.type === context.ToolBraidUniversalProtocol.TYPES.PAGE_SNAPSHOT) {
          snapshots.push(message);
          callback(onSnapshot?.(message, snapshots.length) ?? { ok: true });
          return;
        }
        if (message.type === context.ToolBraidUniversalProtocol.TYPES.PAGE_EVENT) {
          pageEvents.push(message);
          context.__tbResponseJson = JSON.stringify(onPageEvent?.(message, pageEvents.length) ?? { ok: true });
          callback(vm.runInContext('JSON.parse(__tbResponseJson)', context));
        }
      },
    },
  };

  vm.runInContext(contentScriptSource, context, { filename: 'content-script.js' });

  return {
    context,
    pageEvents,
    posts,
    ports,
    sent,
    snapshots,
    timers,
    fireNext(delay) {
      const timer = timers.find((entry) => !entry.cleared && !entry.fired && entry.delay === delay);
      assert.ok(timer, `expected a pending ${delay}ms timer`);
      timer.fired = true;
      timer.callback();
    },
    dispatch(envelope) {
      context.__tbMessage = envelope;
      vm.runInContext(`__tbWindowListener({
        source: globalThis.window,
        origin: globalThis.location.origin,
        data: __tbMessage,
      })`, context);
    },
    disconnectLifecyclePort(index = ports.length - 1) {
      ports[index]?.disconnect();
    },
  };
}

test('serializes a moderate PAGE_READY heartbeat and leaves a reused binding untouched', () => {
  const readyResponses = [
    { binding: firstBinding, reused: false },
    { binding: firstBinding, reused: true },
  ];
  const harness = makeHarness({ readyResponses });
  const { context } = harness;

  assert.equal(harness.sent.filter((message) => message.type === context.ToolBraidUniversalProtocol.TYPES.PAGE_READY).length, 1);
  assert.equal(harness.snapshots.length, 1);
  assert.equal(harness.posts.length, 1);
  assert.ok(harness.timers.some((timer) => timer.delay === 20_000));

  harness.fireNext(20_000);

  assert.equal(harness.sent.filter((message) => message.type === context.ToolBraidUniversalProtocol.TYPES.PAGE_READY).length, 2);
  assert.equal(harness.snapshots.length, 1);
  assert.equal(harness.posts.length, 1);
  assert.ok(harness.timers.some((timer) => !timer.fired && !timer.cleared && timer.delay === 20_000));
});

test('SESSION_NOT_FOUND on a snapshot replaces the binding in MAIN and publishes a fresh snapshot', () => {
  const readyResponses = [
    { binding: firstBinding, reused: false },
    { binding: nextBinding, reused: false },
  ];
  const harness = makeHarness({
    readyResponses,
    onSnapshot(_message, count) {
      return count === 1
        ? { ok: false, error: { code: 'SESSION_NOT_FOUND', message: 'worker restarted' } }
        : { ok: true };
    },
  });
  const { context } = harness;

  assert.equal(harness.snapshots.length, 2);
  assert.equal(harness.snapshots[0].sessionId, firstBinding.sessionId);
  assert.equal(harness.snapshots[1].sessionId, nextBinding.sessionId);
  assert.equal(harness.snapshots[1].reason, 'activation');
  assert.deepEqual(
    harness.posts.map(({ message }) => message.type),
    [
      context.ToolBraidUniversalProtocol.TYPES.CHANNEL_INIT,
      context.ToolBraidUniversalProtocol.TYPES.CHANNEL_CLOSE,
      context.ToolBraidUniversalProtocol.TYPES.CHANNEL_INIT,
    ],
  );
  assert.equal(harness.posts[1].message.sessionId, firstBinding.sessionId);
  assert.equal(harness.posts[1].message.nonce, firstBinding.nonce);
  assert.equal(harness.posts[2].message.sessionId, nextBinding.sessionId);
});

test('SESSION_NOT_FOUND fails an in-flight mutation once and re-handshakes without replay', () => {
  const readyResponses = [
    { binding: firstBinding, reused: false },
    { binding: nextBinding, reused: false },
  ];
  const harness = makeHarness({
    readyResponses,
    onPageEvent() {
      return { ok: false, error: { code: 'SESSION_NOT_FOUND', message: 'worker restarted' } };
    },
  });
  const { context } = harness;
  const request = makePageEnvelope(
    context,
    context.ToolBraidUniversalProtocol.TYPES.EXECUTE_REQUEST,
    firstBinding,
    { toolId: 'mutate_page', input: { value: 'approved change' } },
    'request-mutation-abcdefgh',
  );

  harness.dispatch(request);

  assert.equal(harness.pageEvents.length, 1);
  assert.equal(harness.pageEvents[0].envelope.requestId, 'request-mutation-abcdefgh');
  assert.equal(harness.sent.filter((message) => message.type === context.ToolBraidUniversalProtocol.TYPES.PAGE_EVENT).length, 1);
  const result = harness.posts.find(({ message }) => message.type === context.ToolBraidUniversalProtocol.TYPES.EXECUTE_RESULT);
  assert.ok(result);
  assert.equal(result.message.sessionId, firstBinding.sessionId);
  assert.equal(result.message.payload.ok, false);
  assert.equal(result.message.payload.error.code, 'SESSION_NOT_FOUND');
  assert.equal(context.__TOOLBRAID_UNIVERSAL_CONTENT__.session.sessionId, nextBinding.sessionId);
});

test('an invalidated extension context does not throw from an old page event listener', () => {
  const harness = makeHarness({ readyResponses: [{ binding: firstBinding, reused: false }] });
  const { context } = harness;
  context.chrome.runtime.sendMessage = () => {
    throw new Error('Extension context invalidated.');
  };
  const ready = makePageEnvelope(
    context,
    context.ToolBraidUniversalProtocol.TYPES.MAIN_READY,
    firstBinding,
    { provenance: context.ToolBraidUniversalProtocol.PROVENANCE },
  );

  assert.doesNotThrow(() => harness.dispatch(ready));
});

test('an invalidated runtime without an extension id is ignored before sendMessage', () => {
  const harness = makeHarness({ readyResponses: [{ binding: firstBinding, reused: false }] });
  const { context } = harness;
  let calls = 0;
  delete context.chrome.runtime.id;
  context.chrome.runtime.sendMessage = () => {
    calls += 1;
    throw new Error('Extension context invalidated.');
  };
  const ready = makePageEnvelope(
    context,
    context.ToolBraidUniversalProtocol.TYPES.MAIN_READY,
    firstBinding,
    { provenance: context.ToolBraidUniversalProtocol.PROVENANCE },
  );

  assert.doesNotThrow(() => harness.dispatch(ready));
  assert.equal(calls, 0);
});

test('an invalidated runtime that rejects getManifest is ignored before sendMessage', () => {
  const harness = makeHarness({ readyResponses: [{ binding: firstBinding, reused: false }] });
  const { context } = harness;
  let calls = 0;
  context.chrome.runtime.getManifest = () => { throw new Error('Extension context invalidated.'); };
  context.chrome.runtime.sendMessage = () => {
    calls += 1;
    throw new Error('Extension context invalidated.');
  };
  const ready = makePageEnvelope(
    context,
    context.ToolBraidUniversalProtocol.TYPES.MAIN_READY,
    firstBinding,
    { provenance: context.ToolBraidUniversalProtocol.PROVENANCE },
  );

  assert.doesNotThrow(() => harness.dispatch(ready));
  assert.equal(calls, 0);
});

test('an invalidated extension context does not throw from a late page event callback', () => {
  const harness = makeHarness({ readyResponses: [{ binding: firstBinding, reused: false }] });
  const { context } = harness;
  let reply = null;
  context.chrome.runtime.sendMessage = (_message, callback) => { reply = callback; };
  const ready = makePageEnvelope(
    context,
    context.ToolBraidUniversalProtocol.TYPES.MAIN_READY,
    firstBinding,
    { provenance: context.ToolBraidUniversalProtocol.PROVENANCE },
  );
  harness.dispatch(ready);
  Object.defineProperty(context.chrome, 'runtime', {
    configurable: true,
    get() { throw new Error('Extension context invalidated.'); },
  });

  assert.equal(typeof reply, 'function');
  assert.doesNotThrow(() => reply({ ok: true }));
});

test('a rejected runtime message promise is consumed after an extension reload', () => {
  const harness = makeHarness({ readyResponses: [{ binding: firstBinding, reused: false }] });
  const { context } = harness;
  let caught = 0;
  context.chrome.runtime.sendMessage = () => ({
    catch(handler) {
      caught += 1;
      handler(new Error('Extension context invalidated.'));
    },
  });
  const ready = makePageEnvelope(
    context,
    context.ToolBraidUniversalProtocol.TYPES.MAIN_READY,
    firstBinding,
    { provenance: context.ToolBraidUniversalProtocol.PROVENANCE },
  );

  harness.dispatch(ready);

  assert.equal(caught, 1);
});

test('an explicit CHANNEL_CLOSE cancels the heartbeat instead of resurrecting authority', () => {
  const harness = makeHarness({ readyResponses: [{ binding: firstBinding, reused: false }] });
  const { context } = harness;
  context.__tbRuntimeListener({ type: context.ToolBraidUniversalProtocol.TYPES.CHANNEL_CLOSE }, {}, () => {});

  assert.equal(context.__TOOLBRAID_UNIVERSAL_CONTENT__.session, null);
  assert.equal(context.__TOOLBRAID_UNIVERSAL_CONTENT__.readyEnabled, false);
  assert.equal(harness.ports[0].disconnected, true);
  assert.equal(
    harness.timers.filter((timer) => timer.delay === 20_000 && !timer.fired && !timer.cleared).length,
    0,
  );
});

test('a worker Port disconnect after the sidepanel closes rebinds before the next native invocation', () => {
  const harness = makeHarness({
    readyResponses: [
      { binding: firstBinding, reused: false },
      { binding: nextBinding, reused: false },
    ],
  });
  const { context } = harness;

  assert.equal(harness.ports.length, 1);
  harness.disconnectLifecyclePort();
  harness.fireNext(250);

  assert.equal(harness.ports.length, 2);
  assert.equal(context.__TOOLBRAID_UNIVERSAL_CONTENT__.session.sessionId, nextBinding.sessionId);
  assert.equal(harness.pageEvents.length, 0);
  assert.equal(harness.snapshots.length, 2);
  assert.deepEqual(
    harness.posts.map(({ message }) => message.type),
    [
      context.ToolBraidUniversalProtocol.TYPES.CHANNEL_INIT,
      context.ToolBraidUniversalProtocol.TYPES.CHANNEL_CLOSE,
      context.ToolBraidUniversalProtocol.TYPES.CHANNEL_INIT,
    ],
  );
});

test('the lifecycle Port accepts only the exact extension content-script sender', async () => {
  let connectListener;
  const chromeApi = {
    runtime: {
      id: 'toolbraid-extension-id',
      onMessage: { addListener() {} },
      onConnect: { addListener(listener) { connectListener = listener; } },
    },
    action: { onClicked: { addListener() {} } },
    tabs: {
      onUpdated: { addListener() {} },
      onRemoved: { addListener() {} },
    },
  };
  installServiceWorker(chromeApi);
  assert.equal(typeof connectListener, 'function');

  let validDisconnected = false;
  let validMessageListener;
  let validResponse;
  connectListener({
    name: 'toolbraid:page-lifecycle',
    sender: {
      id: chromeApi.runtime.id,
      url: 'https://example.test/page',
      tab: { id: 7, url: 'https://example.test/page' },
      frameId: 0,
    },
    onMessage: { addListener(listener) { validMessageListener = listener; } },
    postMessage(response) { validResponse = response; },
    disconnect() { validDisconnected = true; },
  });
  assert.equal(validDisconnected, false);
  assert.equal(typeof validMessageListener, 'function');
  validMessageListener({ type: 'toolbraid:page-ready', pageInstanceId: 'page-0123456789abcdef' });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(validResponse?.ok, true);

  let forgedDisconnected = false;
  connectListener({
    name: 'toolbraid:page-lifecycle',
    sender: {
      id: 'other-extension',
      url: 'https://example.test/page',
      tab: { id: 7, url: 'https://example.test/page' },
      frameId: 0,
    },
    disconnect() { forgedDisconnected = true; },
  });
  assert.equal(forgedDisconnected, true);
});
