import {
  MESSAGE_TYPES,
  PROVENANCE,
  ProtocolError,
  createEnvelope,
  errorPayload,
  isInjectableUrl,
} from './protocol.js';
import { createUniversalBridge } from './bridge.js';
import { TabLifecycleRegistry, sessionBinding } from './lifecycle.js';
import { createChromeStorageAdapter } from '../src/persistence/index.js';
import {
  createGitHubAdapter,
  createSiteAdapterRegistry,
  createVercelAdapter,
  createXPostAdapter,
} from '../src/site-adapters/index.js';
import { HANDOFF_STATES, syntheticUiIntent } from '../src/runtime/handoff-broker.js';
import {
  HANDOFF_UI_MESSAGE_TYPES,
  createExtensionHandoffRuntime,
  isHandoffUiMessageType,
} from './handoff-runtime.js';
import {
  createExtensionMissionRuntime,
  isMissionUiMessageType,
} from './mission-runtime.js';
import {
  asExtensionRuntimeError,
  createExtensionUniversalRuntime,
  isUiMessageType,
  UI_MESSAGE_TYPES,
} from './universal-runtime.js';
import { clickVisibleCaptchaCheckbox } from './captcha-checkbox.js';
import { createExtensionMcpEndpoint, installNativeMcpBridge } from './native-mcp-bridge.js';

const PAGE_LIFECYCLE_PORT = 'toolbraid:page-lifecycle';
const HANDOFF_KEY_STORAGE_KEY = 'toolbraid.extension.handoff.key.v1';
const HANDOFF_SURFACE_KIND = 'toolbraid.sidepanel-created-handoff-surface';
const HANDOFF_SURFACE_CREATOR = 'sidepanel';
const SAFE_ERROR_CODE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const POSTCONDITION_ADAPTERS = createSiteAdapterRegistry({
  adapters: [createXPostAdapter(), createGitHubAdapter(), createVercelAdapter()],
});

function fail(code, message, details = {}) {
  return { ok: false, error: { code, message, details }, provenance: PROVENANCE };
}

function validTabId(tabId) {
  return Number.isInteger(tabId) && tabId >= 0;
}

function validFrameId(frameId) {
  return Number.isInteger(frameId) && frameId >= 0;
}

function safeFailure(error, fallbackCode = 'EXTENSION_RUNTIME_FAILED', fallbackMessage = 'ToolBraid rejected the request safely.') {
  const code = typeof error?.code === 'string' && SAFE_ERROR_CODE.test(error.code)
    ? error.code
    : fallbackCode;
  const message = typeof error?.message === 'string' && error.message.length <= 320
    ? error.message
    : fallbackMessage;
  return fail(code, message, {});
}

function exactOrigin(value) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    return url.origin;
  } catch {
    return null;
  }
}

