import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MESSAGE_TYPES,
  PROTOCOL_VERSION,
  PROVENANCE,
  ProtocolError,
  createEnvelope,
  createNonce,
  normalizeGeneratedToolDescription,
  normalizeGeneratedToolDescriptions,
  parseEnvelope,
} from '../../extension/protocol.js';
import { TabLifecycleRegistry, sessionBinding } from '../../extension/lifecycle.js';

const NONCE = '0123456789abcdef0123456789abcdef';
const SESSION = {
  nonce: NONCE,
  sessionId: 'tab-7-1-0123456789ab',
  tabId: 7,
  frameId: 0,
};

test('secure nonce generation never depends on Math.random', () => {
  const value = createNonce({
    getRandomValues(bytes) {
      bytes.fill(0xab);
      return bytes;
    },
  });
  assert.equal(value, 'ab'.repeat(32));
  assert.throws(() => createNonce({}), (error) => error instanceof ProtocolError && error.code === 'SECURE_RANDOM_UNAVAILABLE');
});

test('envelopes carry exact protocol, tab, frame, session, and nonce bindings', () => {
  const envelope = createEnvelope({
    type: MESSAGE_TYPES.EXECUTE_REQUEST,
    ...SESSION,
    requestId: 'req-0123456789abcdef',
    payload: { toolId: 'health.check', input: { verbose: true } },
  });
  assert.equal(envelope.channel, 'toolbraid-universal');
  assert.equal(envelope.version, PROTOCOL_VERSION);
  assert.deepEqual(parseEnvelope(envelope, SESSION), { ok: true, value: envelope });
  assert.equal(parseEnvelope({ ...envelope, nonce: 'forged-nonce-0123456789' }, SESSION).ok, false);
  assert.equal(parseEnvelope({ ...envelope, tabId: 8 }, SESSION).error.code, 'BINDING_MISMATCH');
  assert.equal(parseEnvelope({ ...envelope, version: 99 }, SESSION).error.code, 'VERSION_UNSUPPORTED');
  assert.equal(parseEnvelope({ ...envelope, payload: { value: undefined } }, SESSION).error.code, 'PAYLOAD_INVALID');
});

test('generated tool descriptions are normalized and stamped with provenance', () => {
  const tool = normalizeGeneratedToolDescription({
    id: 'health-check',
    name: 'health.check',
    title: 'Health check',
    description: 'Read the current service health.',
    inputSchema: { type: 'object', properties: { verbose: { type: 'boolean' } } },
  });
  assert.equal(tool.provenance, PROVENANCE);
  assert.equal(tool.annotations.provenance, PROVENANCE);
  assert.equal('execute' in tool, false);
  assert.throws(
    () => normalizeGeneratedToolDescription({ ...tool, execute: () => {} }),
    (error) => error.code === 'TOOL_DESCRIPTION_EXECUTABLE',
  );
  assert.throws(
    () => normalizeGeneratedToolDescription({ ...tool, provenance: 'provider-controlled' }),
    (error) => error.code === 'TOOL_PROVENANCE_INVALID',
  );
  assert.throws(
    () => normalizeGeneratedToolDescriptions([tool, { ...tool, id: 'other' }]),
    (error) => error.code === 'TOOL_DUPLICATE',
  );
});

test('lifecycle replaces a navigation session and preserves a repeated same-document nonce', () => {
  let sequence = 0;
  const registry = new TabLifecycleRegistry({ nonceFactory: () => `nonce-${String(++sequence).padStart(28, '0')}` });
  const first = registry.acceptPageReady(7, { pageInstanceId: 'page-0123456789abcdef', url: 'https://example.test/' });
  const repeated = registry.acceptPageReady(7, { pageInstanceId: 'page-0123456789abcdef', url: 'https://example.test/changed' });
  assert.equal(repeated.reused, true);
  assert.equal(repeated.session.nonce, first.session.nonce);
  assert.equal(repeated.session.url, 'https://example.test/changed');

  const next = registry.acceptPageReady(7, { pageInstanceId: 'page-fedcba9876543210', url: 'https://example.test/next' });
  assert.equal(next.reused, false);
  assert.notEqual(next.session.nonce, first.session.nonce);
  assert.equal(registry.get(7).sessionId, next.session.sessionId);
  assert.deepEqual(sessionBinding(next.session), {
    nonce: next.session.nonce,
    sessionId: next.session.sessionId,
    tabId: 7,
    frameId: 0,
  });
  assert.equal(registry.invalidate(7, 'navigation').length, 1);
  assert.equal(registry.get(7), null);
});

test('a fresh lifecycle registry creates a new same-document authority after service-worker restart', () => {
  let sequence = 0;
  const nonceFactory = () => `nonce-${String(++sequence).padStart(2, '0')}-${'0'.repeat(26)}`;
  const firstRegistry = new TabLifecycleRegistry({ nonceFactory });
  const first = firstRegistry.acceptPageReady(7, {
    pageInstanceId: 'page-0123456789abcdef',
    url: 'https://example.test/',
  }).session;

  const restartedRegistry = new TabLifecycleRegistry({ nonceFactory });
  const next = restartedRegistry.acceptPageReady(7, {
    pageInstanceId: 'page-0123456789abcdef',
    url: 'https://example.test/',
  });

  assert.equal(next.reused, false);
  assert.notEqual(next.session.nonce, first.nonce);
  assert.notEqual(next.session.sessionId, first.sessionId);
});
