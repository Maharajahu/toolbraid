import assert from 'node:assert/strict';
import test from 'node:test';

import { createMemoryKeyValueStore } from '../../src/persistence/index.js';
import {
  createDeterministicMultimodalAdapter,
  createMultimodalPipeline,
} from '../../src/multimodal/index.js';
import { createPageSnapshot } from '../../src/universal/index.js';
import { UI_MESSAGE_TYPES, createExtensionUniversalRuntime } from '../../extension/universal-runtime.js';

const FIRST_SESSION = Object.freeze({
  tabId: 7,
  frameId: 0,
  sessionId: 'tab-7-cache-session-a',
  nonce: '12345678-1234-4234-8234-123456789abc',
});

const SECOND_SESSION = Object.freeze({
  tabId: 7,
  frameId: 0,
  sessionId: 'tab-7-cache-session-b',
  nonce: '87654321-4321-4321-8321-cba987654321',
});

function snapshot({ url = 'https://example.test/page', mainText = 'Initial page', mediaInventory = [] } = {}) {
  return {
    version: 1,
    metadata: { url, origin: new URL(url).origin, title: 'Cache binding fixture' },
    mainText,
    forms: [],
    accessibleControls: [],
    elementRefs: [],
    mediaInventory,
  };
}

function makePipeline() {
  return createMultimodalPipeline({
    adapters: [createDeterministicMultimodalAdapter({ id: 'cache-binding-fixture', kinds: ['image'], priority: 100 })],
    now: () => new Date('2026-08-29T12:00:00.000Z'),
  });
}

function makeRuntime({
  browserCapture,
  tabsQuery = async () => [{ id: 7, url: 'https://example.test/page', title: 'Fixture' }],
  tabsOnActivated = null,
  snapshotResponse = () => snapshot(),
} = {}) {
  const sessions = new Map([[7, FIRST_SESSION]]);
  const registrations = [];
  const bridge = {
    async registerGeneratedTools(request) {
      registrations.push(request);
      return { ok: true };
    },
    setExecutionHandler() {},
  };
  const chromeApi = { tabs: { query: tabsQuery, ...(tabsOnActivated ? { onActivated: tabsOnActivated } : {}) } };
  return createExtensionUniversalRuntime({
    chromeApi,
    registry: { get(tabId, frameId = 0) { return frameId === 0 ? sessions.get(tabId) ?? null : null; } },
    bridge,
    sendToContentScript: async () => ({ ok: true, snapshot: snapshotResponse() }),
    store: createMemoryKeyValueStore(),
    browserCapture,
    multimodalPipeline: makePipeline(),
    now: () => new Date('2026-08-29T12:00:00.000Z'),
    siteAdapterRegistry: { generateTools: () => [] },
  }).then((integration) => ({ integration, sessions, registrations }));
}

function captureStub({ onCapture = () => {} } = {}) {
  const released = [];
  const asset = {
    id: 'visible-tab-cache-shot',
    kind: 'image',
    source: 'capture',
    handle: 'tb-media-visible-tab-cache-shot',
    mimeType: 'image/png',
    byteLength: 3,
    pageOrigin: 'https://example.test',
    sensitive: true,
  };
  return {
    released,
    asset,
    handleStore: { release(handle) { released.push(handle); return true; } },
    async captureVisibleScreenshot(options) {
      onCapture(options);
      return { asset };
    },
    async readCaptionTracks() { return []; },
  };
}

test('clears cached multimodal evidence when the same session receives a new page fingerprint with no assets', async () => {
  const browserCapture = captureStub();
  const { integration } = await makeRuntime({ browserCapture });
  const first = await integration.ingestPageSnapshot(
    { sessionId: FIRST_SESSION.sessionId, reason: 'activation', snapshot: snapshot() },
    { tab: { id: FIRST_SESSION.tabId, windowId: 19 }, frameId: 0 },
  );
  assert.equal(first.multimodal.stats.total, 1);
  assert.equal(integration.captureState(7, 0, FIRST_SESSION.sessionId).assets.length, 1);

  const changed = await integration.ingestPageSnapshot(
    {
      sessionId: FIRST_SESSION.sessionId,
      reason: 'dom-mutation',
      snapshot: snapshot({ url: 'https://example.test/next', mainText: 'SPA navigated page' }),
    },
    { tab: { id: FIRST_SESSION.tabId, windowId: 19 }, frameId: 0 },
  );
  assert.equal(changed.multimodal?.stats?.total ?? 0, 0);
  assert.equal(integration.captureState(7, 0, FIRST_SESSION.sessionId)?.assets?.length ?? 0, 0);
});

test('does not reuse activation evidence across a replacement session on the same tab', async () => {
  const browserCapture = captureStub();
  const { integration, sessions } = await makeRuntime({ browserCapture });
  await integration.ingestPageSnapshot(
    { sessionId: FIRST_SESSION.sessionId, reason: 'activation', snapshot: snapshot() },
    { tab: { id: FIRST_SESSION.tabId, windowId: 19 }, frameId: 0 },
  );
  sessions.set(7, SECOND_SESSION);
  const replacement = await integration.ingestPageSnapshot(
    { sessionId: SECOND_SESSION.sessionId, reason: 'dom-mutation', snapshot: snapshot({ mainText: 'Replacement session' }) },
    { tab: { id: SECOND_SESSION.tabId, windowId: 19 }, frameId: 0 },
  );
  assert.equal(replacement.multimodal?.stats?.total ?? 0, 0);
  assert.equal(integration.captureState(7, 0, SECOND_SESSION.sessionId)?.assets?.length ?? 0, 0);
});

