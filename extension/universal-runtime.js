import {
  createChromeStorageAdapter,
  createMemoryKeyValueStore,
  createPersistentApprovalLedger,
  createPersistentAuditTrail,
} from '../src/persistence/index.js';
import { createUniversalSessionRuntime } from '../src/runtime/index.js';
import {
  createGitHubAdapter,
  createSiteAdapterRegistry,
  createVercelAdapter,
  createXPostAdapter,
} from '../src/site-adapters/index.js';
import {
  createBrowserMediaCapture,
  createMultimodalPipeline,
} from '../src/multimodal/index.js';
import { assertPreparedActionCurrent, createPageSnapshot } from '../src/universal/index.js';
import {
  PROVENANCE,
  createApprovalStore,
  fingerprintAction,
  stableStringify,
} from './approval-store.js';
import { MESSAGE_TYPES, ProtocolError, isInjectableUrl } from './protocol.js';
import {
  createConfiguredMultimodalAdapter,
  createMultimodalSettingsStore,
} from './multimodal-provider.js';

export const UI_MESSAGE_TYPES = Object.freeze({
  UI_GET_STATE: 'UI_GET_STATE',
  UI_PREPARE_ACTION: 'UI_PREPARE_ACTION',
  UI_APPROVE_ACTION: 'UI_APPROVE_ACTION',
  UI_EXECUTE_ACTION: 'UI_EXECUTE_ACTION',
  UI_REANALYZE_MULTIMODAL: 'UI_REANALYZE_MULTIMODAL',
});

const UI_MESSAGE_SET = new Set(Object.values(UI_MESSAGE_TYPES));
const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024;
const MAX_CAPTURE_TRACKS = 24;
const AUDIT_INDEX_KEY = 'toolbraid.universal.audit-index.v1';
const DEFAULT_MAX_AUDIT_SESSIONS = 64;

export class ExtensionUniversalRuntimeError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ExtensionUniversalRuntimeError';
    this.code = code;
    this.details = details;
  }
}

