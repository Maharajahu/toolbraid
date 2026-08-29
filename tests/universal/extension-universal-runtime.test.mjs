import assert from 'node:assert/strict';
import test from 'node:test';

import { createMemoryKeyValueStore } from '../../src/persistence/index.js';
import { fingerprintAction, PROVENANCE } from '../../extension/approval-store.js';
import {
  UI_MESSAGE_TYPES,
  createExtensionUniversalRuntime,
} from '../../extension/universal-runtime.js';
import { MESSAGE_TYPES } from '../../extension/protocol.js';

function rawSnapshot() {
  return {
    version: 1,
    metadata: {
      url: 'https://example.test/form',
      origin: 'https://example.test',
      title: 'Universal form',
    },
    mainText: 'Publish a notice.',
    forms: [{
      ref: 'notice-form',
      name: 'Publish notice',
      action: 'https://example.test/api/submit',
      method: 'POST',
      fields: [{ ref: 'message', name: 'Message', type: 'text', required: true }],
    }],
    accessibleControls: [{ ref: 'message', role: 'textbox', name: 'Message', type: 'text', required: true, formRef: 'notice-form' }],
    elementRefs: [
      { ref: 'notice-form', tagName: 'form', role: 'form', name: 'Publish notice' },
      { ref: 'message', tagName: 'input', role: 'textbox', name: 'Message' },
    ],
    mediaInventory: [{ ref: 'hero', kind: 'image', src: 'https://example.test/hero.png', alt: 'Product hero', width: 800, height: 600 }],
    // Intentionally not canonical: the privileged runtime must replace it.
    pageFingerprint: '0'.repeat(64),
  };
}

function harness() {
  const session = {
    tabId: 7,
    frameId: 0,
    sessionId: 'tab-7-session-runtime',
    nonce: '12345678-1234-4234-8234-123456789abc',
  };
  const secondSession = {
    tabId: 8,
    frameId: 0,
    sessionId: 'tab-8-session-runtime',
    nonce: '87654321-4321-4321-8321-cba987654321',
  };
  const sessions = new Map([[7, session], [8, secondSession]]);
  const registry = {
    get(tabId, frameId = 0) {
      return frameId === 0 ? sessions.get(tabId) ?? null : null;
    },
  };
  let activeTabId = 7;
  let executeHandler = null;
  const registrations = [];
  const bridge = {
    async registerGeneratedTools(request) {
      registrations.push(request);
      return { ok: true };
    },
    setExecutionHandler(handler) { executeHandler = handler; },
  };
  const pageExecutions = [];
  const sendToContentScript = async (_tabId, message) => {
    if (message.type === MESSAGE_TYPES.PAGE_EXTRACT_SNAPSHOT) return { ok: true, snapshot: rawSnapshot() };
    if (message.type === MESSAGE_TYPES.PAGE_ACTION_EXECUTE) {
      pageExecutions.push(message);
      return { ok: true, receipt: { receiptId: `receipt-${pageExecutions.length}`, mode: message.mode } };
    }
    throw new Error(`Unexpected content message: ${message.type}`);
  };
  const chromeApi = {
    tabs: { query: async () => [{ id: activeTabId, url: 'https://example.test/form', title: 'Universal form' }] },
  };
  const localApprovals = new Map();
  const localApprovalStore = {
    async get(id) { return localApprovals.get(id) ?? null; },
  };
  return {
    session,
    secondSession,
    registry,
    bridge,
    chromeApi,
    registrations,
    pageExecutions,
    sendToContentScript,
    localApprovals,
    localApprovalStore,
    setActiveTab(tabId) { activeTabId = tabId; },
    setSession(nextSession) { sessions.set(nextSession.tabId, nextSession); },
    executeHandler: () => executeHandler,
  };
}

