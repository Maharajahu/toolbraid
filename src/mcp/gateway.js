import {
  CURRENT_PROTOCOL_VERSION,
  JSON_RPC_ERROR_CODES,
  LEGACY_PROTOCOL_VERSIONS,
  MODERN_PROTOCOL_VERSIONS,
  SUPPORTED_PROTOCOL_VERSIONS,
  ProtocolError,
  classifyMessage,
  cloneJson,
  createSession,
  errorResponse,
  formatProtocolError,
  hasOwn,
  isJsonValue,
  isLegacyVersion,
  isModernVersion,
  isPlainObject,
  isRequestId,
  parseMessage,
  resultResponse,
  serializeMessage,
  unsupportedVersionError,
  validateLegacyInitializeParams,
  validateRequestMetadata,
} from './protocol.js';
import {
  PUBLIC_TOOL_NAMES,
  getToolDefinitions,
  getToolSchema,
  hasPublicTool,
} from './tools.js';
import { firstValidationMessage, validateJsonSchema } from './validator.js';

const DEFAULT_SERVER_INFO = Object.freeze({
  name: 'ToolBraid',
  version: '0.1.0',
  description: 'Secure semantic workflow control plane',
});

const DEFAULT_INSTRUCTIONS =
  'ToolBraid exposes semantic capabilities and policy-checked workflows. Workflow execution requires a trusted server-side approval; read-only replay never replays mutation nodes.';

const MODERN_RESULT_TYPE = 'complete';

function idKey(id) {
  return `${typeof id}:${String(id)}`;
}

function asSafeString(value, fallback, maxLength = 2048) {
  if (typeof value !== 'string' || value.length === 0) return fallback;
  return value.length > maxLength ? value.slice(0, maxLength) : value;
}

function textForValue(value) {
  if (typeof value === 'string') return value;
  if (value === undefined) return '';
  try {
    const encoded = JSON.stringify(value);
    return encoded === undefined ? String(value) : encoded;
  } catch {
    return '[unserializable tool result]';
  }
}

function normalizeServerInfo(value) {
  if (!isPlainObject(value)) return { ...DEFAULT_SERVER_INFO };
  return {
    ...DEFAULT_SERVER_INFO,
    ...value,
    name: asSafeString(value.name, DEFAULT_SERVER_INFO.name, 128),
    version: asSafeString(value.version, DEFAULT_SERVER_INFO.version, 128),
  };
}

function identityFromArguments(args) {
  const nested = isPlainObject(args.identity) ? args.identity : {};
  const tenantValues = ownValues(args, ['tenantId']).concat(ownValues(nested, ['tenantId']));
  // ToolBraid's runtime calls the subject field `subject`; MCP clients often
  // use `subjectId` or `userId`.  Accept the aliases as explicit input, but
  // never derive identity from clientInfo, process globals, or constructor
  // defaults.
  const subjectValues = ownValues(args, ['subject', 'subjectId', 'userId'])
    .concat(ownValues(nested, ['subject', 'subjectId', 'userId']));
  if (!consistentIdentityValues(tenantValues) || !consistentIdentityValues(subjectValues)) {
    return null;
  }
  return { tenantId: tenantValues[0], subjectId: subjectValues[0] };
}

function ownValues(value, names) {
  return names
    .filter((name) => Object.prototype.hasOwnProperty.call(value, name) && value[name] !== undefined)
    .map((name) => value[name]);
}

function consistentIdentityValues(values) {
  if (values.length === 0) return false;
  if (values.some((value) =>
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 256 ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/u.test(value))) return false;
  return values.every((value) => value === values[0]);
}

function toolExecutionError(code, message, details, modern) {
  const safeCode = asSafeString(code, 'tool_execution_error', 128);
  const safeMessage = asSafeString(message, 'Tool execution failed', 2048);
  const structuredContent = {
    code: safeCode,
    message: safeMessage,
    retryable: Boolean(details?.retryable),
  };
  if (details?.details !== undefined && isJsonValue(details.details)) {
    structuredContent.details = details.details;
  }
  const result = {
    content: [{ type: 'text', text: safeMessage }],
    structuredContent,
    isError: true,
  };
  if (modern) result.resultType = MODERN_RESULT_TYPE;
  return result;
}

