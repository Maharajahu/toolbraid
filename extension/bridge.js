import {
  MESSAGE_TYPES,
  PROVENANCE,
  ProtocolError,
  createEnvelope,
  createRequestId,
  errorPayload,
  normalizeGeneratedToolDescriptions,
  parseEnvelope,
} from './protocol.js';

function fail(code, message, details = {}) {
  return { ok: false, error: { code, message, details }, provenance: PROVENANCE };
}

function validTabId(tabId) {
  return Number.isInteger(tabId) && tabId >= 0;
}

function validFrameId(frameId) {
  return Number.isInteger(frameId) && frameId >= 0;
}

function requireSession(registry, tabId, frameId) {
  if (!validTabId(tabId)) return { error: fail('TAB_ID_INVALID', 'A target tab id is required.') };
  if (!validFrameId(frameId)) return { error: fail('FRAME_ID_INVALID', 'A target frame id is required.') };
  const session = registry.get(tabId, frameId);
  if (!session) return { error: fail('SESSION_NOT_FOUND', 'The target tab has no active ToolBraid session.') };
  return { session };
}

function pageSenderBinding(sender) {
  const tabId = sender?.tab?.id;
  const frameId = sender?.frameId ?? 0;
  if (!validTabId(tabId) || !validFrameId(frameId)) return null;
  return { tabId, frameId };
}

/**
 * Routes trusted extension-UI requests to the isolated content script and
 * routes page-world execution requests to an optional ToolBraid executor.
 * There is intentionally no default executor: registration can work without
 * granting the extension authority to mutate external sites.
 */