test('wires snapshot discovery, WebMCP execution, approval, exact refresh, and live mutation', async () => {
  const h = harness();
  const clock = new Date('2026-08-29T12:00:00.000Z');
  const integration = await createExtensionUniversalRuntime({
    chromeApi: h.chromeApi,
    registry: h.registry,
    bridge: h.bridge,
    sendToContentScript: h.sendToContentScript,
    store: createMemoryKeyValueStore(),
    localApprovalStore: h.localApprovalStore,
    now: () => new Date(clock),
  });

  const state = await integration.ingestPageSnapshot(
    { sessionId: h.session.sessionId, snapshot: rawSnapshot() },
    { tab: { id: 7 }, frameId: 0 },
  );
  assert.notEqual(state.pageFingerprint, '0'.repeat(64));
  assert.equal(state.multimodal.stats.completed, 1);
  assert.equal(h.registrations.length, 1);

  const read = state.tools.find((tool) => tool.classification === 'read' && tool.sourceType === 'page');
  const readResult = await h.executeHandler()({
    tabId: 7,
    frameId: 0,
    sessionId: h.session.sessionId,
    toolId: read.name,
    name: read.name,
    input: {},
    sourceProvenance: read.provenance,
  });
  assert.equal(readResult.type, 'page');

  const mutation = state.tools.find((tool) => tool.classification === 'mutate');
  const property = Object.keys(mutation.inputSchema.properties)[0];
  const preparedResponse = await integration.handleUiMessage(UI_MESSAGE_TYPES.UI_PREPARE_ACTION, {
    actionId: mutation.name,
    arguments: { [property]: 'Publish this' },
  });
  const scope = preparedResponse.preparedAction;
  const localApproval = {
    version: 1,
    provenance: PROVENANCE,
    id: 'approval-local-one',
    nonce: 'local-approval-nonce-0001',
    state: 'approved',
    createdAt: clock.getTime(),
    expiresAt: clock.getTime() + 60_000,
    scope,
    fingerprint: await fingerprintAction(scope),
  };
  h.localApprovals.set(localApproval.id, localApproval);

  const approved = await integration.handleUiMessage(UI_MESSAGE_TYPES.UI_APPROVE_ACTION, {
    decision: 'approve',
    approval: localApproval,
  });
  assert.match(approved.approvalEnvelope.fingerprint, /^[a-f0-9]{64}$/);

  const executed = await integration.handleUiMessage(UI_MESSAGE_TYPES.UI_EXECUTE_ACTION, { approval: localApproval });
  assert.equal(executed.result.status, 'dispatched');
  assert.equal(executed.result.outcome, 'postcondition-unverified');
  assert.equal(h.pageExecutions.length, 1);
  assert.equal(h.pageExecutions[0].approved, true);
});

test('rejects a locally tampered approval before durable authority is created', async () => {
  const h = harness();
  const clock = new Date('2026-08-29T12:00:00.000Z');
  const integration = await createExtensionUniversalRuntime({
    chromeApi: h.chromeApi,
    registry: h.registry,
    bridge: h.bridge,
    sendToContentScript: h.sendToContentScript,
    store: createMemoryKeyValueStore(),
    localApprovalStore: h.localApprovalStore,
    now: () => new Date(clock),
  });
  const state = await integration.ingestRaw({
    tabId: 7,
    frameId: 0,
    sessionId: h.session.sessionId,
    rawSnapshot: rawSnapshot(),
  });
  const mutation = state.tools.find((tool) => tool.classification === 'mutate');
  const property = Object.keys(mutation.inputSchema.properties)[0];
  const prepared = await integration.handleUiMessage(UI_MESSAGE_TYPES.UI_PREPARE_ACTION, {
    actionId: mutation.name,
    arguments: { [property]: 'Original' },
  });
  const approval = {
    version: 1,
    provenance: PROVENANCE,
    id: 'approval-local-tampered',
    state: 'approved',
    expiresAt: clock.getTime() + 60_000,
    scope: { ...prepared.preparedAction, normalizedArguments: { [property]: 'Tampered' } },
    fingerprint: await fingerprintAction(prepared.preparedAction),
  };
  h.localApprovals.set(approval.id, approval);
  await assert.rejects(
    integration.handleUiMessage(UI_MESSAGE_TYPES.UI_APPROVE_ACTION, { decision: 'approve', approval }),
    (error) => error.code === 'UI_APPROVAL_SCOPE_MISMATCH',
  );
  assert.equal(h.pageExecutions.length, 0);
});