function handoffSecret(cryptoRef) {
  if (!cryptoRef || typeof cryptoRef.getRandomValues !== 'function') {
    throw new ProtocolError('CRYPTO_UNAVAILABLE', 'Secure handoff key generation is unavailable.');
  }
  const bytes = new Uint8Array(32);
  cryptoRef.getRandomValues(bytes);
  return [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('');
}

function handoffIntent(state, intent) {
  return syntheticUiIntent({
    handoffId: state.handoffId,
    type: state.type,
    missionId: state.missionId,
    memberId: state.memberId,
    sessionId: state.sessionId,
    pageFingerprint: state.pageFingerprint,
    targetFingerprint: state.targetFingerprint,
    purpose: state.purpose,
    safeOrigin: state.safeOrigin,
    intent,
  });
}

function handoffProof(state) {
  return {
    kind: 'toolbraid.completion-proof',
    fresh: true,
    handoffId: state.handoffId,
    type: state.type,
    binding: {
      missionId: state.missionId,
      memberId: state.memberId,
      sessionId: state.sessionId,
      pageFingerprint: state.pageFingerprint,
      targetFingerprint: state.targetFingerprint,
      purpose: state.purpose,
      safeOrigin: state.safeOrigin,
    },
  };
}

function extensionPageSender(chromeApi, sender, expectedPath = null) {
  const runtimeId = chromeApi?.runtime?.id;
  if (typeof runtimeId !== 'string' || sender?.id !== runtimeId || sender?.tab) return false;
  try {
    const url = new URL(sender.url);
    if (url.protocol !== 'chrome-extension:'
      || url.hostname !== runtimeId
      || url.port !== ''
      || url.username !== ''
      || url.password !== '') return false;
    return expectedPath === null || url.pathname === `/${expectedPath}`;
  } catch {
    return false;
  }
}

function runtimeBridgeSender(chromeApi, sender) {
  return extensionPageSender(chromeApi, sender, 'bridge.html');
}

function runtimeUiSender(chromeApi, sender) {
  return extensionPageSender(chromeApi, sender, 'sidepanel.html');
}

function pageRuntimeSender(chromeApi, sender) {
  const runtimeId = chromeApi?.runtime?.id;
  const tabId = sender?.tab?.id;
  const frameId = sender?.frameId ?? 0;
  if (typeof runtimeId !== 'string' || sender?.id !== runtimeId
    || !validTabId(tabId) || !validFrameId(frameId)) return false;
  return isInjectableUrl(sender?.url ?? sender?.tab?.url ?? '');
}

function targetUrl(sender, message) {
  return sender?.url ?? sender?.tab?.url ?? message?.url ?? '';
}

function crossesOrigin(registry, tabId, changeInfo, tab) {
  const nextUrl = typeof changeInfo?.url === 'string'
    ? changeInfo.url
    : (typeof tab?.pendingUrl === 'string' ? tab.pendingUrl : null);
  if (!nextUrl) return false;
  const currentUrl = registry.get(tabId, 0)?.url;
  if (typeof currentUrl !== 'string') return false;
  try {
    return new URL(currentUrl).origin !== new URL(nextUrl).origin;
  } catch {
    return true;
  }
}

export function createServiceWorkerController({
  chromeApi,
  registry = new TabLifecycleRegistry(),
  sendToContentScript = null,
  executeHandler = null,
  cryptoRef = globalThis.crypto,
} = {}) {
  if (!chromeApi) throw new TypeError('chromeApi is required.');
  const send = sendToContentScript ?? (async (tabId, message, { frameId = 0 } = {}) => {
    if (!chromeApi.tabs?.sendMessage) throw new ProtocolError('CONTENT_SCRIPT_UNAVAILABLE', 'Chrome tabs.sendMessage is unavailable.');
    return chromeApi.tabs.sendMessage(tabId, message, { frameId });
  });
  const bridge = createUniversalBridge({ registry, sendToContentScript: send, executeHandler });
  let universalPromise = null;
  let missionPromise = null;
  let handoffPromise = null;
  const surfaceLifecycle = new Map();
  const handoffSurfaces = new Map();
  const captchaAttemptPromises = new Map();
  const reactivationOrigins = new Map();
  const reactivationPromises = new Map();
  const lifecycleForHandoff = Object.freeze({
    get(tabId, frameId = 0) {
      return surfaceLifecycle.get(`${tabId}:${frameId}`) ?? registry.get(tabId, frameId);
    },
  });

  function ensureUniversalRuntime() {
    if (!universalPromise) {
      universalPromise = createExtensionUniversalRuntime({
        chromeApi,
        registry,
        bridge,
        sendToContentScript: send,
        postconditionAdapterRegistry: POSTCONDITION_ADAPTERS,
      }).catch((error) => {
        universalPromise = null;
        throw error;
      });
    }
    return universalPromise;
  }

  function ensureMissionRuntime() {
    if (!missionPromise) {
      missionPromise = ensureUniversalRuntime()
        .then((universal) => createExtensionMissionRuntime({
          lifecycleRegistry: registry,
          universalRuntime: universal.runtime,
          store: createChromeStorageAdapter(chromeApi.storage.local),
        }))
        .catch((error) => {
          missionPromise = null;
          throw error;
        });
    }
    return missionPromise;
  }

  function ensureHandoffRuntime() {
    if (!handoffPromise) {
      handoffPromise = ensureMissionRuntime()
        .then(async (mission) => {
          const storageArea = chromeApi.storage.session ?? chromeApi.storage.local;
          const keyStore = createChromeStorageAdapter(storageArea);
          let persistenceKey = await keyStore.get(HANDOFF_KEY_STORAGE_KEY);
          if (persistenceKey === undefined) {
            persistenceKey = handoffSecret(cryptoRef);
            await keyStore.set(HANDOFF_KEY_STORAGE_KEY, persistenceKey);
          }
          if (typeof persistenceKey !== 'string' || !/^[a-f0-9]{64}$/.test(persistenceKey)) {
            throw new ProtocolError('HANDOFF_KEY_INVALID', 'The extension handoff key is invalid.');
          }
          return createExtensionHandoffRuntime({
            storageArea,
            persistenceKey,
            mission,
            lifecycle: lifecycleForHandoff,
            validateMissionBinding: (binding) => mission.validateBinding(binding),
            validateUiIntent: (token, expected) => token?.kind === 'toolbraid.synthetic-ui-intent'
              && token?.handoffId === expected.handoffId
              && token?.type === expected.type
              && token?.intent === expected.intent
              && token?.missionId === expected.missionId
              && token?.memberId === expected.memberId
              && token?.sessionId === expected.sessionId
              && token?.pageFingerprint === expected.pageFingerprint
              && token?.targetFingerprint === expected.targetFingerprint
              && token?.purpose === expected.purpose
              && token?.safeOrigin === expected.safeOrigin,
            validateCompletionProof: (proof, expected) => proof?.kind === 'toolbraid.completion-proof'
              && proof?.fresh === true
              && proof?.handoffId === expected.handoffId
              && proof?.type === expected.type
              && proof?.binding?.missionId === expected.missionId
              && proof?.binding?.memberId === expected.memberId
              && proof?.binding?.sessionId === expected.sessionId
              && proof?.binding?.pageFingerprint === expected.pageFingerprint
              && proof?.binding?.targetFingerprint === expected.targetFingerprint
              && proof?.binding?.purpose === expected.purpose
              && proof?.binding?.safeOrigin === expected.safeOrigin,
          });
        })
        .catch((error) => {
          handoffPromise = null;
          throw error;
        });
    }
    return handoffPromise;
  }

  function closeUniversalSessions(sessions, reason) {
    if (!universalPromise || !sessions?.length) return;
    void universalPromise.then((universal) => Promise.allSettled(
      sessions.map((session) => universal.closeSession(session, reason)),
    ));
  }

  async function browserTab(tabId) {
    if (!validTabId(tabId) || typeof chromeApi.tabs?.get !== 'function') {
      throw new ProtocolError('HANDOFF_SURFACE_UNAVAILABLE', 'The human handoff tab is unavailable.');
    }
    const tab = await chromeApi.tabs.get(tabId);
    if (!validTabId(tab?.id) || tab.id !== tabId || !Number.isInteger(tab?.windowId)) {
      throw new ProtocolError('HANDOFF_SURFACE_UNAVAILABLE', 'The human handoff tab is unavailable.');
    }
    return tab;
  }

  async function canonicalHandoffSurface(state, surfaceTabId) {
    const mission = await ensureMissionRuntime();
    const source = mission.getBinding(state.missionId, state.memberId);
    const session = registry.get(source.tabId, source.frameId);
    if (!session
      || session.sessionId !== state.sessionId
      || source.sessionId !== state.sessionId
      || source.pageFingerprint !== state.pageFingerprint
      || source.origin !== state.safeOrigin) {
      throw new ProtocolError('HANDOFF_SOURCE_DRIFT', 'The source page session is no longer current.');
    }
    const [sourceTab, surfaceTab] = await Promise.all([
      browserTab(source.tabId),
      browserTab(surfaceTabId),
    ]);
    const surfaceOrigin = exactOrigin(surfaceTab.pendingUrl ?? surfaceTab.url);
    if (!surfaceOrigin || surfaceOrigin !== state.safeOrigin) {
      throw new ProtocolError('HANDOFF_SURFACE_ORIGIN_MISMATCH', 'The human handoff tab is not on the exact approved origin.');
    }
    const binding = {
      missionId: state.missionId,
      memberId: state.memberId,
      sessionId: state.sessionId,
      pageFingerprint: state.pageFingerprint,
      targetFingerprint: state.targetFingerprint,
      purpose: state.purpose,
      safeOrigin: state.safeOrigin,
      tabId: source.tabId,
      frameId: source.frameId,
      windowId: sourceTab.windowId,
      documentId: session.documentId ?? null,
      pageInstanceId: session.pageInstanceId ?? null,
      origin: source.origin,
    };
    const surface = Object.freeze({
      kind: HANDOFF_SURFACE_KIND,
      createdBy: HANDOFF_SURFACE_CREATOR,
      surfaceId: `surface-${surfaceTab.id}-${state.handoffId.slice(0, 24)}`,
      tabId: surfaceTab.id,
      frameId: 0,
      windowId: surfaceTab.windowId,
      origin: surfaceOrigin,
      binding: Object.freeze(binding),
    });
    surfaceLifecycle.set(`${surface.tabId}:${surface.frameId}`, Object.freeze({ ...surface, state: 'active' }));
    handoffSurfaces.set(state.handoffId, surface);
    return surface;
  }

  async function refreshHandoffSurface(handoffId) {
    const surface = handoffSurfaces.get(handoffId);
    if (!surface) throw new ProtocolError('HANDOFF_SURFACE_REQUIRED', 'Open the human handoff again from the side panel.');
    const tab = await browserTab(surface.tabId);
    const origin = exactOrigin(tab.pendingUrl ?? tab.url);
    if (tab.windowId !== surface.windowId || origin !== surface.origin) {
      surfaceLifecycle.delete(`${surface.tabId}:${surface.frameId}`);
      handoffSurfaces.delete(handoffId);
      throw new ProtocolError('HANDOFF_SURFACE_DRIFT', 'The human handoff tab changed or closed.');
    }
    surfaceLifecycle.set(`${surface.tabId}:${surface.frameId}`, Object.freeze({ ...surface, state: 'active' }));
    return surface;
  }

  async function clickCaptchaCheckbox(surface) {
    if (!chromeApi.scripting || typeof chromeApi.scripting.executeScript !== 'function') {
      throw new ProtocolError('CAPTCHA_EXECUTION_UNAVAILABLE', 'The CAPTCHA surface execution API is unavailable.');
    }
    let results;
    try {
      results = await chromeApi.scripting.executeScript({
        target: { tabId: surface.tabId, frameIds: [0] },
        func: clickVisibleCaptchaCheckbox,
        world: 'ISOLATED',
      });
    } catch {
      throw new ProtocolError('CAPTCHA_EXECUTION_FAILED', 'The bounded CAPTCHA checkbox click could not be dispatched.');
    }
    const result = Array.isArray(results) ? results[0]?.result : results?.result;
    if (result?.ok !== true || result?.clicked !== true) {
      throw new ProtocolError(
        result?.error?.code ?? 'CAPTCHA_CHECKBOX_TARGET_INVALID',
        result?.error?.message ?? 'Exactly one visible top-frame CAPTCHA checkbox is required; no click was dispatched.',
      );
    }
    return result;
  }

  async function handleHandoffUiMessage(type, payload = {}) {
    const handoff = await ensureHandoffRuntime();
    if (type === HANDOFF_UI_MESSAGE_TYPES.GET_STATE) {
      return { ok: true, state: { handoffs: handoff.list() }, provenance: PROVENANCE };
    }
    if (type === HANDOFF_UI_MESSAGE_TYPES.REQUEST) {
      const mission = await ensureMissionRuntime();
      const binding = mission.getBinding(payload.missionId, payload.memberId);
      const sourceTab = await browserTab(binding.tabId);
      const state = await handoff.request({
        ...(typeof payload.handoffId === 'string' ? { handoffId: payload.handoffId } : {}),
        ...(Number.isFinite(payload.ttlMs) ? { ttlMs: payload.ttlMs } : {}),
        type: payload.type,
        missionId: binding.missionId,
        memberId: binding.memberId,
        sessionId: binding.sessionId,
        pageFingerprint: binding.pageFingerprint,
        targetFingerprint: payload.targetFingerprint ?? binding.pageFingerprint,
        purpose: payload.purpose,
        tabId: binding.tabId,
        frameId: binding.frameId,
        windowId: sourceTab.windowId,
        origin: binding.origin,
        safeOrigin: binding.origin,
      });
      return { ok: true, result: state, provenance: PROVENANCE };
    }
    if (type === HANDOFF_UI_MESSAGE_TYPES.OPEN_SURFACE) {
      const handoffId = payload.handoffId;
      let state = handoff.state(handoffId);
      const surface = await canonicalHandoffSurface(state, payload.surfaceTabId);
      if (state.state === HANDOFF_STATES.AWAITING_UI_GESTURE) {
        state = await handoff.open({ handoffId, uiIntent: handoffIntent(state, 'open') });
      }
      if (state.state === HANDOFF_STATES.OPENING) {
        state = await handoff.commit({ handoffId, surface });
      }
      if (state.state !== HANDOFF_STATES.HUMAN_ACTIVE) {
        throw new ProtocolError('HANDOFF_STATE_INVALID', 'The human handoff could not become active.');
      }
      return { ok: true, result: state, provenance: PROVENANCE };
    }
    if (type === HANDOFF_UI_MESSAGE_TYPES.CAPTCHA_ATTEMPT) {
      const handoffId = payload.handoffId;
      const state = handoff.state(handoffId);
      if (state.type !== 'captcha') {
        throw new ProtocolError('CAPTCHA_TYPE_REQUIRED', 'Checkbox attempts are only valid for CAPTCHA handoffs.');
      }
      if (state.state !== HANDOFF_STATES.HUMAN_ACTIVE) {
        throw new ProtocolError('HANDOFF_STATE_INVALID', 'The CAPTCHA handoff must be active in its exact human surface.');
      }
      if (state.captchaCheckboxAttempts >= 1) {
        throw new ProtocolError('CAPTCHA_ATTEMPT_LIMIT', 'Only one CAPTCHA checkbox attempt is permitted.');
      }
      const existing = captchaAttemptPromises.get(handoffId);
      if (existing) return existing;
      const attempt = (async () => {
        const currentSurface = await refreshHandoffSurface(handoffId);
        // Re-check the source mission binding immediately before the browser
        // operation; the broker's post-click validation must not be the first
        // place a source-page drift is discovered.
        const surface = await canonicalHandoffSurface(state, currentSurface.tabId);
        // The browser click is deliberately completed before the broker ledger
        // consumes the one allowed attempt. A missing/ambiguous target leaves
        // the human handoff active and never burns the attempt.
        await clickCaptchaCheckbox(surface);
        const attempted = await handoff.captchaCheckboxAttempt({
          handoffId,
          surface,
          uiIntent: handoffIntent(state, 'captcha-checkbox'),
        });
        return { ok: true, result: attempted, provenance: PROVENANCE };
      })();
      captchaAttemptPromises.set(handoffId, attempt);
      try {
        return await attempt;
      } finally {
        captchaAttemptPromises.delete(handoffId);
      }
    }
    if (type === HANDOFF_UI_MESSAGE_TYPES.COMPLETE) {
      const handoffId = payload.handoffId;
      const inFlightCaptcha = captchaAttemptPromises.get(handoffId);
      if (inFlightCaptcha) await inFlightCaptcha.catch(() => undefined);
      const state = handoff.state(handoffId);
      const surface = await refreshHandoffSurface(handoffId);
      const completed = await handoff.return({
        handoffId,
        surface,
        uiIntent: handoffIntent(state, 'complete'),
        completionProof: handoffProof(state),
      });
      surfaceLifecycle.delete(`${surface.tabId}:${surface.frameId}`);
      handoffSurfaces.delete(handoffId);
      return { ok: true, result: completed, provenance: PROVENANCE };
    }
    throw new ProtocolError('HANDOFF_UI_MESSAGE_INVALID', 'Unsupported handoff side-panel message type.');
  }

  function actionBinding(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const actionId = value.actionId ?? value.id;
    if (typeof actionId !== 'string') return null;
    return {
      actionId,
      tabId: value.tabId,
      frameId: value.frameId,
      sessionId: value.sessionId,
      origin: value.origin,
      pageFingerprint: value.pageFingerprint,
      ...(value.documentId === undefined ? {} : { documentId: value.documentId }),
      ...(value.pageInstanceId === undefined ? {} : { pageInstanceId: value.pageInstanceId }),
    };
  }

  async function bindPreparedActionToMission(preparedAction) {
    const binding = actionBinding(preparedAction);
    if (!binding) return { status: 'unbound', reason: 'ACTION_BINDING_INVALID' };
    let mission;
    try {
      mission = await ensureMissionRuntime();
      const owner = mission.findOwnerByBinding(binding);
      if (!owner) return { status: 'unbound', reason: 'NO_EXACT_MISSION_OWNER' };
      await mission.registerPendingAction({
        missionId: owner.missionId,
        memberId: owner.memberId,
        actionId: binding.actionId,
      });
      return {
        status: 'bound',
        missionId: owner.missionId,
        memberId: owner.memberId,
        actionId: binding.actionId,
      };
    } catch (error) {
      return {
        status: 'unbound',
        reason: typeof error?.code === 'string' ? error.code : 'MISSION_LINK_FAILED',
      };
    }
  }

  async function resolveMissionAction(value) {
    const binding = actionBinding(value);
    if (!binding) return { status: 'unresolved', reason: 'ACTION_BINDING_INVALID' };
    try {
      const mission = await ensureMissionRuntime();
      const owner = mission.findOwnerByBinding(binding);
      if (!owner) return { status: 'unresolved', reason: 'NO_EXACT_MISSION_OWNER' };
      const result = await mission.resolvePendingAction({
        missionId: owner.missionId,
        memberId: owner.memberId,
        actionId: binding.actionId,
      });
      return {
        status: result?.resolvedActionIds?.includes(binding.actionId) ? 'resolved' : 'already-resolved',
        missionId: owner.missionId,
        memberId: owner.memberId,
        actionId: binding.actionId,
      };
    } catch (error) {
      return {
        status: 'unresolved',
        reason: typeof error?.code === 'string' ? error.code : 'MISSION_RESOLUTION_FAILED',
      };
    }
  }

  async function handlePageReady(message, sender) {
    if (!pageRuntimeSender(chromeApi, sender)) return fail('PAGE_SENDER_INVALID', 'Page readiness must originate from an extension content script in an HTTP(S) tab.');
    const tabId = sender?.tab?.id;
    const frameId = sender?.frameId ?? 0;
    if (!validTabId(tabId) || !validFrameId(frameId)) return fail('PAGE_SENDER_INVALID', 'Page readiness must originate from a tab frame.');
    const url = targetUrl(sender, message);
    if (!isInjectableUrl(url)) return fail('URL_NOT_INJECTABLE', 'ToolBraid only runs on HTTP(S) pages.');
    if (message.pageInstanceId !== undefined && (typeof message.pageInstanceId !== 'string' || message.pageInstanceId.length < 16 || message.pageInstanceId.length > 256)) {
      return fail('PAGE_INSTANCE_INVALID', 'The page instance binding is invalid.');
    }
    const previous = registry.get(tabId, frameId);
    const accepted = registry.acceptPageReady(tabId, {
      frameId,
      documentId: sender?.documentId ?? null,
      pageInstanceId: message.pageInstanceId ?? null,
      url,
    });
    reactivationOrigins.set(tabId, exactOrigin(url));
    if (!accepted.reused && previous) closeUniversalSessions([previous], 'document-replaced');
    const channel = createEnvelope({
      type: MESSAGE_TYPES.CHANNEL_INIT,
      ...accepted.session,
      payload: { provenance: PROVENANCE },
    });
    return {
      ok: true,
      channel,
      reused: accepted.reused,
      provenance: PROVENANCE,
    };
  }

  async function handleBridgeRegistration(message, sender) {
    if (!runtimeBridgeSender(chromeApi, sender)) return fail('BRIDGE_SENDER_INVALID', 'Tool registration is accepted only from this extension.');
    const tabId = message?.tabId ?? message?.targetTabId;
    const frameId = message?.frameId ?? 0;
    return bridge.registerGeneratedTools({ tabId, frameId, sessionId: message?.sessionId, tools: message?.tools });
  }

  async function handlePageSnapshot(message, sender) {
    if (!pageRuntimeSender(chromeApi, sender)) return fail('PAGE_SENDER_INVALID', 'Snapshots must originate from an extension content script in an HTTP(S) tab.');
    const tabId = sender?.tab?.id;
    const frameId = sender?.frameId ?? 0;
    if (!validTabId(tabId) || !validFrameId(frameId)) return fail('PAGE_SENDER_INVALID', 'Snapshots must originate from a tab content script.');
    const session = registry.get(tabId, frameId);
    if (!session) return fail('SESSION_NOT_FOUND', 'The page session is no longer active.');
    if (message?.sessionId !== session.sessionId || message?.nonce !== session.nonce) {
      return fail('BINDING_MISMATCH', 'Snapshot binding did not match the active tab session.');
    }
    try {
      const universal = await ensureUniversalRuntime();
      const state = await universal.ingestPageSnapshot(message, sender);
      mcpEndpoint.invalidate();
      if (missionPromise) {
        await missionPromise
          .then((mission) => mission.handlePageSnapshot({ tabId, frameId }, sender))
          .catch(() => undefined);
      }
      return { ok: true, state, provenance: PROVENANCE };
    } catch (error) {
      const normalized = asExtensionRuntimeError(error);
      return fail(normalized.code, normalized.message, normalized.details);
    }
  }

  async function withMissionAndHandoffState(response) {
    if (response?.ok !== true) return response;
    const [missionResult, handoffResult] = await Promise.allSettled([
      ensureMissionRuntime().then((mission) => mission.list()),
      ensureHandoffRuntime().then((handoff) => handoff.list()),
    ]);
    return {
      ...response,
      state: {
        ...response.state,
        missions: missionResult.status === 'fulfilled' ? missionResult.value : [],
        handoffs: handoffResult.status === 'fulfilled' ? handoffResult.value : [],
        ...(missionResult.status === 'rejected' ? { missionError: safeFailure(missionResult.reason).error } : {}),
        ...(handoffResult.status === 'rejected' ? { handoffError: safeFailure(handoffResult.reason).error } : {}),
      },
    };
  }

  async function handleUiMessage(message, sender) {
    if (!runtimeUiSender(chromeApi, sender)) return fail('UI_SENDER_INVALID', 'Side-panel requests are accepted only from the canonical ToolBraid side-panel.');
    try {
      if (isMissionUiMessageType(message.type)) {
        const mission = await ensureMissionRuntime();
        return await mission.handleUiMessage(message.type, message.payload ?? {});
      }
      if (isHandoffUiMessageType(message.type)) {
        return await handleHandoffUiMessage(message.type, message.payload ?? {});
      }
      const universal = await ensureUniversalRuntime();
      if (message.type === UI_MESSAGE_TYPES.UI_PREPARE_ACTION) {
        const response = await universal.handleUiMessage(message.type, message.payload ?? {});
        if (response?.ok === true && response.result?.status === 'approval-required' && response.preparedAction) {
          const missionBinding = await bindPreparedActionToMission(response.preparedAction);
          return { ...response, missionBinding };
        }
        return response;
      }
      const actionForCleanup = (message.type === UI_MESSAGE_TYPES.UI_APPROVE_ACTION && message.payload?.decision === 'deny')
        || message.type === UI_MESSAGE_TYPES.UI_EXECUTE_ACTION
        ? actionBinding(message.payload?.action ?? message.payload?.approval?.scope)
        : null;
      let response;
      try {
        response = await universal.handleUiMessage(message.type, message.payload ?? {});
      } catch (error) {
        if (message.type === UI_MESSAGE_TYPES.UI_EXECUTE_ACTION && error?.code === 'ACTION_OUTCOME_UNKNOWN' && actionForCleanup) {
          await resolveMissionAction(actionForCleanup);
        }
        throw error;
      }
      let missionBinding = null;
      if (actionForCleanup) missionBinding = await resolveMissionAction(actionForCleanup);
      if (missionBinding) return { ...response, missionBinding };
      if (message.type !== 'UI_GET_STATE' || response?.ok !== true) return response;
      return withMissionAndHandoffState(response);
    } catch (error) {
      return safeFailure(error);
    }
  }

  async function handleRuntimeMessage(message, sender = {}) {
    try {
      if (!message || typeof message !== 'object' || Array.isArray(message)) return fail('MESSAGE_INVALID', 'ToolBraid runtime message must be an object.');
      if (message.type === MESSAGE_TYPES.PAGE_READY) return handlePageReady(message, sender);
      if (message.type === MESSAGE_TYPES.PAGE_SNAPSHOT) return handlePageSnapshot(message, sender);
      if (isUiMessageType(message.type)
          || isMissionUiMessageType(message.type)
          || isHandoffUiMessageType(message.type)) return handleUiMessage(message, sender);
      if (message.type === MESSAGE_TYPES.BRIDGE_REGISTER_TOOLS) return handleBridgeRegistration(message, sender);
      if (message.type === MESSAGE_TYPES.PAGE_EVENT) {
        if (!pageRuntimeSender(chromeApi, sender)) return fail('PAGE_SENDER_INVALID', 'Page events must originate from an extension content script in an HTTP(S) tab.');
        const result = await bridge.handlePageEnvelope(message.envelope, sender);
        if (result?.envelope) return result;
        return result;
      }
      return fail('MESSAGE_TYPE_UNEXPECTED', 'ToolBraid runtime message type is not accepted.');
    } catch {
      return fail('MESSAGE_INVALID', 'ToolBraid runtime message could not be processed safely.');
    }
  }

  async function mcpGetState(payload = {}) {
    const universal = await ensureUniversalRuntime();
    return withMissionAndHandoffState(await universal.handleUiMessage(UI_MESSAGE_TYPES.UI_GET_STATE, payload));
  }

  async function mcpExecuteRead(payload = {}) {
    const universal = await ensureUniversalRuntime();
    return universal.handleUiMessage(UI_MESSAGE_TYPES.UI_EXECUTE_READ, payload);
  }

  async function mcpPrepareAction(payload = {}) {
    const universal = await ensureUniversalRuntime();
    const response = await universal.handleUiMessage(UI_MESSAGE_TYPES.UI_PREPARE_ACTION, payload);
    if (response?.ok === true && response.result?.status === 'approval-required' && response.preparedAction) {
      const missionBinding = await bindPreparedActionToMission(response.preparedAction);
      return { ...response, missionBinding };
    }
    return response;
  }

  const mcpEndpoint = createExtensionMcpEndpoint({
    getState: mcpGetState,
    executeRead: mcpExecuteRead,
    prepareAction: mcpPrepareAction,
  });

  async function activateTab(tab) {
    const tabId = tab?.id;
    if (!validTabId(tabId)) return fail('TAB_ID_INVALID', 'An active tab id is required.');
    if (!isInjectableUrl(tab?.url ?? '')) return fail('URL_NOT_INJECTABLE', 'ToolBraid only runs on HTTP(S) pages.');
    const target = { tabId, frameIds: [0] };
    try {
      // MAIN first: the content script's handshake cannot be lost before the
      // page-world listener exists. Both scripts are still scoped to the
      // user-activated tab and do not require host_permissions.
      await chromeApi.scripting.executeScript({
        target,
        files: ['protocol-runtime.js', 'injector-main.js'],
        world: 'MAIN',
        injectImmediately: true,
      });
      await chromeApi.scripting.executeScript({
        target,
        files: ['protocol-runtime.js', 'page-extractor.js', 'action-executor.js', 'rendered-media-capture.js', 'content-script.js'],
        world: 'ISOLATED',
        injectImmediately: true,
      });
      reactivationOrigins.set(tabId, exactOrigin(tab.url));
      return { ok: true, tabId, provenance: PROVENANCE };
    } catch (error) {
      return fail(error?.code ?? 'INJECTION_FAILED', error?.message ?? 'ToolBraid could not initialize the active tab.');
    }
  }

  function reactivateTabAfterNavigation(tabId, tab) {
    if (reactivationPromises.has(tabId)) return;
    const expectedOrigin = reactivationOrigins.get(tabId);
    const actualOrigin = exactOrigin(tab?.url);
    if (!expectedOrigin || actualOrigin !== expectedOrigin) return;
    const pending = Promise.resolve(activateTab(tab))
      .then((result) => {
        if (result?.ok === true) return;
        const invalidated = registry.invalidate(tabId, 'reactivation-failed');
        closeUniversalSessions(invalidated, 'reactivation-failed');
        reactivationOrigins.delete(tabId);
      })
      .catch(() => {
        const invalidated = registry.invalidate(tabId, 'reactivation-failed');
        closeUniversalSessions(invalidated, 'reactivation-failed');
        reactivationOrigins.delete(tabId);
      })
      .finally(() => reactivationPromises.delete(tabId));
    reactivationPromises.set(tabId, pending);
  }

  function handleTabUpdated(tabId, changeInfo = {}, tab = {}) {
    if (!validTabId(tabId)) return [];
    if (changeInfo.status === 'loading' || typeof changeInfo.url === 'string') {
      mcpEndpoint.invalidate();
      const currentOrigin = exactOrigin(registry.get(tabId, 0)?.url ?? tab.url);
      if (currentOrigin) reactivationOrigins.set(tabId, currentOrigin);
    }
    if (missionPromise) {
      void missionPromise
        .then((mission) => mission.handleTabUpdated(tabId, changeInfo, tab))
        .catch(() => undefined);
    }
    for (const [handoffId, surface] of handoffSurfaces.entries()) {
      if (surface.tabId !== tabId) continue;
      const nextOrigin = exactOrigin(changeInfo.url ?? tab.pendingUrl ?? tab.url);
      if (changeInfo.status === 'loading' && nextOrigin && nextOrigin !== surface.origin) {
        surfaceLifecycle.delete(`${surface.tabId}:${surface.frameId}`);
        handoffSurfaces.delete(handoffId);
      }
    }
    // Chromium reports History API transitions as `loading`, indistinguishable
    // from a same-origin document navigation in tabs.onUpdated. Cross-origin
    // changes can be closed immediately. Same-origin authority is replaced by
    // the definitive documentId/pageInstanceId boundary in PAGE_READY; until
    // then live snapshot and content-channel binding still fail closed.
    if (changeInfo.status === 'loading' && crossesOrigin(registry, tabId, changeInfo, tab)) {
      const invalidated = registry.invalidate(tabId, 'navigation');
      closeUniversalSessions(invalidated, 'navigation');
      reactivationOrigins.delete(tabId);
      return invalidated;
    }
    if (changeInfo.status === 'loading' && typeof changeInfo.url !== 'string') {
      const invalidated = registry.invalidate(tabId, 'reload');
      closeUniversalSessions(invalidated, 'reload');
      return invalidated;
    }
    if (changeInfo.status === 'complete') reactivateTabAfterNavigation(tabId, tab);
    return [];
  }

  function handleTabRemoved(tabId) {
    if (!validTabId(tabId)) return [];
    mcpEndpoint.invalidate();
    reactivationOrigins.delete(tabId);
    reactivationPromises.delete(tabId);
    if (missionPromise) {
      void missionPromise
        .then((mission) => mission.handleTabRemoved(tabId))
        .catch(() => undefined);
    }
    for (const [handoffId, surface] of handoffSurfaces.entries()) {
      if (surface.tabId !== tabId) continue;
      surfaceLifecycle.delete(`${surface.tabId}:${surface.frameId}`);
      handoffSurfaces.delete(handoffId);
    }
    const invalidated = registry.invalidate(tabId, 'tab-closed');
    closeUniversalSessions(invalidated, 'tab-closed');
    return invalidated;
  }

  function handleActiveContextChanged() {
    mcpEndpoint.invalidate();
  }

  return Object.freeze({
    registry,
    bridge,
    handleRuntimeMessage,
    activateTab,
    handleTabUpdated,
    handleTabRemoved,
    handleActiveContextChanged,
    sessionBinding,
    ensureUniversalRuntime,
    ensureMissionRuntime,
    ensureHandoffRuntime,
    mcpEndpoint,
  });
}

export function installServiceWorker(chromeApi = globalThis.chrome) {
  if (!chromeApi?.runtime?.onMessage) return null;
  const controller = createServiceWorkerController({ chromeApi });
  const nativeMcpBridge = installNativeMcpBridge({ chromeApi, endpoint: controller.mcpEndpoint });
  chromeApi.runtime.onMessage.addListener((message, sender, sendResponse) => {
    Promise.resolve(controller.handleRuntimeMessage(message, sender))
      .then((response) => sendResponse(response))
      .catch((error) => sendResponse(errorPayload(error)));
    return true;
  });
  chromeApi.runtime.onConnect?.addListener((port) => {
    if (port?.name !== PAGE_LIFECYCLE_PORT) return;
    if (!pageRuntimeSender(chromeApi, port.sender)) {
      try {
        port.disconnect?.();
      } catch { /* an invalid lifecycle port remains unauthoritative */ }
      return;
    }
    port.onMessage?.addListener((message) => {
      if (message?.type !== MESSAGE_TYPES.PAGE_READY) return;
      Promise.resolve(controller.handleRuntimeMessage(message, port.sender))
        .then((response) => port.postMessage?.(response))
        .catch((error) => port.postMessage?.(errorPayload(error)))
        .catch?.(() => {});
    });
  });
  chromeApi.action?.onClicked?.addListener((tab) => {
    nativeMcpBridge.connect();
    if (Number.isInteger(tab?.id)) {
      try {
        const opened = chromeApi.sidePanel?.open?.({ tabId: tab.id });
        opened?.catch?.(() => {});
      } catch { /* unsupported side panel remains non-fatal */ }
    }
    void controller.activateTab(tab);
  });
  chromeApi.tabs?.onUpdated?.addListener((tabId, changeInfo, tab) => {
    controller.handleTabUpdated(tabId, changeInfo, tab);
  });
  chromeApi.tabs?.onRemoved?.addListener((tabId) => {
    controller.handleTabRemoved(tabId);
  });
  chromeApi.tabs?.onActivated?.addListener(() => {
    controller.handleActiveContextChanged();
  });
  chromeApi.windows?.onFocusChanged?.addListener(() => {
    controller.handleActiveContextChanged();
  });
  return controller;
}

const installedController = (typeof globalThis.chrome !== 'undefined')
  ? installServiceWorker(globalThis.chrome)
  : null;

export { installedController };