test('rejects a visible screenshot if the active tab changes while capture is in flight', async () => {
  let activeTabId = 7;
  let queryCount = 0;
  const browserCapture = captureStub({ onCapture() { activeTabId = 8; } });
  const { integration } = await makeRuntime({
    browserCapture,
    tabsQuery: async () => {
      queryCount += 1;
      return [{
        id: activeTabId,
        url: activeTabId === 7 ? 'https://example.test/page' : 'https://other.test/page',
        title: 'Fixture',
      }];
    },
  });
  await assert.rejects(
    integration.ingestPageSnapshot(
      { sessionId: FIRST_SESSION.sessionId, reason: 'activation', snapshot: snapshot() },
      { tab: { id: FIRST_SESSION.tabId, windowId: 19 }, frameId: 0 },
    ),
    (error) => error.code === 'CAPTURE_TAB_DRIFT',
  );
  assert.ok(queryCount >= 2, 'capture must verify active tab before and after the browser screenshot');
  assert.equal(integration.captureState(7, 0, FIRST_SESSION.sessionId)?.assets?.length ?? 0, 0);
});

test('detects a switch away and back during capture through the activation generation', async () => {
  const listeners = new Set();
  const tabsOnActivated = {
    addListener(listener) { listeners.add(listener); },
    removeListener(listener) { listeners.delete(listener); },
  };
  const browserCapture = captureStub({
    onCapture() {
      for (const listener of listeners) listener({ tabId: 8, windowId: 19 });
      for (const listener of listeners) listener({ tabId: 7, windowId: 19 });
    },
  });
  const { integration } = await makeRuntime({ browserCapture, tabsOnActivated });

  await assert.rejects(
    integration.ingestPageSnapshot(
      { sessionId: FIRST_SESSION.sessionId, reason: 'activation', snapshot: snapshot() },
      { tab: { id: FIRST_SESSION.tabId, windowId: 19 }, frameId: 0 },
    ),
    (error) => error.code === 'CAPTURE_TAB_DRIFT',
  );
  assert.equal(listeners.size, 0);
  assert.equal(integration.captureState(7, 0, FIRST_SESSION.sessionId), null);
});

test('orders activation capture and a faster page update by message arrival', async () => {
  let releaseCapture;
  let markCaptureStarted;
  const captureGate = new Promise((resolve) => { releaseCapture = resolve; });
  const captureStarted = new Promise((resolve) => { markCaptureStarted = resolve; });
  const browserCapture = captureStub();
  browserCapture.captureVisibleScreenshot = async (options) => {
    markCaptureStarted();
    await captureGate;
    return { asset: browserCapture.asset };
  };
  const { integration, registrations } = await makeRuntime({ browserCapture });
  const firstSnapshot = snapshot({ mainText: 'Slow activation snapshot A' });
  const secondSnapshot = snapshot({ mainText: 'Fast page snapshot B' });
  const firstFingerprint = createPageSnapshot(firstSnapshot).pageFingerprint;
  const secondFingerprint = createPageSnapshot(secondSnapshot).pageFingerprint;

  const first = integration.ingestPageSnapshot(
    { sessionId: FIRST_SESSION.sessionId, reason: 'activation', snapshot: firstSnapshot },
    { tab: { id: FIRST_SESSION.tabId, windowId: 19 }, frameId: 0 },
  );
  await captureStarted;
  const second = integration.ingestPageSnapshot(
    { sessionId: FIRST_SESSION.sessionId, reason: 'dom-mutation', snapshot: secondSnapshot },
    { tab: { id: FIRST_SESSION.tabId, windowId: 19 }, frameId: 0 },
  );
  releaseCapture();
  await Promise.all([first, second]);

  assert.deepEqual(
    registrations.map((request) => request.tools[0].provenance.pageFingerprint),
    [firstFingerprint, secondFingerprint],
  );
  assert.equal(integration.state(7).pageFingerprint, secondFingerprint);
});

test('keeps a newer page snapshot after a slower multimodal reanalysis', async () => {
  let releaseCapture;
  let markCaptureStarted;
  const captureGate = new Promise((resolve) => { releaseCapture = resolve; });
  const captureStarted = new Promise((resolve) => { markCaptureStarted = resolve; });
  const browserCapture = captureStub();
  browserCapture.captureVisibleScreenshot = async () => {
    markCaptureStarted();
    await captureGate;
    return { asset: browserCapture.asset };
  };
  const staleSnapshot = snapshot({ url: 'https://example.test/a', mainText: 'Snapshot A' });
  const newerSnapshot = snapshot({ url: 'https://example.test/b', mainText: 'Snapshot B' });
  const newerFingerprint = createPageSnapshot(newerSnapshot).pageFingerprint;
  const { integration } = await makeRuntime({ browserCapture, snapshotResponse: () => staleSnapshot });
  await integration.ingestRaw({
    tabId: FIRST_SESSION.tabId,
    frameId: 0,
    sessionId: FIRST_SESSION.sessionId,
    rawSnapshot: staleSnapshot,
  });

  const reanalysis = integration.handleUiMessage(UI_MESSAGE_TYPES.UI_REANALYZE_MULTIMODAL);
  await captureStarted;
  const pageUpdate = integration.ingestPageSnapshot(
    { sessionId: FIRST_SESSION.sessionId, reason: 'dom-mutation', snapshot: newerSnapshot },
    { tab: { id: FIRST_SESSION.tabId, windowId: 19 }, frameId: 0 },
  );
  releaseCapture();
  await Promise.all([reanalysis, pageUpdate]);

  assert.equal(integration.state(7).pageFingerprint, newerFingerprint);
  assert.equal(integration.state(7).url, 'https://example.test/b');
});
