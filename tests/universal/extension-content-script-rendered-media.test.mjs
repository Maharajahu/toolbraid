import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const protocolSource = await readFile(new URL('../../extension/protocol-runtime.js', import.meta.url), 'utf8');
const contentSource = await readFile(new URL('../../extension/content-script.js', import.meta.url), 'utf8');

const binding = Object.freeze({
  nonce: '12345678-1234-4234-8234-123456789abc',
  sessionId: 'tab-7-rendered-media-session',
  tabId: 7,
  frameId: 0,
});

function harness() {
  const sandbox = {
    AbortController,
    Map,
    Promise,
    Set,
    Uint8Array,
    btoa,
    clearInterval() {},
    clearTimeout() {},
    crypto: webcrypto,
    setInterval() { return 1; },
    setTimeout() { return 1; },
  };
  const context = vm.createContext(sandbox);
  vm.runInContext(`
    globalThis.window = globalThis;
    globalThis.location = { href: 'https://example.test/watch', origin: 'https://example.test' };
    globalThis.document = { documentElement: {} };
    globalThis.__tbFingerprint = '${'f'.repeat(64)}';
    globalThis.addEventListener = () => {};
    globalThis.postMessage = () => {};
    globalThis.MutationObserver = class { observe() {} disconnect() {} };
  `, context);
  vm.runInContext(protocolSource, context, { filename: 'protocol-runtime.js' });
  context.__bindingJson = JSON.stringify(binding);
  const channel = vm.runInContext(`ToolBraidUniversalProtocol.createEnvelope(
    ToolBraidUniversalProtocol.TYPES.CHANNEL_INIT,
    { provenance: ToolBraidUniversalProtocol.PROVENANCE },
    JSON.parse(__bindingJson),
  )`, context);
  context.ToolBraidUniversalPageExtractor = {
    extractPageSnapshot() { return { pageFingerprint: context.__tbFingerprint }; },
  };
  context.chrome = {
    runtime: {
      lastError: undefined,
      onMessage: { addListener(listener) { context.__runtimeListener = listener; } },
      sendMessage(message, callback) {
        if (message.type === context.ToolBraidUniversalProtocol.TYPES.PAGE_READY) {
          callback({
            ok: true,
            channel,
          });
          return;
        }
        if (message.type === context.ToolBraidUniversalProtocol.TYPES.PAGE_SNAPSHOT) callback({ ok: true });
      },
    },
  };
  vm.runInContext(`
    globalThis.ToolBraidRenderedMediaCapture = {
      captureRenderedMedia() {
        globalThis.__lastBytes = new Uint8Array([1, 2, 3, 4]);
        return Promise.resolve({
          ok: true,
          code: 'CAPTURE_OK',
          metadata: {
            elementRef: 'id:video',
            sourceKind: 'video',
            pageOrigin: 'https://example.test',
            mimeType: 'audio/webm',
            byteLength: 4,
          },
          captions: [],
          bytes: globalThis.__lastBytes,
        });
      },
      readLoadedCaptions() {
        return { ok: true, code: 'CAPTIONS_EMPTY', metadata: {
          elementRef: 'id:video', sourceKind: 'video', pageOrigin: 'https://example.test'
        }, captions: [], bytes: new Uint8Array(0) };
      },
    };
  `, context);
  vm.runInContext(contentSource, context, { filename: 'content-script.js' });
  return context;
}

function request(context, overrides = {}) {
  return {
    type: context.ToolBraidUniversalProtocol.TYPES.PAGE_CAPTURE_RENDERED_MEDIA,
    ...binding,
    requestId: 'rendered-request-1',
    mode: 'audio',
    elementRef: 'id:video',
    kind: 'video',
    pageInstanceId: context.__TOOLBRAID_UNIVERSAL_CONTENT__.pageInstanceId,
    documentId: 'document-rendered-media',
    pageFingerprint: 'c'.repeat(64),
    extractorPageFingerprint: 'f'.repeat(64),
    durationMs: 5,
    maxBytes: 1024,
    maxTracks: 8,
    maxCues: 32,
    maxCaptionBytes: 4096,
    provenance: context.ToolBraidUniversalProtocol.PROVENANCE,
    ...overrides,
  };
}

