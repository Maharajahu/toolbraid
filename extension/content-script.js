// ToolBraid Universal isolated-world content script.
// It is the only page/extension relay. All window messages are origin-,
// session-, frame-, and nonce-bound before they are forwarded.
(function installToolBraidContent(global) {
  const protocol = global.ToolBraidUniversalProtocol;
  if (!protocol || !global.window || !global.chrome?.runtime) return;

  const stateKey = '__TOOLBRAID_UNIVERSAL_CONTENT__';
  const existing = global[stateKey];
  const state = existing ?? {
    session: null,
    pageInstanceId: null,
    listenersAttached: false,
    initAttempts: 0,
    pendingResponses: new Map(),
    snapshotTimer: null,
    snapshotPollTimer: null,
    mutationObserver: null,
    lastSnapshotFingerprint: null,
    snapshotInFlightFingerprint: null,
  };
  if (!existing) {
    Object.defineProperty(global, stateKey, {
      value: state,
      configurable: false,
      enumerable: false,
      writable: false,
    });
  }
  if (!state.pageInstanceId) state.pageInstanceId = protocol.createNonce?.();
  if (!state.pageInstanceId) return;

  const pageOrigin = () => global.location?.origin ?? '';

  function postToMain(envelope) {
    if (!state.session || !envelope) return false;
    try {
      global.window.postMessage(envelope, pageOrigin());
      return true;
    } catch {
      return false;
    }
  }

  function postErrorFor(request, response) {
    if (!state.session || !request?.requestId) return;
    const payload = response?.error
      ? response
      : { ok: false, error: { code: 'BRIDGE_UNAVAILABLE', message: 'ToolBraid bridge did not acknowledge the request.' }, provenance: protocol.PROVENANCE };
    const result = protocol.createEnvelope(protocol.TYPES.EXECUTE_RESULT, payload, state.session, request.requestId);
    postToMain(result);
  }

  function forwardPageEvent(envelope) {
    global.chrome.runtime.sendMessage({ type: protocol.TYPES.PAGE_EVENT, envelope }, (response) => {
      // Reading lastError is required in Chrome to consume a disconnected
      // receiver error without emitting an unhandled console warning.
      const runtimeError = global.chrome.runtime.lastError;
      if (runtimeError) {
        if (envelope.type === protocol.TYPES.EXECUTE_REQUEST) postErrorFor(envelope, null);
        return;
      }
      if (response?.envelope) {
        const parsed = protocol.parseEnvelope(response.envelope, state.session);
        if (parsed.ok) postToMain(parsed.value);
        else if (envelope.type === protocol.TYPES.EXECUTE_REQUEST) postErrorFor(envelope, response);
      } else if (envelope.type === protocol.TYPES.EXECUTE_REQUEST) {
        postErrorFor(envelope, response);
      }
    });
  }

  function boundExtensionMessage(message) {
    return Boolean(state.session
      && message?.sessionId === state.session.sessionId
      && message?.nonce === state.session.nonce
      && message?.tabId === state.session.tabId
      && (message?.frameId ?? 0) === state.session.frameId);
  }

  function extractSnapshot() {
    const extractor = global.ToolBraidUniversalPageExtractor ?? global.ToolBraidUniversal?.pageExtractor;
    if (!extractor || typeof extractor.extractPageSnapshot !== 'function') {
      throw Object.assign(new Error('ToolBraid page extractor is unavailable.'), { code: 'PAGE_EXTRACTOR_UNAVAILABLE' });
    }
    return extractor.extractPageSnapshot({ documentRef: global.document });
  }

  function snapshotError(error) {
    return {
      ok: false,
      error: {
        code: error?.code ?? 'SNAPSHOT_FAILED',
        message: error?.message ?? 'ToolBraid could not inspect the live page.',
        details: error?.details ?? {},
      },
      provenance: protocol.PROVENANCE,
    };
  }

  function sendSnapshot(reason = 'page-change', force = false) {
    if (!state.session) return;
    let snapshot;
    try {
      snapshot = extractSnapshot();
    } catch {
      return;
    }
    const fingerprint = snapshot.pageFingerprint;
    if (fingerprint === state.snapshotInFlightFingerprint) return;
    if (!force && fingerprint === state.lastSnapshotFingerprint) return;
    state.snapshotInFlightFingerprint = fingerprint;
    global.chrome.runtime.sendMessage({
      type: protocol.TYPES.PAGE_SNAPSHOT,
      sessionId: state.session.sessionId,
      nonce: state.session.nonce,
      snapshot,
      reason,
    }, (response) => {
      const runtimeError = global.chrome.runtime.lastError;
      if (state.snapshotInFlightFingerprint !== fingerprint) return;
      state.snapshotInFlightFingerprint = null;
      if (!runtimeError && response?.ok === true) state.lastSnapshotFingerprint = fingerprint;
    });
  }

  function scheduleSnapshot(reason = 'page-change') {
    if (state.snapshotTimer !== null) global.clearTimeout(state.snapshotTimer);
    state.snapshotTimer = global.setTimeout(() => {
      state.snapshotTimer = null;
      sendSnapshot(reason);
    }, 250);
  }

  function observePage() {
    if (!state.mutationObserver && typeof global.MutationObserver === 'function' && global.document?.documentElement) {
      state.mutationObserver = new global.MutationObserver(() => scheduleSnapshot('dom-mutation'));
      state.mutationObserver.observe(global.document.documentElement, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
        attributeFilter: ['aria-label', 'aria-expanded', 'aria-pressed', 'checked', 'disabled', 'href', 'role', 'selected', 'src', 'value'],
      });
    }
    // pushState and open-shadow-root changes do not reliably reach a document
    // MutationObserver from an isolated world. A bounded fingerprint poll
    // catches both without patching page-owned History APIs.
    if (state.snapshotPollTimer === null && typeof global.setInterval === 'function') {
      state.snapshotPollTimer = global.setInterval(() => sendSnapshot('periodic-fingerprint'), 1500);
    }
  }

  function sendReady() {
    const message = {
      type: protocol.TYPES.PAGE_READY,
      url: global.location?.href ?? '',
      pageInstanceId: state.pageInstanceId,
    };
    global.chrome.runtime.sendMessage(message, (response) => {
      const runtimeError = global.chrome.runtime.lastError;
      if (runtimeError || !response?.ok || !response.channel) return;
      const parsed = protocol.parseEnvelope(response.channel);
      if (!parsed.ok || parsed.value.type !== protocol.TYPES.CHANNEL_INIT) return;
      state.session = {
        nonce: parsed.value.nonce,
        sessionId: parsed.value.sessionId,
        tabId: parsed.value.tabId,
        frameId: parsed.value.frameId,
      };
      state.initAttempts = 0;
      observePage();
      sendSnapshot('activation', true);
      // The MAIN injector is installed immediately before this script, but a
      // service-worker restart can race the injection. Re-announce a bounded
      // number of times; failure remains a no-op rather than a direct fallback.
      const announce = () => {
        const envelope = protocol.createEnvelope(
          protocol.TYPES.CHANNEL_INIT,
          { provenance: protocol.PROVENANCE },
          state.session,
        );
        postToMain(envelope);
        state.initAttempts += 1;
        if (state.initAttempts < 5) global.setTimeout(announce, 100);
      };
      announce();
    });
  }

  function onWindowMessage(event) {
    if (event.source !== global.window || event.origin !== pageOrigin() || !state.session) return;
    const parsed = protocol.parseEnvelope(event.data, state.session);
    if (!parsed.ok) return;
    const envelope = parsed.value;
    if (envelope.type === protocol.TYPES.MAIN_READY) {
      forwardPageEvent(envelope);
      return;
    }
    if (envelope.type === protocol.TYPES.REGISTER_RESULT) {
      const respond = state.pendingResponses.get(envelope.requestId);
      if (!respond) return;
      state.pendingResponses.delete(envelope.requestId);
      respond({ ok: true, envelope });
      return;
    }
    if (envelope.type === protocol.TYPES.EXECUTE_REQUEST || envelope.type === protocol.TYPES.EXECUTE_CANCEL) {
      forwardPageEvent(envelope);
    }
  }

  function onRuntimeMessage(message, _sender, sendResponse) {
    if (!state.session || !message || typeof message !== 'object') return false;
    if (message.type === protocol.TYPES.CHANNEL_CLOSE) {
      state.session = null;
      state.mutationObserver?.disconnect?.();
      state.mutationObserver = null;
      if (state.snapshotTimer !== null) global.clearTimeout(state.snapshotTimer);
      state.snapshotTimer = null;
      if (state.snapshotPollTimer !== null) global.clearInterval?.(state.snapshotPollTimer);
      state.snapshotPollTimer = null;
      state.lastSnapshotFingerprint = null;
      state.snapshotInFlightFingerprint = null;
      for (const respond of state.pendingResponses.values()) respond({ ok: false, error: { code: 'SESSION_CLOSED', message: 'ToolBraid page session closed.' } });
      state.pendingResponses.clear();
      return false;
    }
    if (message.type === protocol.TYPES.PAGE_EXTRACT_SNAPSHOT) {
      if (!boundExtensionMessage(message)) {
        sendResponse?.({ ok: false, error: { code: 'BINDING_MISMATCH', message: 'Snapshot request did not match the active tab session.' } });
        return false;
      }
      try {
        sendResponse?.({ ok: true, snapshot: extractSnapshot(), provenance: protocol.PROVENANCE });
      } catch (error) {
        sendResponse?.(snapshotError(error));
      }
      return false;
    }
    if (message.type === protocol.TYPES.PAGE_ACTION_EXECUTE) {
      if (!boundExtensionMessage(message)) {
        sendResponse?.({ ok: false, error: { code: 'BINDING_MISMATCH', message: 'Action request did not match the active tab session.' } });
        return false;
      }
      const executor = global.ToolBraidUniversalActionExecutor ?? global.ToolBraidUniversal?.actionExecutor;
      if (!executor || typeof executor.safeExecute !== 'function') {
        sendResponse?.({ ok: false, error: { code: 'ACTION_EXECUTOR_UNAVAILABLE', message: 'The isolated action executor is unavailable.' } });
        return false;
      }
      const prepared = message.preparedAction;
      const targetBinding = prepared?.target?.binding ?? {};
      const classification = prepared?.classification;
      const sourceType = prepared?.descriptor?.sourceType ?? prepared?.target?.type;
      const actionArguments = prepared?.normalizedArguments ?? prepared?.arguments ?? {};
      const valueRoles = new Set(['checkbox', 'combobox', 'radio', 'slider', 'switch', 'textbox']);
      const valueTypes = new Set(['checkbox', 'color', 'date', 'datetime-local', 'email', 'month', 'number', 'radio', 'range', 'search', 'select', 'tel', 'text', 'textarea', 'time', 'url', 'week']);
      const valueInteraction = sourceType === 'control'
        && Object.keys(actionArguments).length > 0
        && (valueRoles.has(targetBinding.role) || valueTypes.has(targetBinding.type));
      const operation = classification === 'stage'
        ? 'set'
        : sourceType === 'form'
          ? 'submit'
          : valueInteraction
            ? 'set'
            : 'click';
      const result = executor.safeExecute({
        approved: message.approved === true,
        classification,
        operation,
        arguments: actionArguments,
        preparedAction: prepared,
        canonicalPageFingerprint: prepared?.pageFingerprint ?? null,
        extractorPageFingerprint: message.extractorPageFingerprint ?? null,
        binding: {
          canonicalPageFingerprint: prepared?.pageFingerprint ?? null,
          extractorFingerprint: message.extractorPageFingerprint ?? null,
          ref: prepared?.target?.ref ?? prepared?.targetRef ?? null,
          role: targetBinding.role ?? null,
          name: targetBinding.name ?? '',
          formRef: targetBinding.formRef ?? null,
          ...(targetBinding.type ? { type: targetBinding.type } : {}),
          targetFingerprint: prepared?.target?.targetFingerprint ?? null,
        },
      });
      if (!result?.ok) {
        sendResponse?.(result ?? { ok: false, error: { code: 'ACTION_EXECUTION_FAILED', message: 'The isolated action failed.' } });
        return false;
      }
      sendResponse?.({
        ok: true,
        receipt: {
          ...result,
          actionId: prepared?.actionId ?? null,
          mode: message.mode ?? classification,
          provenance: protocol.PROVENANCE,
        },
        provenance: protocol.PROVENANCE,
      });
      scheduleSnapshot('page-action');
      return false;
    }
    const parsed = protocol.parseEnvelope(message, state.session);
    if (!parsed.ok) return false;
    if (parsed.value.type !== protocol.TYPES.REGISTER_TOOLS) return false;
    if (typeof sendResponse !== 'function' || typeof parsed.value.requestId !== 'string') return false;
    state.pendingResponses.set(parsed.value.requestId, sendResponse);
    if (!postToMain(parsed.value)) {
      state.pendingResponses.delete(parsed.value.requestId);
      sendResponse({ ok: false, error: { code: 'MAIN_INJECTOR_UNAVAILABLE', message: 'ToolBraid MAIN injector is unavailable.' } });
    }
    return true;
  }

  if (!state.listenersAttached) {
    global.window.addEventListener('message', onWindowMessage);
    global.chrome.runtime.onMessage.addListener(onRuntimeMessage);
    state.listenersAttached = true;
  }
  // A repeated dynamic injection is a safe way to re-handshake after the
  // service worker has restarted; the page instance id remains document-local.
  sendReady();
}(globalThis));
