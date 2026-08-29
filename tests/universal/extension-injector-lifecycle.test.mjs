import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const protocolSource = await readFile(new URL('../../extension/protocol-runtime.js', import.meta.url), 'utf8');
const injectorSource = await readFile(new URL('../../extension/injector-main.js', import.meta.url), 'utf8');

function descriptor(description = 'Read the exact page.', pageFingerprint = 'a'.repeat(64)) {
  return {
    id: 'read_page',
    name: 'read_page',
    title: 'Read page',
    description,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
    provenance: { source: 'toolbraid.universal', pageFingerprint, origin: 'https://example.test' },
  };
}

function makeHarness() {
  const registrations = [];
  const sandbox = {
    AbortController,
    DOMException,
    Map,
    Promise,
    Set,
    clearTimeout,
    crypto,
    setTimeout,
    __register(definition, options) {
      registrations.push({ definition, signal: options.signal });
    },
  };
  const context = vm.createContext(sandbox);
  vm.runInContext(`
    globalThis.window = globalThis;
    globalThis.location = { origin: 'https://example.test' };
    globalThis.__tbMessages = [];
    globalThis.__tbListeners = [];
    globalThis.addEventListener = (type, listener) => { if (type === 'message') globalThis.__tbListeners.push(listener); };
    globalThis.postMessage = (message) => { globalThis.__tbMessages.push(message); };
    globalThis.__tbDispatch = (data) => globalThis.__tbListeners.forEach((listener) => listener({
      source: globalThis.window,
      origin: globalThis.location.origin,
      data,
    }));
    globalThis.document = { modelContext: { registerTool: async (definition, options) => globalThis.__register(definition, options) } };
  `, context);
  vm.runInContext(protocolSource, context);
  vm.runInContext(injectorSource, context);

  const protocol = context.ToolBraidUniversalProtocol;
  const session = vm.runInContext(`({
    nonce: '12345678-1234-4234-8234-123456789abc',
    sessionId: 'tab-1-injector-session',
    tabId: 1,
    frameId: 0,
  })`, context);
  const envelope = (type, payload, requestId = null) => {
    context.__tbType = type;
    context.__tbPayload = JSON.stringify(payload);
    context.__tbRequestId = requestId;
    return vm.runInContext('ToolBraidUniversalProtocol.createEnvelope(__tbType, JSON.parse(__tbPayload), __tbSession, __tbRequestId)', context);
  };
  context.__tbSession = session;
  const dispatch = (message) => {
    context.__tbMessage = message;
    vm.runInContext('__tbDispatch(__tbMessage)', context);
  };
  dispatch(envelope(protocol.TYPES.CHANNEL_INIT, { provenance: protocol.PROVENANCE }));
  return { context, messages: context.__tbMessages, protocol, registrations, session, dispatch, envelope };
}

async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

test('identical refreshes preserve live registrations and changed sets replace them atomically', async () => {
  const h = makeHarness();
  const register = (tools, requestId) => h.dispatch(h.envelope(
    h.protocol.TYPES.REGISTER_TOOLS,
    { tools, provenance: h.protocol.PROVENANCE },
    requestId,
  ));

  register([descriptor()], 'register-request-one');
  await flush();
  assert.equal(h.registrations.length, 1, JSON.stringify(h.messages));
  assert.equal(h.registrations[0].signal.aborted, false);

  register([descriptor()], 'register-request-two');
  await flush();
  assert.equal(h.registrations.length, 1);
  assert.equal(h.registrations[0].signal.aborted, false);

  register([descriptor('Read the refreshed exact page.')], 'register-request-three');
  await flush();
  assert.equal(h.registrations.length, 2);
  assert.equal(h.registrations[0].signal.aborted, true);
  assert.equal(h.registrations[1].signal.aborted, false);
});

test('page-fingerprint provenance replaces callbacks even when the visible tool is unchanged', async () => {
  const h = makeHarness();
  const register = (tools, requestId) => h.dispatch(h.envelope(
    h.protocol.TYPES.REGISTER_TOOLS,
    { tools, provenance: h.protocol.PROVENANCE },
    requestId,
  ));

  register([descriptor('Read the exact page.', 'a'.repeat(64))], 'register-request-one');
  await flush();
  register([descriptor('Read the exact page.', 'b'.repeat(64))], 'register-request-two');
  await flush();

  assert.equal(h.registrations.length, 2);
  assert.equal(h.registrations[0].signal.aborted, true);
  assert.equal(h.registrations[1].signal.aborted, false);
});

test('reinjection resets the old session atomically and stale handles reject after the new handshake', async () => {
  const h = makeHarness();
  const register = (tools, requestId) => h.dispatch(h.envelope(
    h.protocol.TYPES.REGISTER_TOOLS,
    { tools, provenance: h.protocol.PROVENANCE },
    requestId,
  ));

  register([descriptor()], 'register-request-one');
  await flush();
  const staleExecute = h.registrations[0].definition.execute;
  const pendingExecution = staleExecute();
  const pendingRejection = assert.rejects(pendingExecution, (error) => error.name === 'AbortError');
  await flush();

  vm.runInContext(injectorSource, h.context);
  assert.equal(h.registrations[0].signal.aborted, true);
  await pendingRejection;

  const nextSession = vm.runInContext(`({
    nonce: 'abcdefab-cdef-4abc-8def-abcdefabcdef',
    sessionId: 'tab-1-injector-session-next',
    tabId: 1,
    frameId: 0,
  })`, h.context);
  h.context.__tbSession = nextSession;
  h.dispatch(h.envelope(h.protocol.TYPES.CHANNEL_INIT, { provenance: h.protocol.PROVENANCE }));
  await flush();

  await assert.rejects(staleExecute({}), (error) => error.name === 'AbortError');
  register([descriptor('Read the exact page.', 'b'.repeat(64))], 'register-request-two');
  await flush();
  assert.equal(h.registrations.length, 2);
  assert.equal(h.registrations[1].signal.aborted, false);
  assert.equal(h.registrations[1].definition.name, 'read_page');
});