function runtimeError(code, message, details = {}) {
  return new ExtensionUniversalRuntimeError(code, message, details);
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function plainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function boundedSnapshot(raw) {
  if (!plainObject(raw)) throw runtimeError('SNAPSHOT_INVALID', 'A plain page snapshot is required.');
  let size;
  try {
    size = new TextEncoder().encode(JSON.stringify(raw)).byteLength;
  } catch {
    throw runtimeError('SNAPSHOT_INVALID', 'The page snapshot must be JSON serializable.');
  }
  if (size > MAX_SNAPSHOT_BYTES) {
    throw runtimeError('SNAPSHOT_TOO_LARGE', `Page snapshot exceeds ${MAX_SNAPSHOT_BYTES} bytes.`, { size });
  }
  const copy = clone(raw);
  const mediaInventory = Array.isArray(copy.mediaInventory) ? copy.mediaInventory : [];
  // The privileged runtime is the canonical fingerprint authority. The
  // extractor fingerprint is diagnostic only and is never trusted as input.
  delete copy.pageFingerprint;
  delete copy.fingerprint;
  delete copy.stats;
  delete copy.mediaInventory;
  return { snapshot: copy, mediaInventory };
}

function safeOrigin(url) {
  try { return new URL(url).origin; } catch { return ''; }
}

function captionTextFor(entry, captions) {
  const trackUrls = new Set((entry?.tracks ?? []).map((track) => track?.url ?? track?.src).filter(Boolean));
  const text = captions
    .filter((caption) => trackUrls.has(caption?.url))
    .map((caption) => caption?.text)
    .filter(Boolean)
    .join('\n')
    .slice(0, 4096);
  return text || null;
}

function mediaAssets(mediaInventory, { origin, frameId, captions = [], maxAssets = 24 }) {
  return mediaInventory.slice(0, maxAssets).map((entry, index) => {
    const candidate = entry?.src || entry?.sources?.find?.((source) => source?.src)?.src || entry?.poster || null;
    const assetOrigin = candidate ? safeOrigin(candidate) : '';
    const capturedCaption = captionTextFor(entry, captions);
    return {
      id: `dom-${String(entry?.ref ?? index + 1).slice(0, 480)}`,
      kind: entry?.kind === 'audio' || entry?.kind === 'video' ? entry.kind : 'image',
      source: 'dom',
      ...(candidate ? { url: candidate } : { handle: `dom:${String(entry?.ref ?? index + 1).slice(0, 480)}` }),
      mimeType: entry?.sources?.find?.((source) => source?.src === candidate)?.type || null,
      durationMs: Number.isFinite(entry?.duration) ? Math.max(0, entry.duration * 1000) : null,
      width: Number.isFinite(entry?.width) ? Math.max(0, entry.width) : null,
      height: Number.isFinite(entry?.height) ? Math.max(0, entry.height) : null,
      altText: entry?.alt || null,
      caption: capturedCaption || entry?.caption || entry?.tracks?.find?.((track) => track?.kind === 'captions')?.label || null,
      pageOrigin: origin,
      frameId: String(frameId),
      crossOrigin: Boolean(assetOrigin && origin && assetOrigin !== origin),
      sensitive: false,
    };
  });
}

function captureKey(tabId, frameId, sessionId) {
  return `${tabId}:${frameId}:${sessionId}`;
}

function canonicalPageFingerprint(snapshot) {
  return createPageSnapshot(snapshot).pageFingerprint;
}

function pageLocation(snapshot) {
  const href = snapshot?.metadata?.url;
  const origin = safeOrigin(href) || snapshot?.metadata?.origin || '';
  if (typeof href !== 'string' || !href || !origin) return null;
  return Object.freeze({ href, origin });
}

function sameOriginTracks(mediaInventory, location) {
  if (!location) return [];
  const tracks = [];
  for (const entry of mediaInventory) {
    for (const track of entry?.tracks ?? []) {
      if (tracks.length >= MAX_CAPTURE_TRACKS) return tracks;
      const rawUrl = track?.url ?? track?.src;
      if (typeof rawUrl !== 'string' || !rawUrl) continue;
      try {
        const url = new URL(rawUrl, location.href);
        if (url.origin === location.origin && ['http:', 'https:'].includes(url.protocol)) {
          tracks.push({ ...track, url: url.href });
        }
      } catch { /* malformed untrusted track URL is ignored */ }
    }
  }
  return tracks;
}

function captureClock(now) {
  const value = now();
  return value instanceof Date ? value.getTime() : Number(value);
}

function storageFor(chromeApi, suppliedStore) {
  if (suppliedStore) return suppliedStore;
  if (chromeApi?.storage?.local) return createChromeStorageAdapter(chromeApi.storage.local);
  return createMemoryKeyValueStore();
}

function emptyAuditIndex() {
  return { version: 1, generation: 0, sessions: [] };
}

function validateAuditIndex(value) {
  if (!plainObject(value) || value.version !== 1 || !Number.isInteger(value.generation) || !Array.isArray(value.sessions)) {
    throw runtimeError('AUDIT_INDEX_INVALID', 'The persistent audit retention index is invalid.');
  }
  const keys = new Set();
  for (const entry of value.sessions) {
    if (!plainObject(entry)
      || typeof entry.key !== 'string' || !entry.key.startsWith('toolbraid.universal.audit.')
      || !Number.isInteger(entry.tabId) || entry.tabId < 0
      || !Number.isInteger(entry.frameId) || entry.frameId < 0
      || typeof entry.sessionId !== 'string' || entry.sessionId.length < 8
      || !Number.isFinite(entry.updatedAt) || typeof entry.sealed !== 'boolean'
      || keys.has(entry.key)) {
      throw runtimeError('AUDIT_INDEX_INVALID', 'The persistent audit retention index contains an invalid session record.');
    }
    keys.add(entry.key);
  }
  return value;
}

function sessionMatches(registry, tabId, frameId, sessionId) {
  const session = registry.get(tabId, frameId);
  if (!session || session.sessionId !== sessionId) {
    throw runtimeError('SESSION_DRIFT', 'The page session no longer matches the active ToolBraid session.');
  }
  return session;
}

async function activeTab(chromeApi) {
  if (!chromeApi?.tabs?.query) throw runtimeError('ACTIVE_TAB_UNAVAILABLE', 'Chrome active-tab lookup is unavailable.');
  const tabs = await chromeApi.tabs.query({ active: true, currentWindow: true });
  const tab = tabs?.[0];
  if (!Number.isInteger(tab?.id) || !isInjectableUrl(tab?.url ?? '')) {
    throw runtimeError('ACTIVE_TAB_UNAVAILABLE', 'Open and activate an HTTP(S) page first.');
  }
  return tab;
}

function uiState(tab, state, { audit = null, capture = null, multimodalProvider = null } = {}) {
  return Object.freeze({
    connection: 'ready',
    mode: state.multimodal ? 'Universal + multimodal' : 'Universal',
    tab: Object.freeze({
      id: tab.id,
      url: state.url,
      origin: state.origin,
      title: tab.title ?? '',
    }),
    snapshot: Object.freeze({ pageFingerprint: state.pageFingerprint, navigationGeneration: state.revision }),
    tools: state.tools,
    actions: Object.freeze(state.tools.filter((tool) => tool.classification !== 'read')),
    approvals: Object.freeze([]),
    pendingActions: state.pendingActions,
    receipts: state.receipts,
    multimodal: state.multimodal,
    multimodalProvider,
    capture,
    audit,
    quarantined: state.quarantined,
    provenance: PROVENANCE,
  });
}

export async function createExtensionUniversalRuntime({
  chromeApi,
  registry,
  bridge,
  sendToContentScript,
  store: suppliedStore = null,
  now = () => new Date(),
  siteAdapterRegistry = null,
  multimodalPipeline = null,
  browserCapture: suppliedBrowserCapture = null,
  localApprovalStore: suppliedLocalApprovalStore = null,
  maxAuditSessions = DEFAULT_MAX_AUDIT_SESSIONS,
} = {}) {
  if (!chromeApi || !registry || !bridge || typeof sendToContentScript !== 'function') {
    throw new TypeError('chromeApi, registry, bridge, and sendToContentScript are required.');
  }
  if (!Number.isInteger(maxAuditSessions) || maxAuditSessions < 1 || maxAuditSessions > 1024) {
    throw new RangeError('maxAuditSessions must be an integer between 1 and 1024.');
  }
  const store = storageFor(chromeApi, suppliedStore);
  const localApprovalStore = suppliedLocalApprovalStore ?? (chromeApi?.storage?.local
    ? createApprovalStore({ storageArea: chromeApi.storage.local, now: () => captureClock(now) })
    : null);
  const ledger = await createPersistentApprovalLedger({ store, key: 'toolbraid.universal.approval-ledger.v1', now });
  const adapters = siteAdapterRegistry ?? createSiteAdapterRegistry({
    adapters: [createXPostAdapter(), createGitHubAdapter(), createVercelAdapter()],
  });
  const browserCapture = suppliedBrowserCapture ?? createBrowserMediaCapture({
    documentRef: null,
    fetchImpl: globalThis.fetch?.bind(globalThis),
    captureVisibleTab: chromeApi.tabs?.captureVisibleTab?.bind(chromeApi.tabs),
    now: () => captureClock(now),
  });
  const multimodalSettings = createMultimodalSettingsStore({
    localArea: chromeApi.storage?.local,
    sessionArea: chromeApi.storage?.session,
    permissionsApi: chromeApi.permissions,
  });
  const mediaHandleStore = browserCapture.handleStore && typeof browserCapture.handleStore.get === 'function'
    ? browserCapture.handleStore
    : Object.freeze({ get: () => null });
  const multimodal = multimodalPipeline ?? createMultimodalPipeline({
    adapters: [createConfiguredMultimodalAdapter({
      settings: multimodalSettings,
      handleStore: mediaHandleStore,
      fetchImpl: globalThis.fetch?.bind(globalThis),
    })],
  });
  const auditCache = new Map();
  const activeAuditByFrame = new Map();
  const captureCache = new Map();
  const multimodalStateOverrides = new Map();
  const snapshotIngestTails = new Map();
  let auditIndexTail = Promise.resolve();

  function releaseCaptureEvidence(evidence) {
    for (const asset of evidence?.assets ?? []) {
      if (asset?.handle) browserCapture.handleStore?.release?.(asset.handle);
    }
  }

  function clearCaptureCache(key) {
    const evidence = captureCache.get(key);
    if (evidence) releaseCaptureEvidence(evidence);
    captureCache.delete(key);
  }

  function clearOtherSessionCaptureCache(tabId, frameId, sessionId) {
    for (const [key, evidence] of captureCache.entries()) {
      if (evidence?.tabId === tabId && evidence?.frameId === frameId && evidence.sessionId !== sessionId) {
        clearCaptureCache(key);
      }
    }
  }

  function serializeSnapshotIngest(tabId, frameId, operation) {
    const key = `${tabId}:${frameId}`;
    const prior = snapshotIngestTails.get(key) ?? Promise.resolve();
    const current = prior.then(operation, operation);
    snapshotIngestTails.set(key, current);
    return current.finally(() => {
      if (snapshotIngestTails.get(key) === current) snapshotIngestTails.delete(key);
    });
  }

  function visibleState(tabId, frameId, state) {
    const override = multimodalStateOverrides.get(captureKey(tabId, frameId, state.sessionId));
    if (!override || override.pageFingerprint !== state.pageFingerprint) return state;
    return Object.freeze({ ...state, multimodal: clone(override.multimodal) });
  }

  function boundCaptureEvidence(evidence, { sessionId, pageFingerprint }) {
    if (!evidence || evidence.sessionId !== sessionId || evidence.pageFingerprint !== pageFingerprint) return null;
    return evidence;
  }

  async function assertCaptureTab(tabId, windowId) {
    const tab = await activeTab(chromeApi);
    if (tab.id !== tabId || (Number.isInteger(windowId) && Number.isInteger(tab.windowId) && tab.windowId !== windowId)) {
      throw runtimeError('CAPTURE_TAB_DRIFT', 'The active tab changed during visible-tab capture.');
    }
    return tab;
  }

  async function captureActivationEvidence({ tabId, frameId, sessionId, snapshot, mediaInventory, windowId, pageFingerprint }) {
    const key = captureKey(tabId, frameId, sessionId);
    clearCaptureCache(key);
    const location = pageLocation(snapshot);
    if (!location) {
      const evidence = Object.freeze({
        tabId,
        frameId,
        sessionId,
        pageFingerprint,
        assets: Object.freeze([]),
        captions: Object.freeze([]),
        warnings: Object.freeze(['PAGE_LOCATION_UNAVAILABLE']),
      });
      captureCache.set(key, evidence);
      return evidence;
    }

    const warnings = [];
    const assets = [];
    const captions = [];
    let screenshot = null;
    try {
      sessionMatches(registry, tabId, frameId, sessionId);
      await assertCaptureTab(tabId, windowId);
      screenshot = await browserCapture.captureVisibleScreenshot({ windowId, locationRef: location });
      await assertCaptureTab(tabId, windowId);
      sessionMatches(registry, tabId, frameId, sessionId);
      if (screenshot?.asset) assets.push(screenshot.asset);
      else if (screenshot) assets.push(screenshot);
    } catch (error) {
      const capturedAsset = screenshot?.asset ?? screenshot;
      if (capturedAsset?.handle) browserCapture.handleStore?.release?.(capturedAsset.handle);
      warnings.push(error?.code ?? 'SCREENSHOT_CAPTURE_FAILED');
    }

    const tracks = sameOriginTracks(mediaInventory, location);
    const trackResults = await Promise.allSettled(tracks.map((track) => (
      browserCapture.readCaptionTracks([track], { locationRef: location })
    )));
    for (const result of trackResults) {
      if (result.status === 'fulfilled') captions.push(...result.value);
      else warnings.push(result.reason?.code ?? 'CAPTION_CAPTURE_FAILED');
    }

    const audioCandidates = mediaAssets(mediaInventory, {
      origin: location.origin,
      frameId,
      captions,
      maxAssets: 8,
    }).filter((asset) => asset.kind === 'audio' && asset.url && safeOrigin(asset.url) === location.origin).slice(0, 2);
    for (const candidate of audioCandidates) {
      try {
        const captured = await browserCapture.fetchAsset(candidate, { locationRef: location });
        if (captured?.asset) assets.push(captured.asset);
        else if (captured) assets.push(captured);
      } catch (error) {
        warnings.push(error?.code ?? 'AUDIO_CAPTURE_FAILED');
      }
    }

    const evidence = Object.freeze({
      tabId,
      frameId,
      sessionId,
      pageFingerprint,
      assets: Object.freeze(assets),
      captions: Object.freeze(captions),
      warnings: Object.freeze([...new Set(warnings)]),
    });
    captureCache.set(key, evidence);
    return evidence;
  }

  function serializeAuditIndex(operation) {
    const result = auditIndexTail.then(operation, operation);
    auditIndexTail = result.then(() => undefined, () => undefined);
    return result;
  }

  async function readAuditIndex() {
    const stored = await store.get(AUDIT_INDEX_KEY);
    return stored === undefined ? emptyAuditIndex() : validateAuditIndex(stored);
  }

  async function auditForSession({ tabId, frameId, sessionId }) {
    const key = `toolbraid.universal.audit.${tabId}.${frameId}.${sessionId}`;
    if (auditCache.has(key)) return auditCache.get(key);
    return serializeAuditIndex(async () => {
      if (auditCache.has(key)) return auditCache.get(key);
      const slot = `${tabId}:${frameId}`;
      const index = await readAuditIndex();
      const priorKey = activeAuditByFrame.get(slot);
      if (priorKey && priorKey !== key) {
        const priorTrail = auditCache.get(priorKey);
        if (priorTrail) await priorTrail.seal();
        auditCache.delete(priorKey);
        activeAuditByFrame.delete(slot);
        const priorRecord = index.sessions.find((entry) => entry.key === priorKey);
        if (priorRecord) {
          priorRecord.sealed = true;
          priorRecord.updatedAt = captureClock(now);
        }
      }

      const trail = await createPersistentAuditTrail({ store, key, now });
      index.sessions = index.sessions.filter((entry) => entry.key !== key);
      while (index.sessions.length >= maxAuditSessions) {
        const candidate = index.sessions
          .filter((entry) => !auditCache.has(entry.key))
          .sort((left, right) => left.updatedAt - right.updatedAt)[0];
        if (!candidate) {
          await store.remove(key);
          throw runtimeError(
            'AUDIT_RETENTION_CAPACITY',
            `All ${maxAuditSessions} retained audit sessions are active and unsealed.`,
          );
        }
        const candidateTrail = await createPersistentAuditTrail({ store, key: candidate.key, now });
        const status = await candidateTrail.status();
        if (!status.sealed) await candidateTrail.seal();
        await store.remove(candidate.key);
        index.sessions = index.sessions.filter((entry) => entry.key !== candidate.key);
      }
      index.sessions.push({
        key,
        tabId,
        frameId,
        sessionId,
        sealed: false,
        updatedAt: captureClock(now),
      });
      index.generation += 1;
      await store.set(AUDIT_INDEX_KEY, index);
      auditCache.set(key, trail);
      activeAuditByFrame.set(slot, key);
      return trail;
    });
  }

  async function releaseAuditSession({ tabId, frameId, sessionId }) {
    const key = `toolbraid.universal.audit.${tabId}.${frameId}.${sessionId}`;
    const slot = `${tabId}:${frameId}`;
    return serializeAuditIndex(async () => {
      auditCache.delete(key);
      if (activeAuditByFrame.get(slot) === key) activeAuditByFrame.delete(slot);
      const index = await readAuditIndex();
      const record = index.sessions.find((entry) => entry.key === key);
      if (record) {
        record.sealed = true;
        record.updatedAt = captureClock(now);
        index.generation += 1;
        await store.set(AUDIT_INDEX_KEY, index);
      }
    });
  }

  async function requestRawSnapshot(tabId, frameId, sessionId) {
    const session = sessionMatches(registry, tabId, frameId, sessionId);
    const response = await sendToContentScript(tabId, {
      type: MESSAGE_TYPES.PAGE_EXTRACT_SNAPSHOT,
      tabId,
      frameId,
      sessionId,
      nonce: session.nonce,
      provenance: PROVENANCE,
    }, { frameId });
    if (!response?.ok || !response.snapshot) {
      throw runtimeError(response?.error?.code ?? 'SNAPSHOT_REFRESH_FAILED', response?.error?.message ?? 'The live page snapshot could not be refreshed.');
    }
    return response.snapshot;
  }

  async function executePageAction(request) {
    const { beforeDispatch, ...pageRequest } = request;
    const session = sessionMatches(registry, pageRequest.tabId, pageRequest.frameId, pageRequest.sessionId);
    const rawSnapshot = await requestRawSnapshot(pageRequest.tabId, pageRequest.frameId, pageRequest.sessionId);
    const current = boundedSnapshot(rawSnapshot).snapshot;
    assertPreparedActionCurrent(pageRequest.preparedAction, current);
    if (typeof beforeDispatch !== 'function') {
      throw runtimeError('DISPATCH_AUDIT_HOOK_REQUIRED', 'Durable dispatch recording is required before a page effect.');
    }
    await beforeDispatch();
    const response = await sendToContentScript(pageRequest.tabId, {
      type: MESSAGE_TYPES.PAGE_ACTION_EXECUTE,
      ...pageRequest,
      nonce: session.nonce,
      extractorPageFingerprint: typeof rawSnapshot.pageFingerprint === 'string' ? rawSnapshot.pageFingerprint : null,
      provenance: PROVENANCE,
    }, { frameId: pageRequest.frameId });
    if (!response?.ok) throw runtimeError(response?.error?.code ?? 'PAGE_ACTION_FAILED', response?.error?.message ?? 'The live page action failed.');
    return response.receipt ?? response.result ?? response;
  }

  const runtime = createUniversalSessionRuntime({
    approvalLedger: ledger,
    siteAdapterRegistry: adapters,
    multimodalPipeline: multimodal,
    auditForSession,
    dispatchHookAware: true,
    now,
    registerTools: (request) => bridge.registerGeneratedTools(request),
    executePageAction,
  });

  bridge.setExecutionHandler(async (request) => {
    const session = sessionMatches(registry, request.tabId, request.frameId, request.sessionId);
    const state = runtime.state(request.tabId, request.frameId);
    const suppliedFingerprint = request.sourceProvenance?.pageFingerprint;
    if (suppliedFingerprint && suppliedFingerprint !== state.pageFingerprint) {
      throw runtimeError('TOOL_PROVENANCE_DRIFT', 'The invoked tool belongs to an earlier page snapshot.');
    }
    return runtime.executeTool({
      tabId: request.tabId,
      frameId: request.frameId,
      sessionId: session.sessionId,
      name: request.name ?? request.toolId,
      input: request.input ?? {},
    });
  });

  async function ingestRaw({ tabId, frameId, sessionId, rawSnapshot, captureEvidence = null }) {
    const session = sessionMatches(registry, tabId, frameId, sessionId);
    clearOtherSessionCaptureCache(tabId, frameId, sessionId);
    const bounded = boundedSnapshot(rawSnapshot);
    const pageFingerprint = canonicalPageFingerprint(bounded.snapshot);
    const key = captureKey(tabId, frameId, sessionId);
    const origin = safeOrigin(bounded.snapshot.metadata?.url) || bounded.snapshot.metadata?.origin || '';
    let cachedEvidence = null;
    if (captureEvidence) {
      if (boundCaptureEvidence(captureEvidence, { sessionId, pageFingerprint })) cachedEvidence = captureEvidence;
      else if (captureCache.get(key) === captureEvidence) clearCaptureCache(key);
      else releaseCaptureEvidence(captureEvidence);
    } else if (bounded.mediaInventory.length > 0) {
      const cached = captureCache.get(key);
      if (boundCaptureEvidence(cached, { sessionId, pageFingerprint })) cachedEvidence = cached;
      else if (cached) clearCaptureCache(key);
    } else {
      clearCaptureCache(key);
    }
    cachedEvidence ??= { assets: [], captions: [] };
    const maxAssets = multimodal.limits?.maxAssets ?? 24;
    const capturedAssets = Array.isArray(cachedEvidence.assets) ? cachedEvidence.assets.slice(0, maxAssets) : [];
    const domAssets = mediaAssets(bounded.mediaInventory, {
      origin,
      frameId,
      captions: Array.isArray(cachedEvidence.captions) ? cachedEvidence.captions : [],
      maxAssets: Math.max(0, maxAssets - capturedAssets.length),
    });
    const pageAssets = [...capturedAssets, ...domAssets];
    const state = await runtime.ingest({
      tabId,
      frameId,
      sessionId: session.sessionId,
      snapshot: bounded.snapshot,
      mediaAssets: pageAssets,
    });
    if (pageAssets.length === 0) {
      multimodalStateOverrides.set(key, Object.freeze({ pageFingerprint, multimodal: null }));
    } else {
      multimodalStateOverrides.delete(key);
    }
    return visibleState(tabId, frameId, state);
  }

  async function ingestPageSnapshot(message, sender = {}) {
    const tabId = sender?.tab?.id;
    const frameId = sender?.frameId ?? 0;
    if (!Number.isInteger(tabId) || !Number.isInteger(frameId)) {
      throw runtimeError('PAGE_SENDER_INVALID', 'Snapshots must originate from a tab content script.');
    }
    sessionMatches(registry, tabId, frameId, message?.sessionId);
    const run = async () => {
      sessionMatches(registry, tabId, frameId, message?.sessionId);
      clearOtherSessionCaptureCache(tabId, frameId, message?.sessionId);
      const bounded = boundedSnapshot(message?.snapshot);
      const pageFingerprint = canonicalPageFingerprint(bounded.snapshot);
      const captureCacheKey = captureKey(tabId, frameId, message?.sessionId);
      let captureEvidence = null;
      if (message?.reason === 'activation') {
        captureEvidence = await captureActivationEvidence({
          tabId,
          frameId,
          sessionId: message?.sessionId,
          snapshot: bounded.snapshot,
          mediaInventory: bounded.mediaInventory,
          windowId: sender?.tab?.windowId,
          pageFingerprint,
        });
      } else if (bounded.mediaInventory.length > 0) {
        const cached = captureCache.get(captureCacheKey);
        if (boundCaptureEvidence(cached, { sessionId: message?.sessionId, pageFingerprint })) captureEvidence = cached;
        else if (cached) clearCaptureCache(captureCacheKey);
      } else {
        clearCaptureCache(captureCacheKey);
      }
      return ingestRaw({ tabId, frameId, sessionId: message?.sessionId, rawSnapshot: message?.snapshot, captureEvidence });
    };
    return serializeSnapshotIngest(tabId, frameId, run);
  }

  async function refreshSnapshot(tabId, frameId, sessionId) {
    return boundedSnapshot(await requestRawSnapshot(tabId, frameId, sessionId)).snapshot;
  }

  async function activeContext() {
    const tab = await activeTab(chromeApi);
    const session = registry.get(tab.id, 0);
    if (!session) throw runtimeError('SESSION_NOT_FOUND', 'Activate ToolBraid on this tab first.');
    const state = runtime.state(tab.id, 0);
    const origin = safeOrigin(tab.url);
    if (session.tabId !== tab.id || session.frameId !== 0 || state.sessionId !== session.sessionId || state.origin !== origin) {
      throw runtimeError('SESSION_DRIFT', 'The active tab no longer matches its ToolBraid page session.');
    }
    return { tab, session, state };
  }

  function authorityBinding(context) {
    return Object.freeze({
      tabId: context.tab.id,
      frameId: context.session.frameId,
      sessionId: context.session.sessionId,
      origin: context.state.origin,
    });
  }

  function bindPreparedAction(action, context) {
    if (!plainObject(action)) throw runtimeError('UI_APPROVAL_SCOPE_MISMATCH', 'The exact prepared action is no longer pending.');
    return Object.freeze({ ...clone(action), ...authorityBinding(context) });
  }

  function assertPreparedActionContext(action, context) {
    const expected = authorityBinding(context);
    if (!plainObject(action)
      || action.tabId !== expected.tabId
      || action.frameId !== expected.frameId
      || action.sessionId !== expected.sessionId
      || action.origin !== expected.origin) {
      throw runtimeError('UI_APPROVAL_CONTEXT_MISMATCH', 'The prepared action belongs to a different tab, frame, session, or origin.');
    }
  }

  async function assertLocalApproval(approval, pending, context) {
    if (!plainObject(approval) || approval.provenance !== PROVENANCE || approval.state !== 'approved') {
      throw runtimeError('UI_APPROVAL_INVALID', 'A valid extension-owned approval is required.');
    }
    if (!Number.isFinite(approval.expiresAt) || approval.expiresAt <= captureClock(now)) {
      throw runtimeError('UI_APPROVAL_EXPIRED', 'The local approval has expired.');
    }
    if (!localApprovalStore || typeof localApprovalStore.get !== 'function') {
      throw runtimeError('UI_APPROVAL_STORE_UNAVAILABLE', 'The extension-owned approval store is unavailable.');
    }
    const persisted = await localApprovalStore.get(approval.id);
    if (!persisted || persisted.state !== 'approved') {
      throw runtimeError('UI_APPROVAL_NOT_PERSISTED', 'The approval was not created by the extension-owned approval UI.');
    }
    if (stableStringify(persisted) !== stableStringify(approval)) {
      throw runtimeError('UI_APPROVAL_RECORD_MISMATCH', 'The supplied approval does not match its persisted extension-owned record.');
    }
    if (!plainObject(approval.scope) || approval.scope.actionId !== pending?.actionId) {
      throw runtimeError('UI_APPROVAL_SCOPE_MISMATCH', 'The local approval is not bound to this exact prepared action.');
    }
    assertPreparedActionContext(approval.scope, context);
    const expectedScope = bindPreparedAction(pending, context);
    if (stableStringify(approval.scope) !== stableStringify(expectedScope)) {
      throw runtimeError('UI_APPROVAL_SCOPE_MISMATCH', 'The prepared action changed after local approval.');
    }
    if (await fingerprintAction(approval.scope) !== approval.fingerprint) {
      throw runtimeError('UI_APPROVAL_FINGERPRINT_MISMATCH', 'The local approval fingerprint is invalid.');
    }
    return approval;
  }

  async function handleUiMessage(type, payload = {}) {
    if (!UI_MESSAGE_SET.has(type)) throw runtimeError('UI_MESSAGE_TYPE_INVALID', 'Unsupported side-panel message type.');
    const context = await activeContext();
    if (type === UI_MESSAGE_TYPES.UI_GET_STATE) {
      const auditTrail = await auditForSession({ tabId: context.tab.id, frameId: 0, sessionId: context.session.sessionId });
      const [entries, verified] = await Promise.all([auditTrail.entries(), auditTrail.verify()]);
      const audit = Object.freeze({
        verified,
        count: entries.length,
        head: entries.at(-1)?.hash ?? null,
        entries: Object.freeze(entries.slice(-24)),
      });
      const capture = clone(captureCache.get(captureKey(context.tab.id, 0, context.session.sessionId)) ?? null);
      const multimodalProvider = await multimodalSettings.publicState();
      return { ok: true, state: uiState(context.tab, visibleState(context.tab.id, 0, context.state), { audit, capture, multimodalProvider }) };
    }

    if (type === UI_MESSAGE_TYPES.UI_REANALYZE_MULTIMODAL) {
      const state = await serializeSnapshotIngest(context.tab.id, 0, async () => {
        const rawSnapshot = await requestRawSnapshot(context.tab.id, 0, context.session.sessionId);
        const bounded = boundedSnapshot(rawSnapshot);
        const captureEvidence = await captureActivationEvidence({
          tabId: context.tab.id,
          frameId: 0,
          sessionId: context.session.sessionId,
          snapshot: bounded.snapshot,
          mediaInventory: bounded.mediaInventory,
          windowId: context.tab.windowId,
          pageFingerprint: canonicalPageFingerprint(bounded.snapshot),
        });
        return ingestRaw({
          tabId: context.tab.id,
          frameId: 0,
          sessionId: context.session.sessionId,
          rawSnapshot,
          captureEvidence,
        });
      });
      return { ok: true, result: state, multimodalProvider: await multimodalSettings.publicState() };
    }

    if (type === UI_MESSAGE_TYPES.UI_PREPARE_ACTION) {
      const name = payload.actionId;
      if (typeof name !== 'string' || !context.state.tools.some((tool) => tool.name === name)) {
        throw runtimeError('TOOL_NOT_FOUND', 'The selected page action is no longer active.');
      }
      const result = await runtime.executeTool({
        tabId: context.tab.id,
        frameId: 0,
        sessionId: context.session.sessionId,
        name,
        input: plainObject(payload.arguments) ? payload.arguments : {},
      });
      const preparedAction = result?.status === 'approval-required'
        ? bindPreparedAction(result.preparedAction, context)
        : null;
      return {
        ok: true,
        result: preparedAction ? Object.freeze({ ...result, preparedAction }) : result,
        preparedAction,
      };
    }

    const pendingActions = runtime.state(context.tab.id, 0).pendingActions;
    if (type === UI_MESSAGE_TYPES.UI_APPROVE_ACTION && payload.decision === 'deny') {
      const actionId = payload.action?.actionId ?? payload.approval?.scope?.actionId;
      if (typeof actionId !== 'string') throw runtimeError('ACTION_NOT_PENDING', 'No exact pending action was supplied.');
      const pending = pendingActions.find((entry) => entry.actionId === actionId);
      assertPreparedActionContext(payload.action ?? payload.approval?.scope, context);
      if (stableStringify(payload.action ?? payload.approval.scope) !== stableStringify(bindPreparedAction(pending, context))) {
        throw runtimeError('UI_APPROVAL_SCOPE_MISMATCH', 'The prepared action changed before denial.');
      }
      return { ok: true, result: await runtime.deny({
        tabId: context.tab.id,
        frameId: 0,
        sessionId: context.session.sessionId,
        actionId,
      }) };
    }

    if (type === UI_MESSAGE_TYPES.UI_APPROVE_ACTION) {
      const approval = payload.approval;
      const actionId = approval?.scope?.actionId;
      const pending = pendingActions.find((entry) => entry.actionId === actionId);
      await assertLocalApproval(approval, pending, context);
      const envelope = await runtime.approve({
        tabId: context.tab.id,
        frameId: 0,
        sessionId: context.session.sessionId,
        actionId,
        ttlMs: Math.max(1, approval.expiresAt - captureClock(now)),
      });
      return { ok: true, actionId, approvalEnvelope: envelope };
    }

    const approval = payload.approval;
    const actionId = approval?.scope?.actionId;
    const pending = pendingActions.find((entry) => entry.actionId === actionId);
    await assertLocalApproval(approval, pending, context);
    const snapshot = await refreshSnapshot(context.tab.id, 0, context.session.sessionId);
    const result = await runtime.executeApproved({
      tabId: context.tab.id,
      frameId: 0,
      sessionId: context.session.sessionId,
      actionId,
      snapshot,
    });
    return { ok: true, result };
  }

  async function closeSession(session, reason) {
    if (!session) return false;
    const key = captureKey(session.tabId, session.frameId, session.sessionId);
    const evidence = captureCache.get(key);
    releaseCaptureEvidence(evidence);
    captureCache.delete(key);
    multimodalStateOverrides.delete(key);
    const closed = await runtime.close({
      tabId: session.tabId,
      frameId: session.frameId,
      sessionId: session.sessionId,
      reason,
    });
    if (closed) await releaseAuditSession(session);
    return closed;
  }

  const runtimeView = Object.freeze({
    ...runtime,
    state: (tabId, frameId = 0) => visibleState(tabId, frameId, runtime.state(tabId, frameId)),
  });

  return Object.freeze({
    runtime: runtimeView,
    ledger,
    localApprovalStore,
    browserCapture,
    multimodalSettings,
    captureState: (tabId, frameId, sessionId) => clone(captureCache.get(captureKey(tabId, frameId, sessionId)) ?? null),
    ingestPageSnapshot,
    ingestRaw,
    refreshSnapshot,
    handleUiMessage,
    closeSession,
    state: (tabId, frameId = 0) => visibleState(tabId, frameId, runtime.state(tabId, frameId)),
  });
}

export function isUiMessageType(type) {
  return UI_MESSAGE_SET.has(type);
}

export function asExtensionRuntimeError(error) {
  if (error instanceof ExtensionUniversalRuntimeError || error instanceof ProtocolError) return error;
  return runtimeError(error?.code ?? 'UNIVERSAL_RUNTIME_FAILED', error?.message ?? 'ToolBraid Universal runtime failed.');
}
