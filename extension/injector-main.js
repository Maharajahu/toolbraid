// ToolBraid Universal MAIN-world injector.
// It owns only WebMCP registrations. External effects are delegated to the
// isolated content script and then to the service-worker bridge.
(function installToolBraidMain(global) {
  const protocol = global.ToolBraidUniversalProtocol;
  if (!protocol || !global.window || !global.document) return;

  const stateKey = '__TOOLBRAID_UNIVERSAL_MAIN__';
  const existing = global[stateKey];
  if (existing) {
    existing.reinject?.();
    return;
  }

  const state = {
    session: null,
    pending: new Map(),
    registrations: new Map(),
    registrationController: null,
    registrationFingerprint: null,
    reannounce: null,
    reinject: null,
  };
  Object.defineProperty(global, stateKey, {
    value: state,
    configurable: false,
    enumerable: false,
    writable: false,
  });

  const pageOrigin = () => global.location?.origin ?? '';

  function makeDomError(message, name = 'InvalidStateError') {
    try {
      return new DOMException(message, name);
    } catch {
      const error = new Error(message);
      error.name = name;
      return error;
    }
  }

  function post(type, payload, requestId = null) {
    if (!state.session) return false;
    const envelope = protocol.createEnvelope(type, payload, state.session, requestId);
    if (!envelope) return false;
    try {
      global.window.postMessage(envelope, pageOrigin());
      return true;
    } catch {
      return false;
    }
  }

  function rejectPending(reason) {
    for (const [requestId, request] of state.pending.entries()) {
      clearTimeout(request.timer);
      request.signal?.removeEventListener?.('abort', request.onAbort);
      request.reject(reason);
      state.pending.delete(requestId);
    }
  }

  function resetSession() {
    rejectPending(makeDomError('ToolBraid page session closed.', 'AbortError'));
    state.registrationController?.abort(makeDomError('ToolBraid page session closed.', 'AbortError'));
    state.registrationController = null;
    state.registrations.clear();
    state.registrationFingerprint = null;
    state.session = null;
  }

  function executionRequest(descriptor, input, options = {}, registrationSession = null) {
    if (!state.session || (registrationSession && state.session !== registrationSession)) {
      return Promise.reject(makeDomError('ToolBraid page session is unavailable.', 'AbortError'));
    }
    if (options.signal?.aborted) return Promise.reject(options.signal.reason ?? makeDomError('ToolBraid execution was aborted.', 'AbortError'));
    const requestId = protocol.createRequestId?.();
    if (!requestId) return Promise.reject(makeDomError('Secure randomness is unavailable for ToolBraid execution.', 'SecurityError'));
    const payload = {
      toolId: descriptor.id,
      name: descriptor.name,
      input: input === undefined ? {} : input,
      ...(descriptor.sourceProvenance === undefined ? {} : { sourceProvenance: descriptor.sourceProvenance }),
      provenance: protocol.PROVENANCE,
    };
    const envelope = protocol.createEnvelope(protocol.TYPES.EXECUTE_REQUEST, payload, state.session, requestId);
    if (!envelope) return Promise.reject(makeDomError('ToolBraid execution input could not cross the channel.', 'DataCloneError'));

    return new Promise((resolve, reject) => {
      const request = {
        resolve,
        reject,
        signal: options.signal,
        timer: null,
        onAbort: null,
      };
      request.timer = global.setTimeout(() => {
        if (!state.pending.delete(requestId)) return;
        options.signal?.removeEventListener?.('abort', request.onAbort);
        request.reject(makeDomError('ToolBraid execution timed out.', 'TimeoutError'));
        post(protocol.TYPES.EXECUTE_CANCEL, { provenance: protocol.PROVENANCE }, requestId);
      }, protocol.REQUEST_TIMEOUT_MS);
      request.onAbort = () => {
        if (!state.pending.delete(requestId)) return;
        clearTimeout(request.timer);
        options.signal?.removeEventListener?.('abort', request.onAbort);
        post(protocol.TYPES.EXECUTE_CANCEL, { provenance: protocol.PROVENANCE }, requestId);
        request.reject(options.signal.reason ?? makeDomError('ToolBraid execution was aborted.', 'AbortError'));
      };
      options.signal?.addEventListener?.('abort', request.onAbort, { once: true });
      state.pending.set(requestId, request);
      try {
        global.window.postMessage(envelope, pageOrigin());
      } catch (error) {
        state.pending.delete(requestId);
        clearTimeout(request.timer);
        options.signal?.removeEventListener?.('abort', request.onAbort);
        reject(error);
      }
    });
  }

  function fingerprint(descriptor) {
    return JSON.stringify({
      id: descriptor.id,
      name: descriptor.name,
      title: descriptor.title,
      description: descriptor.description,
      inputSchema: descriptor.inputSchema,
      annotations: descriptor.annotations,
      sourceProvenance: descriptor.sourceProvenance,
    });
  }

  async function registerTools(envelope) {
    const results = [];
    const registrationSession = state.session;
    const rawTools = envelope.payload?.tools;
    if (!Array.isArray(rawTools) || rawTools.length > 128) {
      return { ok: false, results, error: { code: 'TOOLS_INVALID', message: 'A bounded tool list is required.' }, provenance: protocol.PROVENANCE };
    }
    if (!protocol.isRecord(global.document.modelContext) || typeof global.document.modelContext.registerTool !== 'function') {
      return { ok: false, results, error: { code: 'WEBMCP_UNSUPPORTED', message: 'document.modelContext.registerTool is unavailable.' }, provenance: protocol.PROVENANCE };
    }

    const descriptors = [];
    for (let index = 0; index < rawTools.length; index += 1) {
      const descriptor = protocol.normalizeTool(rawTools[index], index);
      if (!descriptor) {
        results.push({ ok: false, error: { code: 'TOOL_DESCRIPTION_INVALID', message: `Generated tool ${index} was rejected.` } });
      } else {
        descriptors.push(descriptor);
      }
    }
    if (results.length > 0) return { ok: false, results, provenance: protocol.PROVENANCE };

    const ids = new Set();
    const names = new Set();
    for (const descriptor of descriptors) {
      if (ids.has(descriptor.id) || names.has(descriptor.name)) {
        results.push({ id: descriptor.id, name: descriptor.name, ok: false, error: { code: 'TOOL_DUPLICATE', message: 'Tool ids and names must be unique.' } });
      }
      ids.add(descriptor.id);
      names.add(descriptor.name);
    }
    if (results.length > 0) return { ok: false, results, provenance: protocol.PROVENANCE };

    const setFingerprint = JSON.stringify(descriptors.map((descriptor) => fingerprint(descriptor)));
    if (state.registrationFingerprint === setFingerprint && state.registrations.size === descriptors.length) {
      return {
        ok: true,
        results: descriptors.map((descriptor) => ({
          id: descriptor.id,
          name: descriptor.name,
          ok: true,
          reused: true,
          provenance: protocol.PROVENANCE,
        })),
        provenance: protocol.PROVENANCE,
      };
    }

    if (state.registrationController) state.registrationController.abort(makeDomError('Tool registrations replaced.', 'AbortError'));
    state.registrations.clear();
    state.registrationFingerprint = null;
    const controller = new AbortController();
    state.registrationController = controller;

    for (const descriptor of descriptors) {
      if (controller.signal.aborted || state.session !== registrationSession || state.registrationController !== controller) break;
      const key = descriptor.id;
      const definition = {
        name: descriptor.name,
        ...(descriptor.title === undefined ? {} : { title: descriptor.title }),
        description: descriptor.description,
        inputSchema: descriptor.inputSchema,
        annotations: { ...descriptor.annotations, provenance: protocol.PROVENANCE },
        execute: (input, options) => executionRequest(descriptor, input, options, registrationSession),
      };
      try {
        await global.document.modelContext.registerTool(definition, { signal: controller.signal });
        if (controller.signal.aborted || state.session !== registrationSession || state.registrationController !== controller) break;
        state.registrations.set(key, { fingerprint: fingerprint(descriptor), descriptor });
        results.push({ id: descriptor.id, name: descriptor.name, ok: true, provenance: protocol.PROVENANCE });
      } catch (error) {
        results.push({
          id: descriptor.id,
          name: descriptor.name,
          ok: false,
          error: { code: error?.code ?? 'REGISTRATION_FAILED', message: error?.message ?? 'WebMCP registration failed.' },
        });
      }
    }
    if (state.session !== registrationSession || state.registrationController !== controller) {
      return { ok: false, results, error: { code: 'SESSION_DRIFT', message: 'Tool registration was superseded by a new page session.' }, provenance: protocol.PROVENANCE };
    }
    const complete = results.length === descriptors.length && results.every((result) => result.ok);
    if (complete) state.registrationFingerprint = setFingerprint;
    else {
      controller.abort(makeDomError('Incomplete ToolBraid registration set.', 'AbortError'));
      state.registrations.clear();
      state.registrationFingerprint = null;
    }
    return {
      ok: complete,
      results,
      provenance: protocol.PROVENANCE,
    };
  }

  function handleResult(envelope) {
    const requestId = envelope.requestId;
    if (typeof requestId !== 'string') return;
    const request = state.pending.get(requestId);
    if (!request) return;
    state.pending.delete(requestId);
    clearTimeout(request.timer);
    request.signal?.removeEventListener?.('abort', request.onAbort);
    const payload = envelope.payload;
    if (payload?.ok === true) request.resolve(payload.result);
    else request.reject(makeDomError(payload?.error?.message ?? 'ToolBraid execution failed.', payload?.error?.code ?? 'ExecutionError'));
  }

  function announceReady() {
    post(protocol.TYPES.MAIN_READY, { provenance: protocol.PROVENANCE });
  }
  state.reannounce = announceReady;
  state.reinject = resetSession;

  function onMessage(event) {
    if (event.source !== global.window || event.origin !== pageOrigin()) return;
    if (!state.session) {
      const initial = protocol.parseEnvelope(event.data);
      if (!initial.ok || initial.value.type !== protocol.TYPES.CHANNEL_INIT) return;
      state.session = {
        nonce: initial.value.nonce,
        sessionId: initial.value.sessionId,
        tabId: initial.value.tabId,
        frameId: initial.value.frameId,
      };
      announceReady();
      return;
    }
    const parsed = protocol.parseEnvelope(event.data, state.session);
    if (!parsed.ok) return;
    const envelope = parsed.value;
    if (envelope.type === protocol.TYPES.CHANNEL_INIT) {
      announceReady();
    } else if (envelope.type === protocol.TYPES.CHANNEL_CLOSE) {
      resetSession();
    } else if (envelope.type === protocol.TYPES.REGISTER_TOOLS) {
      const registrationSession = state.session;
      registerTools(envelope).then((payload) => {
        if (state.session === registrationSession) post(protocol.TYPES.REGISTER_RESULT, payload, envelope.requestId);
      }).catch((error) => {
        if (state.session === registrationSession) {
          post(protocol.TYPES.REGISTER_RESULT, {
            ok: false,
            error: { code: error?.code ?? 'REGISTRATION_FAILED', message: error?.message ?? 'WebMCP registration failed.' },
            provenance: protocol.PROVENANCE,
          }, envelope.requestId);
        }
      });
    } else if (envelope.type === protocol.TYPES.EXECUTE_RESULT) {
      handleResult(envelope);
    }
  }

  global.window.addEventListener('message', onMessage);
}(globalThis));