function dispatch(context, message) {
  return new Promise((resolve) => {
    assert.equal(context.__runtimeListener(message, {}, resolve), true);
  });
}

test('content relay binds rendered capture and transports bytes as bounded base64', async () => {
  const context = harness();
  const response = await dispatch(context, request(context));

  assert.equal(response.ok, true);
  assert.equal(response.result.audioBase64, 'AQIDBA==');
  assert.equal(Object.hasOwn(response.result, 'bytes'), false);
  assert.deepEqual(Array.from(context.__lastBytes), [0, 0, 0, 0]);
  assert.equal(response.requestId, 'rendered-request-1');
  assert.equal(response.tabId, binding.tabId);
  assert.equal(response.frameId, binding.frameId);
  assert.equal(response.sessionId, binding.sessionId);
  assert.equal(response.nonce, binding.nonce);
  assert.equal(response.pageFingerprint, 'c'.repeat(64));
  assert.equal(response.extractorPageFingerprint, 'f'.repeat(64));
});

test('content relay discards bytes when the page fingerprint changes in flight', async () => {
  const context = harness();
  const pending = dispatch(context, request(context));
  context.__tbFingerprint = 'e'.repeat(64);
  const response = await pending;

  assert.equal(response.ok, false);
  assert.equal(response.error.code, 'CAPTURE_PAGE_DRIFT');
  assert.deepEqual(Array.from(context.__lastBytes), [0, 0, 0, 0]);
});

test('content relay rejects forged session bindings before media capture', async () => {
  const context = harness();
  let response;
  const keepAlive = context.__runtimeListener(request(context, { sessionId: 'tab-7-forged-session' }), {}, (value) => { response = value; });

  assert.equal(keepAlive, false);
  assert.equal(response.ok, false);
  assert.equal(response.error.code, 'BINDING_MISMATCH');
  assert.equal(context.__lastBytes, undefined);
});

test('content relay enforces fixed media caps before invoking page capture', () => {
  const context = harness();
  let response;
  const keepAlive = context.__runtimeListener(request(context, { maxBytes: (4 * 1024 * 1024) + 1 }), {}, (value) => { response = value; });

  assert.equal(keepAlive, false);
  assert.equal(response.ok, false);
  assert.equal(response.error.code, 'CAPTURE_REQUEST_INVALID');
  assert.equal(context.__lastBytes, undefined);
});

test('channel close aborts and clears an in-flight rendered capture', async () => {
  const context = harness();
  vm.runInContext(`
    ToolBraidRenderedMediaCapture.captureRenderedMedia = ({ signal }) => new Promise((resolve) => {
      signal.addEventListener('abort', () => {
        globalThis.__captureAborted = true;
        globalThis.__lastBytes = new Uint8Array([7, 7, 7, 7]);
        resolve({
          ok: true,
          metadata: { elementRef: 'id:video', sourceKind: 'video', pageOrigin: location.origin, mimeType: 'audio/webm', byteLength: 4 },
          captions: [],
          bytes: globalThis.__lastBytes,
        });
      }, { once: true });
    });
  `, context);
  const pending = dispatch(context, request(context));
  context.__runtimeListener({ type: context.ToolBraidUniversalProtocol.TYPES.CHANNEL_CLOSE }, {}, () => {});
  const response = await pending;

  assert.equal(response.ok, false);
  assert.equal(response.error.code, 'CAPTURE_SESSION_DRIFT');
  assert.equal(context.__captureAborted, true);
  assert.equal(context.__TOOLBRAID_UNIVERSAL_CONTENT__.renderedCaptureControllers.size, 0);
  assert.deepEqual(Array.from(context.__lastBytes), [0, 0, 0, 0]);
});