export function createUniversalBridge({
  registry,
  sendToContentScript,
  executeHandler = null,
} = {}) {
  if (!registry || typeof registry.get !== 'function') throw new TypeError('A lifecycle registry is required.');
  if (typeof sendToContentScript !== 'function') throw new TypeError('sendToContentScript must be a function.');
  if (executeHandler !== null && typeof executeHandler !== 'function') throw new TypeError('executeHandler must be a function or null.');

  let executor = executeHandler;

  async function registerGeneratedTools({ tabId, frameId = 0, sessionId = null, tools = [] } = {}) {
    const target = requireSession(registry, tabId, frameId);
    if (target.error) return target.error;
    if (sessionId !== null && sessionId !== target.session.sessionId) {
      return fail('BINDING_MISMATCH', 'Generated tool registration did not match the active tab session.', {
        expected: target.session.sessionId,
        received: sessionId,
      });
    }
    let normalized;
    try {
      normalized = normalizeGeneratedToolDescriptions(tools);
    } catch (error) {
      return fail(error.code ?? 'TOOLS_INVALID', error.message);
    }

    const envelope = createEnvelope({
      type: MESSAGE_TYPES.REGISTER_TOOLS,
      ...target.session,
      requestId: createRequestId(),
      payload: {
        tools: normalized,
        provenance: PROVENANCE,
      },
    });
    try {
      const response = await sendToContentScript(tabId, envelope, { frameId });
      if (response && typeof response === 'object' && response.ok === false) return response;
      if (response?.envelope) {
        const parsed = parseEnvelope(response.envelope, target.session);
        if (!parsed.ok) return fail(parsed.error.code, parsed.error.message, parsed.error.details);
        if (parsed.value.type !== MESSAGE_TYPES.REGISTER_RESULT
          || parsed.value.requestId !== envelope.requestId) {
          return fail('REGISTRATION_RESPONSE_INVALID', 'The MAIN registration response did not match its request.');
        }
        const payload = parsed.value.payload;
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
          return fail('REGISTRATION_RESPONSE_INVALID', 'The MAIN registration response payload is invalid.');
        }
        if (payload.ok !== true) {
          return fail(
            payload.error?.code ?? 'REGISTRATION_FAILED',
            payload.error?.message ?? 'WebMCP registration failed.',
            { results: payload.results ?? [] },
          );
        }
        return {
          ...payload,
          tabId,
          frameId,
          sessionId: target.session.sessionId,
          count: normalized.length,
          provenance: PROVENANCE,
        };
      }
      return {
        ok: true,
        tabId,
        frameId,
        sessionId: target.session.sessionId,
        count: normalized.length,
        provenance: PROVENANCE,
      };
    } catch (error) {
      return fail(error?.code ?? 'CONTENT_SCRIPT_UNAVAILABLE', error?.message ?? 'The content script did not acknowledge registration.');
    }
  }

  async function handlePageEnvelope(envelope, sender) {
    const binding = pageSenderBinding(sender);
    if (!binding) return fail('PAGE_SENDER_INVALID', 'Execution requests must originate from a tab content script.');
    const session = registry.get(binding.tabId, binding.frameId);
    if (!session) return fail('SESSION_NOT_FOUND', 'The page session is no longer active.');
    const parsed = parseEnvelope(envelope, session);
    if (!parsed.ok) return fail(parsed.error.code, parsed.error.message, parsed.error.details);
    const { value } = parsed;

    if (value.type === MESSAGE_TYPES.MAIN_READY) {
      return {
        ok: true,
        type: MESSAGE_TYPES.MAIN_READY,
        sessionId: session.sessionId,
        provenance: PROVENANCE,
      };
    }
    if (value.type === MESSAGE_TYPES.EXECUTE_CANCEL) {
      return handleCancel(value, binding);
    }
    if (value.type !== MESSAGE_TYPES.EXECUTE_REQUEST) {
      return fail('MESSAGE_TYPE_UNEXPECTED', 'The page message is not an execution request.');
    }

    const payload = value.payload;
    if (!payload || typeof payload.toolId !== 'string' || payload.toolId.length < 1 || payload.toolId.length > 160) {
      return makeExecutionResponse(session, value, fail('TOOL_ID_INVALID', 'Execution requires a valid generated tool id.'));
    }
    if (payload.name !== undefined && (typeof payload.name !== 'string' || payload.name.length < 1 || payload.name.length > 128)) {
      return makeExecutionResponse(session, value, fail('TOOL_NAME_INVALID', 'Execution contains an invalid tool name.'));
    }
    if (payload.input !== undefined && (!payload.input || typeof payload.input !== 'object' || Array.isArray(payload.input))) {
      return makeExecutionResponse(session, value, fail('INPUT_INVALID', 'Execution input must be a JSON object.'));
    }
    if (!executor) {
      return makeExecutionResponse(session, value, fail(
        'EXECUTOR_UNAVAILABLE',
        'No ToolBraid execution authority is attached to this extension session.',
      ));
    }

    try {
      const result = await executor({
        tabId: binding.tabId,
        frameId: binding.frameId,
        sessionId: session.sessionId,
        toolId: payload.toolId,
        name: payload.name,
        input: payload.input ?? {},
        sourceProvenance: payload.sourceProvenance ?? null,
        requestId: value.requestId,
        provenance: PROVENANCE,
      });
      return makeExecutionResponse(session, value, {
        ok: true,
        result,
        provenance: PROVENANCE,
      });
    } catch (error) {
      return makeExecutionResponse(session, value, errorPayload(error, 'EXECUTION_FAILED'));
    }
  }

  function handleCancel(_envelope, _binding) {
    // Cancellation is advisory until an executor is supplied. We never turn a
    // cancel message into a second execution or a best-effort retry.
    return { ok: true, cancelled: true, provenance: PROVENANCE };
  }

  function makeExecutionResponse(session, request, payload) {
    try {
      return {
        ok: true,
        envelope: createEnvelope({
          type: MESSAGE_TYPES.EXECUTE_RESULT,
          ...session,
          requestId: request.requestId,
          payload,
        }),
        provenance: PROVENANCE,
      };
    } catch (error) {
      return fail(error.code ?? 'RESULT_INVALID', error.message);
    }
  }

  return Object.freeze({
    registerGeneratedTools,
    handlePageEnvelope,
    setExecutionHandler(handler) {
      if (handler !== null && typeof handler !== 'function') throw new TypeError('executeHandler must be a function or null.');
      executor = handler;
    },
    get hasExecutionHandler() {
      return executor !== null;
    },
  });
}