function validContentBlock(block) {
  if (!isPlainObject(block) || typeof block.type !== 'string') return false;
  switch (block.type) {
    case 'text':
      return typeof block.text === 'string';
    case 'image':
    case 'audio':
      return typeof block.data === 'string' && typeof block.mimeType === 'string';
    case 'resource_link':
      return typeof block.uri === 'string';
    case 'resource':
      return isPlainObject(block.resource) && typeof block.resource.uri === 'string';
    default:
      return false;
  }
}

function normalizeToolResult(value, modern) {
  // A handler may return a complete MCP ToolResult, or an ordinary JSON value
  // which the gateway wraps in structured and text content.
  let result;
  if (value instanceof Error) {
    return toolExecutionError('tool_execution_error', value.message, undefined, modern);
  }
  if (
    isPlainObject(value) &&
    (hasOwn(value, 'content') || hasOwn(value, 'structuredContent') || hasOwn(value, 'isError'))
  ) {
    try {
      result = cloneJson(value);
    } catch {
      return toolExecutionError('invalid_tool_result', 'Tool returned non-JSON data', undefined, modern);
    }
  } else {
    result = {
      content: [{ type: 'text', text: textForValue(value) }],
      structuredContent: value === undefined ? null : value,
      isError: false,
    };
  }

  if (!isPlainObject(result)) {
    return toolExecutionError('invalid_tool_result', 'Tool returned an invalid result', undefined, modern);
  }
  if (result.content === undefined) {
    result.content = [
      {
        type: 'text',
        text: result.structuredContent === undefined ? '' : textForValue(result.structuredContent),
      },
    ];
  }
  if (!Array.isArray(result.content) || !result.content.every(validContentBlock)) {
    return toolExecutionError('invalid_tool_result', 'Tool returned invalid content', undefined, modern);
  }
  result.isError = Boolean(result.isError);
  if (modern) {
    result.resultType = typeof result.resultType === 'string' && result.resultType.length > 0
      ? result.resultType
      : MODERN_RESULT_TYPE;
  } else {
    delete result.resultType;
    // resultType was introduced after the legacy handshake era.  Do not leak
    // current-only fields into legacy clients through a handler's result.
  }
  if (!isJsonValue(result)) {
    return toolExecutionError('invalid_tool_result', 'Tool returned non-JSON data', undefined, modern);
  }
  return result;
}

function handlerFor(handlers, name) {
  if (!handlers) return undefined;
  if (handlers instanceof Map) {
    return handlers.get(name);
  }
  if (typeof handlers === 'function') return handlers;
  if (!isPlainObject(handlers) && typeof handlers !== 'object') return undefined;
  const aliases = [
    name,
    name.replace(/\./g, '_'),
    name.replace(/\.([a-z])/g, (_, letter) => letter.toUpperCase()),
  ];
  for (const alias of aliases) {
    const candidate = handlers[alias];
    if (typeof candidate === 'function') return candidate;
    if (candidate && typeof candidate.handle === 'function') return candidate.handle.bind(candidate);
  }
  return undefined;
}

function requestParams(message) {
  return message.params === undefined ? {} : message.params;
}

export class McpGateway {
  constructor(options = {}) {
    this.options = isPlainObject(options) ? options : {};
    this.serverInfo = normalizeServerInfo(this.options.serverInfo);
    this.instructions = asSafeString(this.options.instructions, DEFAULT_INSTRUCTIONS, 4096);
    this.requireIdentity = this.options.requireIdentity !== false;
    this.listTtlMs = Number.isSafeInteger(this.options.listTtlMs) && this.options.listTtlMs >= 0
      ? this.options.listTtlMs
      : 0;
    this.handlers = this.options.handlers ?? this.options.toolHandlers ?? this.options.tools;
    this.onToolCall = typeof this.options.onToolCall === 'function'
      ? this.options.onToolCall
      : undefined;
    this.defaultSession = createSession();
  }

  createSession() {
    return createSession();
  }