test('rejects identical-page approval transfer across tabs and succeeds in its bound tab', async () => {
  const h = harness();
  const clock = new Date('2026-08-29T12:00:00.000Z');
  const integration = await createExtensionUniversalRuntime({
    chromeApi: h.chromeApi,
    registry: h.registry,
    bridge: h.bridge,
    sendToContentScript: h.sendToContentScript,
    store: createMemoryKeyValueStore(),
    localApprovalStore: h.localApprovalStore,
    now: () => new Date(clock),
  });
  const firstState = await integration.ingestRaw({
    tabId: 7,
    frameId: 0,
    sessionId: h.session.sessionId,
    rawSnapshot: rawSnapshot(),
  });
  const secondState = await integration.ingestRaw({
    tabId: 8,
    frameId: 0,
    sessionId: h.secondSession.sessionId,
    rawSnapshot: rawSnapshot(),
  });
  const firstMutation = firstState.tools.find((tool) => tool.classification === 'mutate');
  const secondMutation = secondState.tools.find((tool) => tool.classification === 'mutate');
  assert.equal(firstMutation.name, secondMutation.name);
  const property = Object.keys(firstMutation.inputSchema.properties)[0];

  h.setActiveTab(7);
  const firstPrepared = await integration.handleUiMessage(UI_MESSAGE_TYPES.UI_PREPARE_ACTION, {
    actionId: firstMutation.name,
    arguments: { [property]: 'Identical page action' },
  });
  assert.deepEqual(
    {
      tabId: firstPrepared.preparedAction.tabId,
      frameId: firstPrepared.preparedAction.frameId,
      sessionId: firstPrepared.preparedAction.sessionId,
      origin: firstPrepared.preparedAction.origin,
    },
    { tabId: 7, frameId: 0, sessionId: h.session.sessionId, origin: 'https://example.test' },
  );
  const approval = {
    version: 1,
    provenance: PROVENANCE,
    id: 'approval-tab-seven-only',
    nonce: 'local-approval-tab-seven-0001',
    state: 'approved',
    createdAt: clock.getTime(),
    expiresAt: clock.getTime() + 60_000,
    scope: firstPrepared.preparedAction,
    fingerprint: await fingerprintAction(firstPrepared.preparedAction),
  };
  h.localApprovals.set(approval.id, approval);

  h.setActiveTab(8);
  await integration.handleUiMessage(UI_MESSAGE_TYPES.UI_PREPARE_ACTION, {
    actionId: secondMutation.name,
    arguments: { [property]: 'Identical page action' },
  });
  await assert.rejects(
    integration.handleUiMessage(UI_MESSAGE_TYPES.UI_APPROVE_ACTION, { decision: 'approve', approval }),
    (error) => error.code === 'UI_APPROVAL_CONTEXT_MISMATCH',
  );
  await assert.rejects(
    integration.handleUiMessage(UI_MESSAGE_TYPES.UI_EXECUTE_ACTION, { approval }),
    (error) => error.code === 'UI_APPROVAL_CONTEXT_MISMATCH',
  );
  assert.equal(h.pageExecutions.length, 0);

  h.setActiveTab(7);
  const approved = await integration.handleUiMessage(UI_MESSAGE_TYPES.UI_APPROVE_ACTION, { decision: 'approve', approval });
  assert.equal(approved.actionId, approval.scope.actionId);
  const executed = await integration.handleUiMessage(UI_MESSAGE_TYPES.UI_EXECUTE_ACTION, { approval });
  assert.equal(executed.result.status, 'dispatched');
  assert.equal(executed.result.postcondition, 'unverified');
  assert.equal(h.pageExecutions.length, 1);
});

