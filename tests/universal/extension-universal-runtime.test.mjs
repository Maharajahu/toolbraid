import assert from 'node:assert/strict';
import test from 'node:test';

import { createMemoryKeyValueStore } from '../../src/persistence/index.js';
import { fingerprintAction, PROVENANCE } from '../../extension/approval-store.js';
import {
  UI_MESSAGE_TYPES,
  createExtensionUniversalRuntime,
} from '../../extension/universal-runtime.js';
import { MESSAGE_TYPES } from '../../extension/protocol.js';
import { createPageSnapshot, generateWebMcpToolDescriptors } from '../../src/universal/index.js';
import { createSiteAdapterRegistry } from '../../src/site-adapters/index.js';
import { createMediaHandleStore } from '../../src/multimodal/index.js';

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

function harness({ onSend = null } = {}) {
  const session = {
    tabId: 7,
    frameId: 0,
    sessionId: 'tab-7-session-runtime',
    nonce: '12345678-1234-4234-8234-123456789abc',
    documentId: 'document-7-session-runtime',
    pageInstanceId: 'page-instance-7-session-runtime',
  };
  const secondSession = {
    tabId: 8,
    frameId: 0,
    sessionId: 'tab-8-session-runtime',
    nonce: '87654321-4321-4321-8321-cba987654321',
    documentId: 'document-8-session-runtime',
    pageInstanceId: 'page-instance-8-session-runtime',
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
  const defaultSendToContentScript = async (_tabId, message) => {
    if (message.type === MESSAGE_TYPES.PAGE_EXTRACT_SNAPSHOT) return { ok: true, snapshot: rawSnapshot() };
    if (message.type === MESSAGE_TYPES.PAGE_ACTION_EXECUTE) {
      pageExecutions.push(message);
      return { ok: true, receipt: { receiptId: `receipt-${pageExecutions.length}`, mode: message.mode } };
    }
    throw new Error(`Unexpected content message: ${message.type}`);
  };
  const sendToContentScript = async (tabId, message, options = {}) => {
    if (typeof onSend === 'function') {
      const response = await onSend({ tabId, message, options, defaultSendToContentScript });
      if (response !== undefined) return response;
    }
    return defaultSendToContentScript(tabId, message, options);
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

test('uses the side-panel bound tab across windows and rejects a mismatched bound window', async () => {
  const h = harness();
  const tabGets = [];
  let activeQueries = 0;
  h.chromeApi.tabs = {
    async query() {
      activeQueries += 1;
      return [{ id: 101, windowId: 99, active: true, url: 'chrome-extension://toolbraid/sidepanel.html' }];
    },
    async get(tabId) {
      tabGets.push(tabId);
      return { id: 7, windowId: 42, active: true, url: 'https://example.test/form', title: 'Universal form' };
    },
  };
  const integration = await createExtensionUniversalRuntime({
    chromeApi: h.chromeApi,
    registry: h.registry,
    bridge: h.bridge,
    sendToContentScript: h.sendToContentScript,
    store: createMemoryKeyValueStore(),
    localApprovalStore: h.localApprovalStore,
  });
  await integration.ingestPageSnapshot(
    { sessionId: h.session.sessionId, snapshot: rawSnapshot() },
    { tab: { id: 7 }, frameId: 0 },
  );

  const response = await integration.handleUiMessage(UI_MESSAGE_TYPES.UI_GET_STATE, {
    targetTabId: 7,
    targetWindowId: 42,
  });

  assert.equal(response.ok, true);
  assert.equal(response.state.tab.id, 7);
  assert.deepEqual(tabGets, [7]);
  assert.equal(activeQueries, 0, 'the global active popup must not replace the side-panel bound page tab');

  await assert.rejects(
    () => integration.handleUiMessage(UI_MESSAGE_TYPES.UI_GET_STATE, {
      targetTabId: 7,
      targetWindowId: 99,
    }),
    (error) => error?.code === 'ACTIVE_TAB_DRIFT',
  );
  assert.deepEqual(tabGets, [7, 7]);
  assert.equal(activeQueries, 0);
});

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

test('executes a verified reversible stage and leaves no pending mission-equivalent action', async () => {
  const h = harness();
  const stageRaw = rawSnapshot();
  delete stageRaw.pageFingerprint;
  const page = createPageSnapshot(stageRaw);
  const generic = generateWebMcpToolDescriptors(page, { includePageRead: true })
    .find((tool) => tool.classification === 'mutate');
  const stageDescriptor = {
    ...generic,
    name: 'fixture_stage_preview',
    title: 'Prepare local preview',
    description: 'Stage the exact page draft locally for review without changing external state.',
    classification: 'stage',
    kind: 'stage',
    risk: 'reversible',
    requiresApproval: false,
    annotations: { ...generic.annotations, readOnlyHint: false },
    effect: {
      classification: 'stage',
      summary: 'Prepare the exact page draft locally for review without changing external state.',
      externalStateChange: false,
      requiresApproval: false,
    },
  };
  const siteAdapters = createSiteAdapterRegistry({
    adapters: [{
      id: 'fixture-stage',
      version: '1',
      matches: () => true,
      generateTools: () => [stageDescriptor],
    }],
  });
  const integration = await createExtensionUniversalRuntime({
    chromeApi: h.chromeApi,
    registry: h.registry,
    bridge: h.bridge,
    sendToContentScript: h.sendToContentScript,
    siteAdapterRegistry: siteAdapters,
    store: createMemoryKeyValueStore(),
    localApprovalStore: h.localApprovalStore,
    now: () => new Date('2026-08-29T12:00:00.000Z'),
  });
  const state = await integration.ingestRaw({
    tabId: 7,
    frameId: 0,
    sessionId: h.session.sessionId,
    rawSnapshot: rawSnapshot(),
  });
  const stage = state.tools.find((tool) => tool.name === stageDescriptor.name);
  assert.ok(stage);
  const property = Object.keys(stage.inputSchema.properties)[0];
  const prepared = await integration.handleUiMessage(UI_MESSAGE_TYPES.UI_PREPARE_ACTION, {
    actionId: stage.name,
    arguments: { [property]: 'Local draft' },
  });
  assert.equal(prepared.ok, true);
  assert.equal(prepared.result.status, 'staged');
  assert.equal(prepared.result.receipt.operation, 'dispatch');
  assert.deepEqual(integration.runtime.state(7, 0).pendingActions, []);
  assert.equal(integration.runtime.state(7, 0).receipts.at(-1).status, 'staged');
});

test('runs only the active exact read tool through the side-panel and bounds its untrusted result', async () => {
  const h = harness();
  const integration = await createExtensionUniversalRuntime({
    chromeApi: h.chromeApi,
    registry: h.registry,
    bridge: h.bridge,
    sendToContentScript: h.sendToContentScript,
    store: createMemoryKeyValueStore(),
    localApprovalStore: h.localApprovalStore,
  });
  const snapshot = rawSnapshot();
  snapshot.mainText = `Visible evidence ${'x'.repeat(180_000)}`;
  const state = await integration.ingestPageSnapshot(
    { sessionId: h.session.sessionId, snapshot },
    { tab: { id: 7 }, frameId: 0 },
  );
  const read = state.tools.find((tool) => tool.classification === 'read' && tool.sourceType === 'page');
  const mutation = state.tools.find((tool) => tool.classification === 'mutate');

  const response = await integration.handleUiMessage(UI_MESSAGE_TYPES.UI_EXECUTE_READ, {
    toolId: read.name,
    arguments: {},
  });
  assert.equal(response.ok, true);
  assert.equal(response.result.status, 'read-completed');
  assert.equal(response.result.tool.id, read.name);
  assert.equal(response.result.tool.sourceType, 'page');
  assert.equal(response.result.binding.tabId, 7);
  assert.equal(response.result.binding.frameId, 0);
  assert.equal(response.result.binding.sessionId, h.session.sessionId);
  assert.equal(response.result.binding.origin, 'https://example.test');
  assert.equal(response.result.binding.pageFingerprint, state.pageFingerprint);
  assert.equal(response.result.data.type, 'page');
  assert.equal(response.result.data.untrustedContent, true);
  assert.equal(response.result.untrustedContent, true);
  assert.equal(response.result.truncated, true);
  assert.ok(new TextEncoder().encode(JSON.stringify(response.result)).byteLength <= 96 * 1024);

  await assert.rejects(
    () => integration.handleUiMessage(UI_MESSAGE_TYPES.UI_EXECUTE_READ, {
      toolId: mutation.name,
      arguments: {},
    }),
    (error) => error?.code === 'TOOL_READ_REQUIRED',
  );
  await assert.rejects(
    () => integration.handleUiMessage(UI_MESSAGE_TYPES.UI_EXECUTE_READ, {
      toolId: 'not-an-active-tool',
      arguments: {},
    }),
    (error) => error?.code === 'TOOL_NOT_FOUND',
  );
});

test('falls back to a local DOM handle for oversized media URLs', async () => {
  const h = harness();
  let analyzedAssets = null;
  const integration = await createExtensionUniversalRuntime({
    chromeApi: h.chromeApi,
    registry: h.registry,
    bridge: h.bridge,
    sendToContentScript: h.sendToContentScript,
    store: createMemoryKeyValueStore(),
    localApprovalStore: h.localApprovalStore,
    multimodalPipeline: {
      limits: { maxAssets: 24 },
      async analyzeAssets(assets) {
        analyzedAssets = assets;
        return {
          version: 1,
          results: [],
          stats: { total: assets.length, completed: 0, blocked: 0, degraded: 0 },
        };
      },
    },
  });
  const snapshot = rawSnapshot();
  snapshot.mediaInventory[0].src = `data:image/png;base64,${'A'.repeat(8_192)}`;

  const state = await integration.ingestPageSnapshot(
    { sessionId: h.session.sessionId, snapshot },
    { tab: { id: 7 }, frameId: 0 },
  );
  assert.equal(state.multimodal.stats.total, 1);
  assert.equal(analyzedAssets[0].url, undefined);
  assert.equal(analyzedAssets[0].handle, 'dom:hero');
});

test('observes a fresh page snapshot before applying a bound adapter postcondition verifier', async () => {
  const h = harness();
  const canonicalRaw = rawSnapshot();
  delete canonicalRaw.pageFingerprint;
  const page = createPageSnapshot(canonicalRaw);
  const generic = generateWebMcpToolDescriptors(page, { includePageRead: true })
    .find((tool) => tool.classification === 'mutate');
  const contract = {
    version: 1,
    id: 'fixture.submit',
    adapterId: 'fixture',
    adapterVersion: '1',
    observation: 'page-snapshot',
  };
  const descriptor = {
    ...generic,
    sourceType: 'verified-adapter',
    adapter: { id: 'fixture', version: '1' },
    provenance: {
      ...generic.provenance,
      source: 'toolbraid.verified-adapter',
      adapterId: 'fixture',
      adapterVersion: '1',
      sourceType: 'verified-adapter',
    },
    postcondition: contract,
  };
  let verifierContext;
  const siteAdapters = createSiteAdapterRegistry({
    adapters: [{
      id: 'fixture',
      version: '1',
      matches: () => true,
      generateTools: () => [descriptor],
    }],
  });
  const postconditionAdapters = createSiteAdapterRegistry({
    adapters: [{
      id: 'fixture',
      version: '1',
      matches: () => true,
      generateTools: () => [],
      verifyPostcondition: (context) => {
        verifierContext = context;
        return {
          status: 'verified-success',
          reasonCode: 'CONFIRMED',
          afterPageFingerprint: context.afterSnapshot.pageFingerprint,
        };
      },
    }],
  });
  const integration = await createExtensionUniversalRuntime({
    chromeApi: h.chromeApi,
    registry: h.registry,
    bridge: h.bridge,
    sendToContentScript: h.sendToContentScript,
    siteAdapterRegistry: siteAdapters,
    postconditionAdapterRegistry: postconditionAdapters,
    store: createMemoryKeyValueStore(),
    localApprovalStore: h.localApprovalStore,
    now: () => new Date('2026-08-29T12:00:00.000Z'),
  });
  const state = await integration.ingestRaw({
    tabId: 7,
    frameId: 0,
    sessionId: h.session.sessionId,
    rawSnapshot: rawSnapshot(),
  });
  const mutation = state.tools.find((tool) => tool.postcondition?.id === contract.id);
  assert.ok(mutation);
  const property = Object.keys(mutation.inputSchema.properties)[0];
  const prepared = await integration.handleUiMessage(UI_MESSAGE_TYPES.UI_PREPARE_ACTION, {
    actionId: mutation.name,
    arguments: { [property]: 'Publish this' },
  });
  const clock = new Date('2026-08-29T12:00:00.000Z');
  const localApproval = {
    version: 1,
    provenance: PROVENANCE,
    id: 'approval-local-postcondition',
    nonce: 'local-postcondition-nonce-0001',
    state: 'approved',
    createdAt: clock.getTime(),
    expiresAt: clock.getTime() + 60_000,
    scope: prepared.preparedAction,
    fingerprint: await fingerprintAction(prepared.preparedAction),
  };
  h.localApprovals.set(localApproval.id, localApproval);
  await integration.handleUiMessage(UI_MESSAGE_TYPES.UI_APPROVE_ACTION, {
    decision: 'approve',
    approval: localApproval,
  });
  const executed = await integration.handleUiMessage(UI_MESSAGE_TYPES.UI_EXECUTE_ACTION, {
    approval: localApproval,
  });
  assert.equal(executed.result.status, 'verified-success');
  assert.equal(executed.result.postcondition, 'satisfied');
  assert.equal(verifierContext.tool.name, mutation.name);
  assert.equal(verifierContext.beforeSnapshot.pageFingerprint, page.pageFingerprint);
  assert.equal(verifierContext.afterSnapshot.pageFingerprint, page.pageFingerprint);
  assert.equal(h.pageExecutions.length, 1);
});

test('propagates postcondition timeout cancellation to the content snapshot request and ignores its late reply', async () => {
  let actionDispatched = false;
  let snapshotSignal;
  let abortObserved = false;
  let resolveSnapshotRequest;
  const h = harness({
    onSend: ({ tabId, message, options, defaultSendToContentScript }) => {
      if (message.type === MESSAGE_TYPES.PAGE_ACTION_EXECUTE) {
        actionDispatched = true;
        return defaultSendToContentScript(tabId, message, options);
      }
      if (message.type === MESSAGE_TYPES.PAGE_EXTRACT_SNAPSHOT && actionDispatched) {
        snapshotSignal = options.signal;
        return new Promise((resolve) => {
          resolveSnapshotRequest = resolve;
          if (snapshotSignal?.addEventListener) {
            snapshotSignal.addEventListener('abort', () => {
              abortObserved = true;
              resolve({ ok: true, snapshot: rawSnapshot() });
            }, { once: true });
          }
        });
      }
      return defaultSendToContentScript(tabId, message, options);
    },
  });
  const canonicalRaw = rawSnapshot();
  delete canonicalRaw.pageFingerprint;
  const page = createPageSnapshot(canonicalRaw);
  const generic = generateWebMcpToolDescriptors(page, { includePageRead: true })
    .find((tool) => tool.classification === 'mutate');
  const contract = {
    version: 1,
    id: 'fixture.submit',
    adapterId: 'fixture',
    adapterVersion: '1',
    observation: 'page-snapshot',
  };
  const descriptor = {
    ...generic,
    sourceType: 'verified-adapter',
    adapter: { id: 'fixture', version: '1' },
    provenance: {
      ...generic.provenance,
      source: 'toolbraid.verified-adapter',
      adapterId: 'fixture',
      adapterVersion: '1',
      sourceType: 'verified-adapter',
    },
    postcondition: contract,
  };
  let verifierCalls = 0;
  const siteAdapters = createSiteAdapterRegistry({
    adapters: [{
      id: 'fixture',
      version: '1',
      matches: () => true,
      generateTools: () => [descriptor],
      verifyPostcondition: () => {
        verifierCalls += 1;
        return { status: 'verified-success' };
      },
    }],
  });
  const integration = await createExtensionUniversalRuntime({
    chromeApi: h.chromeApi,
    registry: h.registry,
    bridge: h.bridge,
    sendToContentScript: h.sendToContentScript,
    siteAdapterRegistry: siteAdapters,
    store: createMemoryKeyValueStore(),
    localApprovalStore: h.localApprovalStore,
    postconditionTimeoutMs: 10,
    now: () => new Date('2026-08-29T12:00:00.000Z'),
  });
  const state = await integration.ingestRaw({
    tabId: 7,
    frameId: 0,
    sessionId: h.session.sessionId,
    rawSnapshot: rawSnapshot(),
  });
  const mutation = state.tools.find((tool) => tool.postcondition?.id === contract.id);
  assert.ok(mutation);
  const property = Object.keys(mutation.inputSchema.properties)[0];
  const prepared = await integration.handleUiMessage(UI_MESSAGE_TYPES.UI_PREPARE_ACTION, {
    actionId: mutation.name,
    arguments: { [property]: 'Publish this' },
  });
  const clock = new Date('2026-08-29T12:00:00.000Z');
  const localApproval = {
    version: 1,
    provenance: PROVENANCE,
    id: 'approval-local-postcondition-timeout',
    nonce: 'local-postcondition-timeout-0001',
    state: 'approved',
    createdAt: clock.getTime(),
    expiresAt: clock.getTime() + 60_000,
    scope: prepared.preparedAction,
    fingerprint: await fingerprintAction(prepared.preparedAction),
  };
  h.localApprovals.set(localApproval.id, localApproval);
  await integration.handleUiMessage(UI_MESSAGE_TYPES.UI_APPROVE_ACTION, {
    decision: 'approve',
    approval: localApproval,
  });
  const executed = await integration.handleUiMessage(UI_MESSAGE_TYPES.UI_EXECUTE_ACTION, {
    approval: localApproval,
  });
  assert.equal(executed.result.status, 'dispatched');
  assert.equal(executed.result.verification.reasonCode, 'POSTCONDITION_TIMEOUT');
  assert.equal(snapshotSignal instanceof AbortSignal, true);
  assert.equal(snapshotSignal.aborted, true);
  assert.equal(abortObserved, true);
  assert.equal(verifierCalls, 0);
  resolveSnapshotRequest({ ok: true, snapshot: rawSnapshot() });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(integration.runtime.state(7, 0).receipts.at(-1).verification.reasonCode, 'POSTCONDITION_TIMEOUT');
  assert.equal(h.pageExecutions.length, 1);
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

test('explicit multimodal reanalysis captures rendered audio, loaded captions, and bounded visible video frames', async () => {
  const videoSnapshot = rawSnapshot();
  videoSnapshot.pageFingerprint = 'a'.repeat(64);
  videoSnapshot.mediaInventory = [{
    ref: 'id:demo-video',
    kind: 'video',
    src: 'https://example.test/demo.mp4',
  }];
  videoSnapshot.elementRefs.push(
    { ref: 'id:demo-video', tagName: 'video', role: null, name: '' },
    { ref: 'id:embedded-player', tagName: 'iframe', role: null, name: '' },
  );
  const renderedCalls = [];
  const h = harness({
    onSend: async ({ message, defaultSendToContentScript }) => {
      if (message.type === MESSAGE_TYPES.PAGE_EXTRACT_SNAPSHOT) return { ok: true, snapshot: videoSnapshot };
      if (message.type !== MESSAGE_TYPES.PAGE_CAPTURE_RENDERED_MEDIA) return defaultSendToContentScript(7, message);
      renderedCalls.push(message);
      assert.equal(message.extractorPageFingerprint, videoSnapshot.pageFingerprint);
      const responseBinding = {
        provenance: PROVENANCE,
        requestId: message.requestId,
        tabId: message.tabId,
        frameId: message.frameId,
        sessionId: message.sessionId,
        nonce: message.nonce,
        documentId: message.documentId,
        pageInstanceId: message.pageInstanceId,
        pageFingerprint: message.pageFingerprint,
        extractorPageFingerprint: videoSnapshot.pageFingerprint,
      };
      const metadata = {
        elementRef: 'id:demo-video',
        sourceKind: 'video',
        pageOrigin: 'https://example.test',
        pageUrl: 'https://example.test/form',
      };
      if (message.mode === 'captions') return {
        ok: true,
        ...responseBinding,
        result: {
          ok: true,
          code: 'CAPTIONS_READY',
          metadata,
          captions: [{ kind: 'captions', language: 'en', label: 'English', text: 'A real rendered demonstration.' }],
        },
      };
      if (message.mode === 'frames') return {
        ok: true,
        ...responseBinding,
        result: {
          ok: true,
          code: 'CAPTURE_FRAMES_OK',
          metadata: { elementRef: metadata.elementRef, sourceKind: metadata.sourceKind, captureKind: 'frames', frameByteLength: 6 },
          captions: [{ kind: 'captions', language: 'en', label: 'English', text: 'A real rendered demonstration.' }],
          frames: [
            { index: 0, timeMs: 0, mimeType: 'image/png', width: 640, height: 360, byteLength: 3, frameBase64: 'AQID' },
            { index: 1, timeMs: 500, mimeType: 'image/png', width: 640, height: 360, byteLength: 3, frameBase64: 'BAUG' },
          ],
        },
      };
      return {
        ok: true,
        ...responseBinding,
        result: {
          ok: true,
          code: 'CAPTURE_OK',
          metadata: { ...metadata, mimeType: 'audio/webm', byteLength: 4, capturedDurationMs: 2500 },
          captions: [{ kind: 'captions', language: 'en', label: 'English', text: 'A real rendered demonstration.' }],
          audioBase64: 'AQIDBA==',
        },
      };
    },
  });
  const handleStore = createMediaHandleStore();
  let screenshots = 0;
  const browserCapture = {
    handleStore,
    async captureVisibleScreenshot() {
      screenshots += 1;
      const stored = handleStore.put(new Uint8Array([screenshots]), { kind: 'image', mimeType: 'image/png' });
      return { asset: {
        kind: 'image',
        source: 'capture',
        handle: stored.handle,
        mimeType: 'image/png',
        byteLength: 1,
        pageOrigin: 'https://example.test',
        sensitive: true,
      } };
    },
    async readCaptionTracks() { return []; },
  };
  const integration = await createExtensionUniversalRuntime({
    chromeApi: h.chromeApi,
    registry: h.registry,
    bridge: h.bridge,
    sendToContentScript: h.sendToContentScript,
    store: createMemoryKeyValueStore(),
    localApprovalStore: h.localApprovalStore,
    browserCapture,
  });
  await integration.ingestRaw({
    tabId: 7,
    frameId: 0,
    sessionId: h.session.sessionId,
    rawSnapshot: videoSnapshot,
  });

  const response = await integration.handleUiMessage(UI_MESSAGE_TYPES.UI_REANALYZE_MULTIMODAL);
  const capture = integration.captureState(7, 0, h.session.sessionId);

  assert.equal(response.ok, true);
  assert.equal(screenshots, 3);
  assert.deepEqual(renderedCalls.map((message) => message.mode), ['frames', 'audio']);
  assert.equal(capture.assets.length, 6);
  assert.equal(capture.videoEvidence.length, 1);
  assert.equal(capture.videoEvidence[0].keyframes.length, 2);
  assert.equal(capture.assets.filter((asset) => asset.kind === 'audio').length, 1);
  assert.equal(capture.captions[0].text, 'A real rendered demonstration.');
  assert.ok(capture.warnings.includes('IFRAME_MEDIA_NOT_CAPTURED'));
  const audio = capture.assets.find((asset) => asset.kind === 'audio');
  assert.deepEqual([...handleStore.get(audio.handle).bytes], [1, 2, 3, 4]);

  await integration.closeSession(h.session, 'test-complete');
  assert.equal(handleStore.stats().handles, 0);
});

test('explicit multimodal reanalysis bounds rendered capture to one target per media kind', async () => {
  const mediaSnapshot = rawSnapshot();
  mediaSnapshot.pageFingerprint = '9'.repeat(64);
  mediaSnapshot.mediaInventory = [
    { ref: 'id:primary-video', kind: 'video', src: 'https://example.test/primary.mp4' },
    { ref: 'id:duplicate-video', kind: 'video', src: 'https://example.test/duplicate.mp4' },
    { ref: 'id:primary-audio', kind: 'audio', src: 'https://example.test/primary.mp3' },
    { ref: 'id:duplicate-audio', kind: 'audio', src: 'https://example.test/duplicate.mp3' },
  ];
  mediaSnapshot.elementRefs.push(...mediaSnapshot.mediaInventory.map((entry) => ({
    ref: entry.ref,
    tagName: entry.kind,
    role: null,
    name: '',
  })));
  const renderedCalls = [];
  const h = harness({
    onSend: async ({ message, defaultSendToContentScript }) => {
      if (message.type === MESSAGE_TYPES.PAGE_EXTRACT_SNAPSHOT) return { ok: true, snapshot: mediaSnapshot };
      if (message.type !== MESSAGE_TYPES.PAGE_CAPTURE_RENDERED_MEDIA) return defaultSendToContentScript(7, message);
      renderedCalls.push({ elementRef: message.elementRef, kind: message.kind, mode: message.mode });
      return {
        ok: true,
        provenance: PROVENANCE,
        requestId: message.requestId,
        tabId: message.tabId,
        frameId: message.frameId,
        sessionId: message.sessionId,
        nonce: message.nonce,
        documentId: message.documentId,
        pageInstanceId: message.pageInstanceId,
        pageFingerprint: message.pageFingerprint,
        extractorPageFingerprint: message.extractorPageFingerprint,
        result: {
          ok: false,
          code: 'MEDIA_NOT_PLAYING',
          metadata: {
            elementRef: message.elementRef,
            sourceKind: message.kind,
            ...(message.mode === 'frames' ? {} : { pageOrigin: 'https://example.test' }),
          },
          captions: [],
        },
      };
    },
  });
  const integration = await createExtensionUniversalRuntime({
    chromeApi: h.chromeApi,
    registry: h.registry,
    bridge: h.bridge,
    sendToContentScript: h.sendToContentScript,
    store: createMemoryKeyValueStore(),
    localApprovalStore: h.localApprovalStore,
    browserCapture: {
      handleStore: { release() {} },
      async captureVisibleScreenshot() { return null; },
      async readCaptionTracks() { return []; },
    },
  });
  await integration.ingestRaw({
    tabId: 7,
    frameId: 0,
    sessionId: h.session.sessionId,
    rawSnapshot: mediaSnapshot,
  });

  const response = await integration.handleUiMessage(UI_MESSAGE_TYPES.UI_REANALYZE_MULTIMODAL);

  assert.equal(response.ok, true);
  assert.deepEqual(renderedCalls, [
    { elementRef: 'id:primary-video', kind: 'video', mode: 'frames' },
    { elementRef: 'id:primary-audio', kind: 'audio', mode: 'captions' },
    { elementRef: 'id:primary-video', kind: 'video', mode: 'audio' },
    { elementRef: 'id:primary-audio', kind: 'audio', mode: 'audio' },
  ]);
});

test('releases rendered video frame handles when the session drifts after a partial frame commit', async () => {
  const videoSnapshot = rawSnapshot();
  videoSnapshot.pageFingerprint = 'e'.repeat(64);
  videoSnapshot.mediaInventory = [{ ref: 'id:drifting-video', kind: 'video', src: 'https://example.test/drifting.mp4' }];
  videoSnapshot.elementRefs.push({ ref: 'id:drifting-video', tagName: 'video', role: null, name: '' });
  const h = harness({
    onSend: async ({ message, defaultSendToContentScript }) => {
      if (message.type === MESSAGE_TYPES.PAGE_EXTRACT_SNAPSHOT) return { ok: true, snapshot: videoSnapshot };
      if (message.type !== MESSAGE_TYPES.PAGE_CAPTURE_RENDERED_MEDIA) return defaultSendToContentScript(7, message);
      assert.equal(message.mode, 'frames');
      return {
        ok: true,
        provenance: PROVENANCE,
        requestId: message.requestId,
        tabId: message.tabId,
        frameId: message.frameId,
        sessionId: message.sessionId,
        nonce: message.nonce,
        documentId: message.documentId,
        pageInstanceId: message.pageInstanceId,
        pageFingerprint: message.pageFingerprint,
        extractorPageFingerprint: message.extractorPageFingerprint,
        result: {
          ok: true,
          code: 'CAPTURE_FRAMES_OK',
          metadata: { elementRef: 'id:drifting-video', sourceKind: 'video', captureKind: 'frames', frameByteLength: 3 },
          captions: [],
          frames: [{ index: 0, timeMs: 0, mimeType: 'image/png', width: 320, height: 180, byteLength: 3, frameBase64: 'AQID' }],
        },
      };
    },
  });
  const backingStore = createMediaHandleStore();
  const released = [];
  let puts = 0;
  const handleStore = {
    get: (handle) => backingStore.get(handle),
    put(bytes, metadata) {
      const stored = backingStore.put(bytes, metadata);
      puts += 1;
      if (puts === 1) h.setSession({
        ...h.session,
        sessionId: 'tab-7-drifted-video-session',
        nonce: 'abcdef12-3456-4789-8abc-def123456789',
      });
      return stored;
    },
    release(handle) {
      released.push(handle);
      return backingStore.release(handle);
    },
  };
  const integration = await createExtensionUniversalRuntime({
    chromeApi: h.chromeApi,
    registry: h.registry,
    bridge: h.bridge,
    sendToContentScript: h.sendToContentScript,
    store: createMemoryKeyValueStore(),
    localApprovalStore: h.localApprovalStore,
    browserCapture: {
      handleStore,
      async captureVisibleScreenshot() { return null; },
      async readCaptionTracks() { return []; },
    },
  });
  await integration.ingestRaw({ tabId: 7, frameId: 0, sessionId: h.session.sessionId, rawSnapshot: videoSnapshot });

  await assert.rejects(
    integration.handleUiMessage(UI_MESSAGE_TYPES.UI_REANALYZE_MULTIMODAL),
    (error) => error.code === 'SESSION_DRIFT' || error.code === 'CAPTURE_SESSION_DRIFT',
  );
  assert.equal(puts, 1);
  assert.equal(released.length, 1);
  assert.equal(backingStore.stats().handles, 0);
});

test('times out and cancels hung rendered-media requests without retaining evidence', async () => {
  const videoSnapshot = rawSnapshot();
  videoSnapshot.pageFingerprint = 'b'.repeat(64);
  videoSnapshot.mediaInventory = [{ ref: 'id:hung-video', kind: 'video', src: 'https://example.test/hung.mp4' }];
  videoSnapshot.elementRefs.push({ ref: 'id:hung-video', tagName: 'video', role: null, name: '' });
  const requested = [];
  const cancelled = [];
  const h = harness({
    onSend: async ({ message, defaultSendToContentScript }) => {
      if (message.type === MESSAGE_TYPES.PAGE_EXTRACT_SNAPSHOT) return { ok: true, snapshot: videoSnapshot };
      if (message.type === MESSAGE_TYPES.PAGE_CAPTURE_RENDERED_MEDIA) {
        requested.push(message.requestId);
        return new Promise(() => {});
      }
      if (message.type === MESSAGE_TYPES.PAGE_CAPTURE_RENDERED_MEDIA_CANCEL) {
        cancelled.push(message.requestId);
        return { ok: true, cancelled: true };
      }
      return defaultSendToContentScript(7, message);
    },
  });
  const released = [];
  const integration = await createExtensionUniversalRuntime({
    chromeApi: h.chromeApi,
    registry: h.registry,
    bridge: h.bridge,
    sendToContentScript: h.sendToContentScript,
    store: createMemoryKeyValueStore(),
    localApprovalStore: h.localApprovalStore,
    renderedCaptureTimeoutMs: 5,
    browserCapture: {
      handleStore: { release(handle) { released.push(handle); } },
      async captureVisibleScreenshot() { return null; },
      async readCaptionTracks() { return []; },
    },
  });
  await integration.ingestRaw({ tabId: 7, frameId: 0, sessionId: h.session.sessionId, rawSnapshot: videoSnapshot });

  const response = await integration.handleUiMessage(UI_MESSAGE_TYPES.UI_REANALYZE_MULTIMODAL);
  const capture = integration.captureState(7, 0, h.session.sessionId);

  assert.equal(response.ok, true);
  assert.equal(requested.length, 2);
  assert.deepEqual(cancelled, requested);
  assert.ok(capture.warnings.includes('CAPTURE_TIMEOUT'));
  assert.equal(capture.assets.length, 0);
  assert.deepEqual(released, []);
});

test('rejects a rendered-audio response whose echoed worker binding is forged', async () => {
  const audioSnapshot = rawSnapshot();
  audioSnapshot.pageFingerprint = 'd'.repeat(64);
  audioSnapshot.mediaInventory = [{ ref: 'id:bound-audio', kind: 'audio', src: 'https://example.test/audio.webm' }];
  audioSnapshot.elementRefs.push({ ref: 'id:bound-audio', tagName: 'audio', role: null, name: '' });
  const h = harness({
    onSend: async ({ message, defaultSendToContentScript }) => {
      if (message.type === MESSAGE_TYPES.PAGE_EXTRACT_SNAPSHOT) return { ok: true, snapshot: audioSnapshot };
      if (message.type !== MESSAGE_TYPES.PAGE_CAPTURE_RENDERED_MEDIA) return defaultSendToContentScript(7, message);
      const response = {
        ok: true,
        provenance: PROVENANCE,
        requestId: message.requestId,
        tabId: message.tabId,
        frameId: message.frameId,
        sessionId: message.sessionId,
        nonce: message.mode === 'audio' ? 'forged-capture-nonce' : message.nonce,
        documentId: message.documentId,
        pageInstanceId: message.pageInstanceId,
        pageFingerprint: message.pageFingerprint,
        extractorPageFingerprint: message.extractorPageFingerprint,
      };
      const metadata = { elementRef: message.elementRef, sourceKind: message.kind, pageOrigin: 'https://example.test' };
      if (message.mode === 'captions') return { ...response, result: { ok: true, metadata, captions: [] } };
      return {
        ...response,
        result: {
          ok: true,
          metadata: { ...metadata, mimeType: 'audio/webm', byteLength: 4 },
          captions: [],
          audioBase64: 'AQIDBA==',
        },
      };
    },
  });
  const handleStore = createMediaHandleStore();
  const integration = await createExtensionUniversalRuntime({
    chromeApi: h.chromeApi,
    registry: h.registry,
    bridge: h.bridge,
    sendToContentScript: h.sendToContentScript,
    store: createMemoryKeyValueStore(),
    localApprovalStore: h.localApprovalStore,
    browserCapture: {
      handleStore,
      async captureVisibleScreenshot() { return null; },
      async readCaptionTracks() { return []; },
    },
  });
  await integration.ingestRaw({ tabId: 7, frameId: 0, sessionId: h.session.sessionId, rawSnapshot: audioSnapshot });

  await assert.rejects(
    integration.handleUiMessage(UI_MESSAGE_TYPES.UI_REANALYZE_MULTIMODAL),
    (error) => error.code === 'CAPTURE_BINDING_MISMATCH',
  );
  assert.equal(integration.captureState(7, 0, h.session.sessionId), null);
  assert.equal(handleStore.stats().handles, 0);
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