  /** Return a fresh copy so callers cannot mutate the public registry. */
  listTools({ legacy = false } = {}) {
    const tools = getToolDefinitions();
    if (legacy) return { tools };
    return {
      resultType: MODERN_RESULT_TYPE,
      tools,
      ttlMs: this.listTtlMs,
      cacheScope: 'public',
    };
  }

  async callTool(name, args = {}, context = {}) {
    const modern = context.modern !== false;
    if (!hasPublicTool(name)) {
      throw new ProtocolError(JSON_RPC_ERROR_CODES.INVALID_PARAMS, 'Unknown tool', { name });
    }
    if (!isPlainObject(args)) {
      throw new ProtocolError(JSON_RPC_ERROR_CODES.INVALID_PARAMS, 'Invalid params', {
        reason: 'arguments must be an object',
      });
    }
    // Identity is a security boundary, so report its absence/conflict before
    // generic schema diagnostics and never let a handler infer it elsewhere.
    if (this.requireIdentity && !identityFromArguments(args)) {
      return toolExecutionError(
        'identity_required',
        'Explicit tenantId and subjectId (or userId) are required',
        undefined,
        modern,
      );
    }
    const schemaResult = validateJsonSchema(args, getToolSchema(name));
    if (!schemaResult.valid) {
      return toolExecutionError(
        'invalid_tool_input',
        firstValidationMessage(schemaResult) ?? 'Tool arguments do not match the input schema',
        { details: { errors: schemaResult.errors } },
        modern,
      );
    }
    const handler = this.onToolCall ?? handlerFor(this.handlers, name);
    if (!handler) {
      return toolExecutionError(
        'tool_unavailable',
        'Tool handler is not configured',
        { retryable: true },
        modern,
      );
    }

    const callContext = {
      ...context,
      name,
      arguments: args,
      identity: identityFromArguments(args),
      serverInfo: this.serverInfo,
      gateway: this,
    };
    try {
      const value = await handler(args, callContext);
      return normalizeToolResult(value, modern);
    } catch (error) {
      const details = isPlainObject(error) ? error : undefined;
      return toolExecutionError(
        typeof error?.code === 'string' ? error.code : 'tool_execution_error',
        typeof error?.message === 'string' ? error.message : 'Tool execution failed',
        details,
        modern,
      );
    }
  }

  async dispatch(message, context = {}) {
    return this.handleMessage(message, context);
  }

  async handleRequest(message, context = {}) {
    return this.handleMessage(message, context);
  }

