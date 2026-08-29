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
import {
  asExtensionRuntimeError,
  createExtensionUniversalRuntime,
  isUiMessageType,
} from './universal-runtime.js';

function fail(code, message, details = {}) {
  return { ok: false, error: { code, message, details }, provenance: PROVENANCE };
}

function validTabId(tabId) {
  return Number.isInteger(tabId) && tabId >= 0;
}

function validFrameId(frameId) {
  return Number.isInteger(frameId) && frameId >= 0;
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
} = {}) {
  if (!chromeApi) throw new TypeError('chromeApi is required.');
  const send = sendToContentScript ?? (async (tabId, message, { frameId = 0 } = {}) => {
    if (!chromeApi.tabs?.sendMessage) throw new ProtocolError('CONTENT_SCRIPT_UNAVAILABLE', 'Chrome tabs.sendMessage is unavailable.');
    return chromeApi.tabs.sendMessage(tabId, message, { frameId });
  });
  const bridge = createUniversalBridge({ registry, sendToContentScript: send, executeHandler });
  let universalPromise = null;

  function ensureUniversalRuntime() {
    if (!universalPromise) {
      universalPromise = createExtensionUniversalRuntime({
        chromeApi,
        registry,
        bridge,
        sendToContentScript: send,
      }).catch((error) => {
        universalPromise = null;
        throw error;
      });
    }
    return universalPromise;
  }

  function closeUniversalSessions(sessions, reason) {
    if (!universalPromise || !sessions?.length) return;
    void universalPromise.then((universal) => Promise.allSettled(
      sessions.map((session) => universal.closeSession(session, reason)),
    ));
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
      return { ok: true, state, provenance: PROVENANCE };
    } catch (error) {
      const normalized = asExtensionRuntimeError(error);
      return fail(normalized.code, normalized.message, normalized.details);
    }
  }

  async function handleUiMessage(message, sender) {
    if (!runtimeUiSender(chromeApi, sender)) return fail('UI_SENDER_INVALID', 'Side-panel requests are accepted only from the canonical ToolBraid side-panel.');
    try {
      const universal = await ensureUniversalRuntime();
      return await universal.handleUiMessage(message.type, message.payload ?? {});
    } catch (error) {
      const normalized = asExtensionRuntimeError(error);
      return fail(normalized.code, normalized.message, normalized.details);
    }
  }

  async function handleRuntimeMessage(message, sender = {}) {
    try {
      if (!message || typeof message !== 'object' || Array.isArray(message)) return fail('MESSAGE_INVALID', 'ToolBraid runtime message must be an object.');
      if (message.type === MESSAGE_TYPES.PAGE_READY) return handlePageReady(message, sender);
      if (message.type === MESSAGE_TYPES.PAGE_SNAPSHOT) return handlePageSnapshot(message, sender);
      if (isUiMessageType(message.type)) return handleUiMessage(message, sender);
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
        files: ['protocol-runtime.js', 'page-extractor.js', 'action-executor.js', 'content-script.js'],
        world: 'ISOLATED',
        injectImmediately: true,
      });
      return { ok: true, tabId, provenance: PROVENANCE };
    } catch (error) {
      return fail(error?.code ?? 'INJECTION_FAILED', error?.message ?? 'ToolBraid could not initialize the active tab.');
    }
  }

  function handleTabUpdated(tabId, changeInfo = {}, tab = {}) {
    if (!validTabId(tabId)) return [];
    // Chromium reports History API transitions as `loading`, indistinguishable
    // from a same-origin document navigation in tabs.onUpdated. Cross-origin
    // changes can be closed immediately. Same-origin authority is replaced by
    // the definitive documentId/pageInstanceId boundary in PAGE_READY; until
    // then live snapshot and content-channel binding still fail closed.
    if (changeInfo.status === 'loading' && crossesOrigin(registry, tabId, changeInfo, tab)) {
      const invalidated = registry.invalidate(tabId, 'navigation');
      closeUniversalSessions(invalidated, 'navigation');
      return invalidated;
    }
    return [];
  }

  function handleTabRemoved(tabId) {
    if (!validTabId(tabId)) return [];
    const invalidated = registry.invalidate(tabId, 'tab-closed');
    closeUniversalSessions(invalidated, 'tab-closed');
    return invalidated;
  }

  return Object.freeze({
    registry,
    bridge,
    handleRuntimeMessage,
    activateTab,
    handleTabUpdated,
    handleTabRemoved,
    sessionBinding,
    ensureUniversalRuntime,
  });
}

export function installServiceWorker(chromeApi = globalThis.chrome) {
  if (!chromeApi?.runtime?.onMessage) return null;
  const controller = createServiceWorkerController({ chromeApi });
  chromeApi.runtime.onMessage.addListener((message, sender, sendResponse) => {
    Promise.resolve(controller.handleRuntimeMessage(message, sender))
      .then((response) => sendResponse(response))
      .catch((error) => sendResponse(errorPayload(error)));
    return true;
  });
  chromeApi.action?.onClicked?.addListener((tab) => {
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
  return controller;
}

const installedController = (typeof globalThis.chrome !== 'undefined')
  ? installServiceWorker(globalThis.chrome)
  : null;

export { installedController };
