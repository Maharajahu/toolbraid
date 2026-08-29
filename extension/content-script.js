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
    readyEnabled: true,
    readyInFlight: false,
    readyPort: null,
    readyTimer: null,
    lifecyclePort: null,
    lifecycleReconnectTimer: null,
    pendingResponses: new Map(),
    snapshotTimer: null,
    snapshotPollTimer: null,
    mutationObserver: null,
    lastSnapshotFingerprint: null,
    snapshotInFlightFingerprint: null,
    renderedCaptureControllers: new Map(),
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
  state.readyEnabled = true;
  if (state.readyInFlight === undefined) state.readyInFlight = false;
  if (state.readyPort === undefined) state.readyPort = null;
  if (state.readyTimer === undefined) state.readyTimer = null;
  if (state.lifecyclePort === undefined) state.lifecyclePort = null;
  if (state.lifecycleReconnectTimer === undefined) state.lifecycleReconnectTimer = null;
  if (!(state.renderedCaptureControllers instanceof Map)) state.renderedCaptureControllers = new Map();

  const pageOrigin = () => global.location?.origin ?? '';
  const READY_HEARTBEAT_MS = 20_000;
  const LIFECYCLE_PORT_NAME = 'toolbraid:page-lifecycle';
  const MAX_ACTIVE_RENDERED_CAPTURES = 2;
  const MAX_RENDERED_CAPTURE_DURATION_MS = 3_000;
  const MAX_RENDERED_CAPTURE_BYTES = 4 * 1024 * 1024;
  const MAX_RENDERED_CAPTURE_TRACKS = 8;
  const MAX_RENDERED_CAPTURE_CUES = 256;
  const MAX_RENDERED_CAPTION_BYTES = 256 * 1024;
  const PAGE_FINGERPRINT = /^[a-f0-9]{64}$/i;

  function sameBinding(left, right) {
    return Boolean(left && right
      && left.nonce === right.nonce
      && left.sessionId === right.sessionId
      && left.tabId === right.tabId
      && left.frameId === right.frameId);
  }

  function postToMain(envelope) {
    if (!state.session || !envelope) return false;
    try {
      global.window.postMessage(envelope, pageOrigin());
      return true;
    } catch {
      return false;
    }
  }

  function postErrorFor(request, response, session = state.session) {
    if (!session || !request?.requestId) return;
    const payload = response?.error
      ? response
      : { ok: false, error: { code: 'BRIDGE_UNAVAILABLE', message: 'ToolBraid bridge did not acknowledge the request.' }, provenance: protocol.PROVENANCE };
    const result = protocol.createEnvelope(protocol.TYPES.EXECUTE_RESULT, payload, session, request.requestId);
    if (!result) return;
    try {
      global.window.postMessage(result, pageOrigin());
    } catch {
      // The request remains failed closed if the old MAIN channel disappeared.
    }
  }

  function forwardPageEvent(envelope) {
    const requestSession = state.session;
    if (!requestSession) return;
    global.chrome.runtime.sendMessage({ type: protocol.TYPES.PAGE_EVENT, envelope }, (response) => {
      // Reading lastError is required in Chrome to consume a disconnected
      // receiver error without emitting an unhandled console warning.
      const runtimeError = global.chrome.runtime.lastError;
      if (runtimeError) {
        if (envelope.type === protocol.TYPES.EXECUTE_REQUEST) postErrorFor(envelope, null, requestSession);
        return;
      }
      if (response?.ok === false && response?.error?.code === 'SESSION_NOT_FOUND') {
        if (envelope.type === protocol.TYPES.EXECUTE_REQUEST) postErrorFor(envelope, response, requestSession);
        requestReady();
        return;
      }
      if (!sameBinding(state.session, requestSession)) return;
      if (response?.envelope) {
        const parsed = protocol.parseEnvelope(response.envelope, requestSession);
        if (parsed.ok) postToMain(parsed.value);
        else if (envelope.type === protocol.TYPES.EXECUTE_REQUEST) postErrorFor(envelope, response, requestSession);
      } else if (envelope.type === protocol.TYPES.EXECUTE_REQUEST) {
        postErrorFor(envelope, response, requestSession);
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

  function clearCaptureBytes(result) {
    try { result?.bytes?.fill?.(0); } catch { /* best-effort zeroization */ }
  }

  function abortRenderedCaptures() {
    for (const controller of state.renderedCaptureControllers.values()) controller.abort();
    state.renderedCaptureControllers.clear();
  }

  function boundedInteger(value, minimum, maximum) {
    return Number.isInteger(value) && value >= minimum && value <= maximum;
  }

  function captureError(code, message) {
    return { ok: false, error: { code, message, details: {} }, provenance: protocol.PROVENANCE };
  }

  function base64Bytes(bytes) {
    if (!(bytes instanceof Uint8Array) || typeof global.btoa !== 'function') return null;
    let binary = '';
    for (let offset = 0; offset < bytes.byteLength; offset += 0x8000) {
      const chunk = bytes.subarray(offset, Math.min(offset + 0x8000, bytes.byteLength));
      binary += String.fromCharCode(...chunk);
    }
    return global.btoa(binary);
  }

  function captureTransport(result, mode) {
    if (!result || typeof result !== 'object' || Array.isArray(result)) return null;
    const { bytes, ...safe } = result;
    if (mode !== 'audio' || result.ok !== true) return safe;
    const audioBase64 = base64Bytes(bytes);
    try { bytes?.fill?.(0); } catch { /* best-effort zeroization after encoding */ }
    if (!audioBase64) return null;
    return { ...safe, audioBase64 };
  }

  function handleRenderedMediaCapture(message, sendResponse) {
    if (!boundExtensionMessage(message)) {
      sendResponse?.(captureError('BINDING_MISMATCH', 'Rendered media capture did not match the active tab session.'));
      return false;
    }
    const api = global.ToolBraidRenderedMediaCapture;
    if (!api || typeof api.captureRenderedMedia !== 'function' || typeof api.readLoadedCaptions !== 'function') {
      sendResponse?.(captureError('CAPTURE_UNSUPPORTED', 'The isolated rendered-media capture runtime is unavailable.'));
      return false;
    }
    const mode = message.mode;
    const requestId = message.requestId;
    if (!['audio', 'captions'].includes(mode)
      || typeof requestId !== 'string' || requestId.length < 8 || requestId.length > 256
      || state.renderedCaptureControllers.has(requestId)
      || message.provenance !== protocol.PROVENANCE
      || message.pageInstanceId !== state.pageInstanceId
      || !PAGE_FINGERPRINT.test(message.pageFingerprint ?? '')
      || !PAGE_FINGERPRINT.test(message.extractorPageFingerprint ?? '')
      || !boundedInteger(message.durationMs, 1, MAX_RENDERED_CAPTURE_DURATION_MS)
      || !boundedInteger(message.maxBytes, 1, MAX_RENDERED_CAPTURE_BYTES)
      || !boundedInteger(message.maxTracks, 1, MAX_RENDERED_CAPTURE_TRACKS)
      || !boundedInteger(message.maxCues, 1, MAX_RENDERED_CAPTURE_CUES)
      || !boundedInteger(message.maxCaptionBytes, 1, MAX_RENDERED_CAPTION_BYTES)) {
      sendResponse?.(captureError('CAPTURE_REQUEST_INVALID', 'The rendered media capture request is invalid.'));
      return false;
    }
    if (state.renderedCaptureControllers.size >= MAX_ACTIVE_RENDERED_CAPTURES) {
      sendResponse?.(captureError('CAPTURE_BUSY', 'The rendered media capture concurrency limit was reached.'));
      return false;
    }
    let before;
    try { before = extractSnapshot(); } catch (error) {
      sendResponse?.(snapshotError(error));
      return false;
    }
    if (typeof message.extractorPageFingerprint !== 'string'
      || before.pageFingerprint !== message.extractorPageFingerprint) {
      sendResponse?.(captureError('CAPTURE_PAGE_DRIFT', 'The page changed before rendered media capture.'));
      return false;
    }
    const controller = new AbortController();
    state.renderedCaptureControllers.set(requestId, controller);
    const request = {
      elementRef: message.elementRef,
      kind: message.kind,
      durationMs: message.durationMs,
      maxBytes: message.maxBytes,
      maxTracks: message.maxTracks,
      maxCues: message.maxCues,
      maxCaptionBytes: message.maxCaptionBytes,
      signal: controller.signal,
    };
    const operation = mode === 'audio'
      ? api.captureRenderedMedia(request)
      : api.readLoadedCaptions(request);
    Promise.resolve(operation).then((result) => {
      if (state.renderedCaptureControllers.get(requestId) !== controller || !boundExtensionMessage(message)) {
        clearCaptureBytes(result);
        sendResponse?.(captureError('CAPTURE_SESSION_DRIFT', 'The page session changed during rendered media capture.'));
        return;
      }
      let after;
      try { after = extractSnapshot(); } catch {
        clearCaptureBytes(result);
        sendResponse?.(captureError('CAPTURE_PAGE_DRIFT', 'The page could not be rebound after rendered media capture.'));
        return;
      }
      if (after.pageFingerprint !== message.extractorPageFingerprint
        || result?.metadata?.pageOrigin !== pageOrigin()
        || result?.metadata?.elementRef !== message.elementRef
        || result?.metadata?.sourceKind !== message.kind) {
        clearCaptureBytes(result);
        sendResponse?.(captureError('CAPTURE_PAGE_DRIFT', 'The page or media target changed during rendered media capture.'));
        return;
      }
      const transport = captureTransport(result, mode);
      if (!transport) {
        clearCaptureBytes(result);
        sendResponse?.(captureError('CAPTURE_ENCODING_FAILED', 'Rendered media bytes could not be encoded safely.'));
        return;
      }
      sendResponse?.({
        ok: true,
        result: transport,
        requestId,
        tabId: message.tabId,
        frameId: message.frameId,
        sessionId: message.sessionId,
        nonce: message.nonce,
        pageInstanceId: message.pageInstanceId,
        documentId: message.documentId ?? null,
        pageFingerprint: message.pageFingerprint,
        extractorPageFingerprint: after.pageFingerprint,
        provenance: protocol.PROVENANCE,
      });
    }, () => {
      sendResponse?.(captureError('CAPTURE_FAILED', 'Rendered media capture failed safely.'));
    }).finally(() => {
      if (state.renderedCaptureControllers.get(requestId) === controller) {
        state.renderedCaptureControllers.delete(requestId);
      }
    });
    return true;
  }

  function cancelRenderedMediaCapture(message, sendResponse) {
    if (!boundExtensionMessage(message) || message.provenance !== protocol.PROVENANCE
      || typeof message.requestId !== 'string') {
      sendResponse?.(captureError('BINDING_MISMATCH', 'Rendered media cancellation did not match the active tab session.'));
      return false;
    }
    const controller = state.renderedCaptureControllers.get(message.requestId);
    if (controller) {
      controller.abort();
      state.renderedCaptureControllers.delete(message.requestId);
    }
    sendResponse?.({ ok: true, cancelled: Boolean(controller), requestId: message.requestId, provenance: protocol.PROVENANCE });
    return false;
  }

  function sendSnapshot(reason = 'page-change', force = false) {
    if (!state.session) return;
    const requestSession = state.session;
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
      sessionId: requestSession.sessionId,
      nonce: requestSession.nonce,
      snapshot,
      reason,
    }, (response) => {
      const runtimeError = global.chrome.runtime.lastError;
      if (!sameBinding(state.session, requestSession)) return;
      if (state.snapshotInFlightFingerprint !== fingerprint) return;
      state.snapshotInFlightFingerprint = null;
      abortRenderedCaptures();
      if (!runtimeError && response?.ok === false && response?.error?.code === 'SESSION_NOT_FOUND') {
        requestReady();
        return;
      }
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

  function scheduleReady() {
    if (!state.readyEnabled || state.readyTimer !== null || typeof global.setTimeout !== 'function') return;
    state.readyTimer = global.setTimeout(() => {
      state.readyTimer = null;
      sendReady();
    }, READY_HEARTBEAT_MS);
  }

  function connectLifecyclePort() {
    if (!state.readyEnabled || state.lifecyclePort || typeof global.chrome.runtime.connect !== 'function') return;
    let port;
    try {
      port = global.chrome.runtime.connect({ name: LIFECYCLE_PORT_NAME });
    } catch {
      return;
    }
    if (!port || typeof port.postMessage !== 'function'
      || !port.onMessage || typeof port.onMessage.addListener !== 'function'
      || !port.onDisconnect || typeof port.onDisconnect.addListener !== 'function') return;
    state.lifecyclePort = port;
    port.onMessage.addListener((response) => {
      if (state.lifecyclePort !== port || state.readyPort !== port || !state.readyInFlight) return;
      finishReady(response, null, port);
    });
    port.onDisconnect.addListener(() => {
      // Consume Chrome's connection error before scheduling a bounded recovery.
      const runtimeError = global.chrome.runtime.lastError;
      void runtimeError;
      if (state.lifecyclePort !== port) return;
      state.lifecyclePort = null;
      if (state.readyPort === port) {
        state.readyPort = null;
        state.readyInFlight = false;
      }
      if (!state.readyEnabled || state.lifecycleReconnectTimer !== null) return;
      state.lifecycleReconnectTimer = global.setTimeout(() => {
        state.lifecycleReconnectTimer = null;
        requestReady();
      }, 250);
    });
  }

  function requestReady() {
    if (!state.readyEnabled) return;
    connectLifecyclePort();
    if (state.readyTimer !== null) global.clearTimeout(state.readyTimer);
    state.readyTimer = null;
    sendReady();
  }

  function sendReady() {
    if (!state.readyEnabled || state.readyInFlight) return;
    state.readyInFlight = true;
    const message = {
      type: protocol.TYPES.PAGE_READY,
      url: global.location?.href ?? '',
      pageInstanceId: state.pageInstanceId,
    };
    connectLifecyclePort();
    const port = state.lifecyclePort;
    if (port) {
      state.readyPort = port;
      try {
        port.postMessage(message);
        return;
      } catch {
        state.readyPort = null;
        state.lifecyclePort = null;
        try {
          port.disconnect?.();
        } catch { /* fall through to one-time messaging */ }
      }
    }
    try {
      global.chrome.runtime.sendMessage(message, (response) => {
        const runtimeError = global.chrome.runtime.lastError;
        finishReady(response, runtimeError, null);
      });
    } catch {
      state.readyInFlight = false;
      scheduleReady();
    }
  }

  function finishReady(response, runtimeError, port) {
    if (port !== null && (state.lifecyclePort !== port || state.readyPort !== port)) return;
    if (port === null && state.readyPort !== null) return;
    state.readyInFlight = false;
    state.readyPort = null;
    if (!state.readyEnabled) return;
    scheduleReady();
    if (runtimeError || !response?.ok || !response.channel) return;
    const parsed = protocol.parseEnvelope(response.channel);
    if (!parsed.ok || parsed.value.type !== protocol.TYPES.CHANNEL_INIT) return;
    const nextSession = {
      nonce: parsed.value.nonce,
      sessionId: parsed.value.sessionId,
      tabId: parsed.value.tabId,
      frameId: parsed.value.frameId,
    };
    if (sameBinding(state.session, nextSession)) return;
    const previousSession = state.session;
    if (previousSession) {
      abortRenderedCaptures();
      const close = protocol.createEnvelope(
        protocol.TYPES.CHANNEL_CLOSE,
        { provenance: protocol.PROVENANCE, reason: 'binding-replaced' },
        previousSession,
      );
      postToMain(close);
      for (const respond of state.pendingResponses.values()) {
        respond({ ok: false, error: { code: 'SESSION_CLOSED', message: 'ToolBraid page session was replaced.' } });
      }
      state.pendingResponses.clear();
    }
    state.session = nextSession;
    state.lastSnapshotFingerprint = null;
    state.snapshotInFlightFingerprint = null;
    if (state.snapshotTimer !== null) global.clearTimeout(state.snapshotTimer);
    state.snapshotTimer = null;
    state.initAttempts = 0;
    // The MAIN injector is installed immediately before this script, but a
    // service-worker restart can race the injection. Re-announce a bounded
    // number of times; failure remains a no-op rather than a direct fallback.
    const announce = () => {
      if (!sameBinding(state.session, nextSession)) return;
      const envelope = protocol.createEnvelope(
        protocol.TYPES.CHANNEL_INIT,
        { provenance: protocol.PROVENANCE },
        nextSession,
      );
      postToMain(envelope);
      state.initAttempts += 1;
      if (state.initAttempts < 5) global.setTimeout(announce, 100);
    };
    announce();
    observePage();
    sendSnapshot('activation', true);
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
      state.readyEnabled = false;
      const lifecyclePort = state.lifecyclePort;
      state.lifecyclePort = null;
      try {
        lifecyclePort?.disconnect?.();
      } catch { /* an already closed lifecycle port is inert */ }
      if (state.lifecycleReconnectTimer !== null) global.clearTimeout(state.lifecycleReconnectTimer);
      state.lifecycleReconnectTimer = null;
      state.session = null;
      state.mutationObserver?.disconnect?.();
      state.mutationObserver = null;
      if (state.snapshotTimer !== null) global.clearTimeout(state.snapshotTimer);
      state.snapshotTimer = null;
      if (state.snapshotPollTimer !== null) global.clearInterval?.(state.snapshotPollTimer);
      state.snapshotPollTimer = null;
      if (state.readyTimer !== null) global.clearTimeout(state.readyTimer);
      state.readyTimer = null;
      state.lastSnapshotFingerprint = null;
      state.snapshotInFlightFingerprint = null;
      abortRenderedCaptures();
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
    if (message.type === protocol.TYPES.PAGE_CAPTURE_RENDERED_MEDIA) {
      return handleRenderedMediaCapture(message, sendResponse);
    }
    if (message.type === protocol.TYPES.PAGE_CAPTURE_RENDERED_MEDIA_CANCEL) {
      return cancelRenderedMediaCapture(message, sendResponse);
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
  requestReady();
}(globalThis));
