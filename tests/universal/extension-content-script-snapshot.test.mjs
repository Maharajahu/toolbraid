import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const protocolSource = await readFile(new URL('../../extension/protocol-runtime.js', import.meta.url), 'utf8');
const contentScriptSource = await readFile(new URL('../../extension/content-script.js', import.meta.url), 'utf8');

test('retries an unacknowledged snapshot fingerprint and caches it only after acknowledgement', () => {
  const fingerprint = 'f'.repeat(64);
  const snapshotMessages = [];
  const snapshotCallbacks = [];
  const intervalCallbacks = [];
  const sandbox = {
    Map,
    Promise,
    Set,
    clearInterval() {},
    clearTimeout() {},
    crypto: webcrypto,
    setInterval(callback) {
      intervalCallbacks.push(callback);
      return intervalCallbacks.length;
    },
    setTimeout() {
      return 1;
    },
  };
  const context = vm.createContext(sandbox);
  vm.runInContext(`
    globalThis.window = globalThis;
    globalThis.location = { href: 'https://example.test/page', origin: 'https://example.test' };
    globalThis.document = { documentElement: {} };
    globalThis.addEventListener = () => {};
    globalThis.postMessage = () => {};
    globalThis.MutationObserver = class {
      observe() {}
      disconnect() {}
    };
  `, context);
  vm.runInContext(protocolSource, context, { filename: 'protocol-runtime.js' });
  const channel = vm.runInContext(`ToolBraidUniversalProtocol.createEnvelope(
    ToolBraidUniversalProtocol.TYPES.CHANNEL_INIT,
    { provenance: ToolBraidUniversalProtocol.PROVENANCE },
    {
      nonce: '12345678-1234-4234-8234-123456789abc',
      sessionId: 'tab-7-snapshot-retry',
      tabId: 7,
      frameId: 0,
    },
  )`, context);

  context.ToolBraidUniversalPageExtractor = {
    extractPageSnapshot() {
      return { pageFingerprint: fingerprint };
    },
  };
  context.chrome = {
    runtime: {
      lastError: undefined,
      onMessage: { addListener() {} },
      sendMessage(message, callback) {
        if (message.type === context.ToolBraidUniversalProtocol.TYPES.PAGE_READY) {
          callback({ ok: true, channel });
          return;
        }
        if (message.type === context.ToolBraidUniversalProtocol.TYPES.PAGE_SNAPSHOT) {
          snapshotMessages.push(message);
          snapshotCallbacks.push(callback);
        }
      },
    },
  };

  vm.runInContext(contentScriptSource, context, { filename: 'content-script.js' });

  assert.equal(snapshotMessages.length, 1);
  assert.equal(context.__TOOLBRAID_UNIVERSAL_CONTENT__.lastSnapshotFingerprint, null);

  snapshotCallbacks[0]({ ok: false });
  assert.equal(context.__TOOLBRAID_UNIVERSAL_CONTENT__.lastSnapshotFingerprint, null);

  intervalCallbacks[0]();
  assert.equal(snapshotMessages.length, 2);
  assert.equal(snapshotMessages[1].snapshot.pageFingerprint, snapshotMessages[0].snapshot.pageFingerprint);
  assert.equal(context.__TOOLBRAID_UNIVERSAL_CONTENT__.lastSnapshotFingerprint, null);

  snapshotCallbacks[1]({ ok: true });
  assert.equal(context.__TOOLBRAID_UNIVERSAL_CONTENT__.lastSnapshotFingerprint, fingerprint);

  intervalCallbacks[0]();
  assert.equal(snapshotMessages.length, 2);
});