test('bounds retained audit sessions without deleting active unsealed trails', async () => {
  const store = createMemoryKeyValueStore();
  const sessions = new Map([21, 22, 23].map((tabId) => [tabId, {
    tabId,
    frameId: 0,
    sessionId: `tab-${tabId}-session-audit-retention`,
    nonce: `${tabId}`.repeat(32).slice(0, 32),
  }]));
  const registry = { get: (tabId, frameId = 0) => (frameId === 0 ? sessions.get(tabId) ?? null : null) };
  const integration = await createExtensionUniversalRuntime({
    chromeApi: { tabs: { query: async () => [] } },
    registry,
    bridge: { registerGeneratedTools: async () => ({ ok: true }), setExecutionHandler() {} },
    sendToContentScript: async () => { throw new Error('not expected'); },
    store,
    maxAuditSessions: 2,
    now: () => new Date('2026-08-29T12:30:00.000Z'),
  });
  for (const tabId of [21, 22]) {
    await integration.ingestRaw({
      tabId,
      frameId: 0,
      sessionId: sessions.get(tabId).sessionId,
      rawSnapshot: rawSnapshot(),
    });
  }
  await assert.rejects(
    integration.ingestRaw({
      tabId: 23,
      frameId: 0,
      sessionId: sessions.get(23).sessionId,
      rawSnapshot: rawSnapshot(),
    }),
    (error) => error.code === 'AUDIT_RETENTION_CAPACITY',
  );
  let auditKeys = (await store.keys()).filter((key) => key.startsWith('toolbraid.universal.audit.'));
  assert.equal(auditKeys.length, 2);
  assert.ok(auditKeys.some((key) => key.includes(sessions.get(21).sessionId)));
  assert.ok(auditKeys.some((key) => key.includes(sessions.get(22).sessionId)));

  await integration.closeSession(sessions.get(21), 'retention-test');
  await integration.ingestRaw({
    tabId: 23,
    frameId: 0,
    sessionId: sessions.get(23).sessionId,
    rawSnapshot: rawSnapshot(),
  });
  auditKeys = (await store.keys()).filter((key) => key.startsWith('toolbraid.universal.audit.'));
  assert.equal(auditKeys.length, 2);
  assert.equal(auditKeys.some((key) => key.includes(sessions.get(21).sessionId)), false);
  assert.ok(auditKeys.some((key) => key.includes(sessions.get(22).sessionId)));
  assert.ok(auditKeys.some((key) => key.includes(sessions.get(23).sessionId)));
  const index = await store.get('toolbraid.universal.audit-index.v1');
  assert.equal(index.sessions.length, 2);
});

test('does not close a replacement session when a stale close arrives for the prior session', async () => {
  const h = harness();
  const integration = await createExtensionUniversalRuntime({
    chromeApi: h.chromeApi,
    registry: h.registry,
    bridge: h.bridge,
    sendToContentScript: h.sendToContentScript,
    store: createMemoryKeyValueStore(),
    localApprovalStore: h.localApprovalStore,
  });
  await integration.ingestRaw({
    tabId: 7,
    frameId: 0,
    sessionId: h.session.sessionId,
    rawSnapshot: rawSnapshot(),
  });
  const replacement = {
    ...h.session,
    sessionId: 'tab-7-replacement-session-runtime',
    nonce: 'abcdef12-3456-4789-8abc-def123456789',
  };
  h.setSession(replacement);
  const replacementState = await integration.ingestRaw({
    tabId: 7,
    frameId: 0,
    sessionId: replacement.sessionId,
    rawSnapshot: rawSnapshot(),
  });

  assert.equal(await integration.closeSession(h.session, 'stale-session-close'), false);
  const activeState = integration.runtime.state(7, 0);
  assert.equal(activeState.sessionId, replacement.sessionId);
  assert.equal(activeState.revision, replacementState.revision);
  assert.deepEqual(activeState.tools, replacementState.tools);
});