  /**
   * Handle one decoded JSON-RPC object or one newline-delimited JSON string.
   * Returns a response object, or null for notifications.
   */
  async handleMessage(input, context = {}) {
    let message;
    try {
      message = typeof input === 'string' || Buffer.isBuffer(input)
        ? parseMessage(input)
        : input;
    } catch (error) {
      return formatProtocolError(undefined, error);
    }

    // Current stdio framing carries one JSON-RPC object per line.  Batch arrays
    // belong to older JSON-RPC transports and are intentionally rejected here
    // unless a caller handles them before entering this gateway.
    if (Array.isArray(message)) {
      return errorResponse(undefined, JSON_RPC_ERROR_CODES.INVALID_REQUEST, 'Invalid Request', {
        reason: 'batch JSON-RPC messages are not supported on this transport',
      });
    }

    let classified;
    try {
      classified = classifyMessage(message);
    } catch (error) {
      return formatProtocolError(undefined, error);
    }

    const session = context.session ?? this.defaultSession;
    if (!isPlainObject(session) || !(session.pending instanceof Map)) {
      // A caller may provide a serialized session object.  Do not mutate it or
      // process requests without an isolated pending table.
      return classified.kind === 'notification'
        ? null
        : errorResponse(message.id, JSON_RPC_ERROR_CODES.INTERNAL_ERROR, 'Internal error');
    }

    const { kind } = classified;
    const request = classified.message;

    // Notifications are handled before request metadata negotiation.  Current
    // MCP permits notification metadata to be omitted, and cancellation must
    // be able to reach an in-flight request without a second handshake.
    if (kind === 'notification') {
      return this.#handleNotification(request, session, context);
    }

    const negotiated = this.#negotiateRequest(request, session);
    if (!negotiated.ok) return errorResponseFromNegotiation(request.id, negotiated.error);

    try {
      switch (request.method) {
        case 'initialize':
          return this.#initialize(request, session);
        case 'server/discover':
          return this.#discover(request, negotiated);
        case 'tools/list':
          return this.#list(request, negotiated);
        case 'tools/call':
          return await this.#call(request, negotiated, session, context);
        case 'ping':
          return resultResponse(
            request.id,
            this.#withServerInfo(
              negotiated.modern ? { resultType: MODERN_RESULT_TYPE } : {},
              negotiated.modern,
            ),
          );
        default:
          return errorResponse(
            request.id,
            JSON_RPC_ERROR_CODES.METHOD_NOT_FOUND,
            'Method not found',
          );
      }
    } catch (error) {
      if (error instanceof ProtocolError) return formatProtocolError(request.id, error);
      // Never put a handler stack or arbitrary thrown value on the wire.
      return errorResponse(request.id, JSON_RPC_ERROR_CODES.INTERNAL_ERROR, 'Internal error');
    }
  }

  async handleLine(line, context = {}) {
    const response = await this.handleMessage(line, context);
    return response === null || response === undefined ? null : serializeMessage(response);
  }

  #negotiateRequest(request, session) {
    const params = request.params;
    const hasMetadata = isPlainObject(params) && hasOwn(params, '_meta');

    if (request.method === 'initialize') {
      if (hasMetadata || session.era === 'modern') {
        return {
          ok: false,
          error: new ProtocolError(
            JSON_RPC_ERROR_CODES.INVALID_REQUEST,
            'Invalid Request',
            { reason: 'initialize is only valid for legacy MCP clients' },
          ),
        };
      }
      if (session.era === 'legacy' && session.initialized) {
        return {
          ok: false,
          error: new ProtocolError(
            JSON_RPC_ERROR_CODES.INVALID_REQUEST,
            'Invalid Request',
            { reason: 'initialize must be the first legacy request' },
          ),
        };
      }
      return { ok: true, modern: false, legacy: true, version: null, metadata: null };
    }

    if (hasMetadata) {
      const metadataResult = validateRequestMetadata(params);
      if (!metadataResult.ok) return metadataResult;
      if (!isModernVersion(metadataResult.version)) {
        // A metadata-bearing request is unambiguously a modern-era request;
        // do not reinterpret an unsupported version as a legacy handshake.
        session.era = 'modern';
        return {
          ok: false,
          error: new ProtocolError(
            JSON_RPC_ERROR_CODES.UNSUPPORTED_PROTOCOL_VERSION,
            'Unsupported protocol version',
            {
              supported: [...MODERN_PROTOCOL_VERSIONS],
              requested: metadataResult.version,
            },
          ),
        };
      }
      if (session.era === 'legacy') {
        return {
          ok: false,
          error: new ProtocolError(
            JSON_RPC_ERROR_CODES.INVALID_REQUEST,
            'Invalid Request',
            { reason: 'cannot mix modern metadata with a legacy session' },
          ),
        };
      }
      session.era = 'modern';
      session.protocolVersion = metadataResult.version;
      session.clientInfo = metadataResult.clientInfo;
      session.clientCapabilities = metadataResult.clientCapabilities;
      return {
        ok: true,
        modern: true,
        legacy: false,
        version: metadataResult.version,
        metadata: metadataResult.metadata,
        clientInfo: metadataResult.clientInfo,
        clientCapabilities: metadataResult.clientCapabilities,
      };
    }

    if (session.era === 'modern') {
      return {
        ok: false,
        error: new ProtocolError(
          JSON_RPC_ERROR_CODES.INVALID_PARAMS,
          'Invalid params',
          { reason: 'params._meta is required for the current MCP protocol' },
        ),
      };
    }
    if (session.era !== 'legacy') {
      return {
        ok: false,
        error: new ProtocolError(
          JSON_RPC_ERROR_CODES.INVALID_PARAMS,
          'Invalid params',
          { reason: 'params._meta is required for the current MCP protocol' },
        ),
      };
    }
    if (!session.initialized || !session.ready) {
      return {
        ok: false,
        error: new ProtocolError(
          JSON_RPC_ERROR_CODES.NOT_INITIALIZED,
          'Server not initialized',
        ),
      };
    }
    return {
      ok: true,
      modern: false,
      legacy: true,
      version: session.protocolVersion,
      metadata: null,
      clientInfo: session.clientInfo,
      clientCapabilities: session.clientCapabilities,
    };
  }

  #initialize(request, session) {
    const validation = validateLegacyInitializeParams(requestParams(request));
    if (!validation.ok) return errorResponseFromNegotiation(request.id, validation.error);

    let selectedVersion = validation.protocolVersion;
    if (isModernVersion(selectedVersion)) {
      // A legacy client accidentally asking for the modern revision still gets
      // a usable legacy revision, preserving the old handshake semantics.
      selectedVersion = LEGACY_PROTOCOL_VERSIONS[0];
    } else if (!isLegacyVersion(selectedVersion)) {
      return errorResponse(
        request.id,
        JSON_RPC_ERROR_CODES.INVALID_PARAMS,
        'Unsupported protocol version',
        { supported: [...LEGACY_PROTOCOL_VERSIONS], requested: validation.protocolVersion },
      );
    }
    if (LEGACY_PROTOCOL_VERSIONS.length === 0) {
      return unsupportedVersionError(request.id, validation.protocolVersion);
    }

    session.era = 'legacy';
    session.initialized = true;
    session.ready = false;
    session.protocolVersion = selectedVersion;
    session.clientInfo = validation.clientInfo;
    session.clientCapabilities = validation.capabilities;

    return resultResponse(request.id, {
      protocolVersion: selectedVersion,
      capabilities: {
        tools: { listChanged: false },
      },
      serverInfo: cloneJson(this.serverInfo),
      instructions: this.instructions,
    });
  }

  #discover(request, negotiated) {
    if (!negotiated.modern) {
      throw new ProtocolError(JSON_RPC_ERROR_CODES.METHOD_NOT_FOUND, 'Method not found');
    }
    const result = {
      resultType: MODERN_RESULT_TYPE,
      supportedVersions: [...MODERN_PROTOCOL_VERSIONS],
      capabilities: {
        tools: { listChanged: false },
      },
      _meta: {
        'io.modelcontextprotocol/serverInfo': cloneJson(this.serverInfo),
      },
      instructions: this.instructions,
      ttlMs: this.listTtlMs,
      cacheScope: 'public',
    };
    return resultResponse(request.id, result);
  }

  #list(request, negotiated) {
    const params = requestParams(request);
    if (params.cursor !== undefined && (typeof params.cursor !== 'string' || params.cursor.length === 0)) {
      throw new ProtocolError(JSON_RPC_ERROR_CODES.INVALID_PARAMS, 'Invalid params', {
        reason: 'cursor must be a non-empty string',
      });
    }
    // There are only six frozen tools, so one page is normally enough.  A
    // cursor is still accepted and validated for interoperability; no cursor
    // is emitted unless a caller supplies a configured page size.
    const pageSize = Number.isSafeInteger(this.options.pageSize) && this.options.pageSize > 0
      ? this.options.pageSize
      : PUBLIC_TOOL_NAMES.length;
    const allTools = getToolDefinitions();
    let start = 0;
    if (params.cursor !== undefined) {
      const match = /^tb:(\d+)$/.exec(params.cursor);
      if (!match) {
        throw new ProtocolError(JSON_RPC_ERROR_CODES.INVALID_PARAMS, 'Invalid params', {
          reason: 'cursor is invalid',
        });
      }
      start = Number(match[1]);
      if (!Number.isSafeInteger(start) || start > allTools.length) {
        throw new ProtocolError(JSON_RPC_ERROR_CODES.INVALID_PARAMS, 'Invalid params', {
          reason: 'cursor is invalid',
        });
      }
    }
    const tools = allTools.slice(start, start + pageSize);
    const result = negotiated.modern
      ? {
        resultType: MODERN_RESULT_TYPE,
        tools,
        ttlMs: this.listTtlMs,
        cacheScope: 'public',
      }
      : { tools };
    this.#withServerInfo(result, negotiated.modern);
    if (start + pageSize < allTools.length) result.nextCursor = `tb:${start + pageSize}`;
    return resultResponse(request.id, result);
  }

  async #call(request, negotiated, session, context) {
    const params = requestParams(request);
    if (typeof params.name !== 'string' || params.name.length === 0) {
      throw new ProtocolError(JSON_RPC_ERROR_CODES.INVALID_PARAMS, 'Invalid params', {
        reason: 'name is required',
      });
    }
    if (!hasPublicTool(params.name)) {
      throw new ProtocolError(JSON_RPC_ERROR_CODES.INVALID_PARAMS, 'Unknown tool', {
        name: params.name,
      });
    }
    const args = params.arguments === undefined ? {} : params.arguments;
    if (!isPlainObject(args)) {
      throw new ProtocolError(JSON_RPC_ERROR_CODES.INVALID_PARAMS, 'Invalid params', {
        reason: 'arguments must be an object',
      });
    }

    const controller = new AbortController();
    const key = idKey(request.id);
    if (session.pending.has(key)) {
      throw new ProtocolError(JSON_RPC_ERROR_CODES.INVALID_REQUEST, 'Invalid Request', {
        reason: 'request id is already in flight',
      });
    }
    const record = { controller, cancelled: false };
    session.pending.set(key, record);
    try {
      const toolResult = await this.callTool(params.name, args, {
        ...context,
        request,
        session,
        modern: negotiated.modern,
        protocolVersion: negotiated.version,
        metadata: negotiated.metadata,
        clientInfo: negotiated.clientInfo,
        clientCapabilities: negotiated.clientCapabilities,
        signal: controller.signal,
      });
      // Cancellation on stdio suppresses all subsequent messages for the
      // canceled request, even when a handler does not observe AbortSignal.
      if (record.cancelled) return null;
      this.#withServerInfo(toolResult, negotiated.modern);
      return resultResponse(request.id, toolResult);
    } finally {
      session.pending.delete(key);
    }
  }

  #handleNotification(notification, session, context) {
    switch (notification.method) {
      case 'notifications/initialized':
        if (session.era === 'legacy' && session.initialized) session.ready = true;
        return null;
      case 'notifications/cancelled': {
        const params = isPlainObject(notification.params) ? notification.params : {};
        const requestId = params.requestId ?? params.requestID;
        if (isRequestId(requestId)) {
          const record = session.pending.get(idKey(requestId));
          if (record) {
            record.cancelled = true;
            record.controller.abort();
          }
        }
        return null;
      }
      // Client-to-server notifications are intentionally no-ops unless they
      // affect the gateway's own lifecycle.  JSON-RPC notifications never get
      // a response, including unknown notification methods.
      default:
        return null;
    }
  }

  #withServerInfo(result, modern) {
    if (modern && isPlainObject(result)) {
      const metadata = isPlainObject(result._meta) ? result._meta : {};
      if (metadata['io.modelcontextprotocol/serverInfo'] === undefined) {
        metadata['io.modelcontextprotocol/serverInfo'] = cloneJson(this.serverInfo);
      }
      result._meta = metadata;
    }
    return result;
  }
}

function errorResponseFromNegotiation(id, error) {
  if (error instanceof ProtocolError) {
    return errorResponse(id, error.code, error.message, error.data);
  }
  return errorResponse(id, JSON_RPC_ERROR_CODES.INTERNAL_ERROR, 'Internal error');
}

export function createMcpGateway(options = {}) {
  return new McpGateway(options);
}

export {
  CURRENT_PROTOCOL_VERSION,
  LEGACY_PROTOCOL_VERSIONS,
  MODERN_PROTOCOL_VERSIONS,
  SUPPORTED_PROTOCOL_VERSIONS,
  PUBLIC_TOOL_NAMES,
};