test('captures visible multimodal evidence once per activation and reuses it across DOM updates', async () => {
  const h = harness();
  const clock = new Date('2026-08-29T12:00:00.000Z');
  const calls = { screenshots: 0, captions: 0, released: [] };
  const browserCapture = {
    handleStore: {
      release(handle) { calls.released.push(handle); return true; },
    },
    async captureVisibleScreenshot(options) {
      calls.screenshots += 1;
      assert.equal(options.windowId, 19);
      assert.deepEqual(options.locationRef, { href: 'https://example.test/form', origin: 'https://example.test' });
      return {
        asset: {
          kind: 'image',
          source: 'capture',
          handle: 'tb-media-activation-shot',
          mimeType: 'image/png',
          byteLength: 12,
          pageOrigin: 'https://example.test',
          sensitive: true,
        },
      };
    },
    async readCaptionTracks(tracks, options) {
      calls.captions += 1;
      assert.equal(tracks.length, 1);
      assert.equal(tracks[0].url, 'https://example.test/demo.vtt');
      assert.equal(options.locationRef.origin, 'https://example.test');
      return [{ url: tracks[0].url, text: 'A human demonstrates the workflow.' }];
    },
  };
  const integration = await createExtensionUniversalRuntime({
    chromeApi: h.chromeApi,
    registry: h.registry,
    bridge: h.bridge,
    sendToContentScript: h.sendToContentScript,
    store: createMemoryKeyValueStore(),
    localApprovalStore: h.localApprovalStore,
    browserCapture,
    now: () => new Date(clock),
  });
  const snapshot = rawSnapshot();
  snapshot.mediaInventory.push({
    ref: 'demo-video',
    kind: 'video',
    src: 'https://example.test/demo.mp4',
    tracks: [{ kind: 'captions', src: 'https://example.test/demo.vtt', label: 'English' }],
  });

  const first = await integration.ingestPageSnapshot(
    { sessionId: h.session.sessionId, snapshot, reason: 'activation' },
    { tab: { id: 7, windowId: 19 }, frameId: 0 },
  );
  assert.equal(calls.screenshots, 1);
  assert.equal(calls.captions, 1);
  assert.equal(first.multimodal.stats.total, 3);
  assert.ok(first.multimodal.results.some((result) => result.text === 'A human demonstrates the workflow.'));

  const second = await integration.ingestPageSnapshot(
    { sessionId: h.session.sessionId, snapshot, reason: 'dom-mutation' },
    { tab: { id: 7, windowId: 19 }, frameId: 0 },
  );
  assert.equal(calls.screenshots, 1);
  assert.equal(calls.captions, 1);
  assert.equal(second.multimodal.stats.total, 3);
  assert.equal(integration.captureState(7, 0, h.session.sessionId).assets[0].handle, 'tb-media-activation-shot');

  await integration.closeSession(h.session, 'navigation');
  assert.deepEqual(calls.released, ['tb-media-activation-shot']);
  assert.equal(integration.captureState(7, 0, h.session.sessionId), null);
});

test('rejects a forged session before privileged screenshot capture', async () => {
  const h = harness();
  let captures = 0;
  const integration = await createExtensionUniversalRuntime({
    chromeApi: h.chromeApi,
    registry: h.registry,
    bridge: h.bridge,
    sendToContentScript: h.sendToContentScript,
    store: createMemoryKeyValueStore(),
    localApprovalStore: h.localApprovalStore,
    browserCapture: {
      handleStore: { release() {} },
      async captureVisibleScreenshot() { captures += 1; return null; },
      async readCaptionTracks() { return []; },
    },
  });

  await assert.rejects(
    integration.ingestPageSnapshot(
      { sessionId: 'forged-session', snapshot: rawSnapshot(), reason: 'activation' },
      { tab: { id: 7, windowId: 19 }, frameId: 0 },
    ),
    (error) => error.code === 'SESSION_DRIFT',
  );
  assert.equal(captures, 0);
});
