/**
 * MCP wire protocol helpers.
 *
 * The current MCP revision (2026-07-28) is stateless at the protocol level:
 * every request carries its protocol version and client capabilities in
 * params._meta.  Revisions through 2025-11-25 used a connection-scoped
 * initialize/initialized handshake.  The two eras deliberately stay separate
 * in this module so a missing modern metadata object is never silently treated
 * as a modern request.
 */

export const CURRENT_PROTOCOL_VERSION = '2026-07-28';

/** Protocol revisions that use the old initialize handshake. */
export const LEGACY_PROTOCOL_VERSIONS = Object.freeze([
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
]);

/** All revisions understood by this dual-era gateway. */
export const SUPPORTED_PROTOCOL_VERSIONS = Object.freeze([
  CURRENT_PROTOCOL_VERSION,
  ...LEGACY_PROTOCOL_VERSIONS,
]);

/** Only versions that use per-request metadata. */
export const MODERN_PROTOCOL_VERSIONS = Object.freeze([
  CURRENT_PROTOCOL_VERSION,
]);

export const JSON_RPC_VERSION = '2.0';

export const JSON_RPC_ERROR_CODES = Object.freeze({
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  /** Legacy MCP's connection-not-initialized error. */
  NOT_INITIALIZED: -32002,
  HEADER_MISMATCH: -32020,
  MISSING_REQUIRED_CLIENT_CAPABILITY: -32021,
  UNSUPPORTED_PROTOCOL_VERSION: -32022,
});

export const REQUEST_META_KEYS = Object.freeze({
  protocolVersion: 'io.modelcontextprotocol/protocolVersion',
  clientInfo: 'io.modelcontextprotocol/clientInfo',
  clientCapabilities: 'io.modelcontextprotocol/clientCapabilities',
  progressToken: 'progressToken',
  logLevel: 'io.modelcontextprotocol/logLevel',
});

const INTEGER_ID = (value) =>
  typeof value === 'number' && Number.isSafeInteger(value);

export function isPlainObject(value) {
  if (value === null || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function hasOwn(value, key) {
  return isPlainObject(value) && Object.prototype.hasOwnProperty.call(value, key);
}

export function isRequestId(value) {
  // MCP RequestId is string | number and JSON-RPC disallows null.  MCP's
  // base protocol further narrows numeric IDs to integers.  Empty strings are
  // still strings and are therefore retained for wire compatibility.
  return typeof value === 'string' || INTEGER_ID(value);
}

export function isJsonValue(value, seen = new Set()) {
  if (value === null) return true;
  if (typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object') return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      if (!isJsonValue(item, seen)) return false;
    }
  } else {
    for (const key of Object.keys(value)) {
      if (!isJsonValue(value[key], seen)) return false;
    }
  }
  seen.delete(value);
  return true;
}

export function cloneJson(value) {
  if (value === undefined) return undefined;
  if (!isJsonValue(value)) {
    throw new TypeError('Value is not JSON-safe');
  }
  return JSON.parse(JSON.stringify(value));
}

export class ProtocolError extends Error {
  constructor(code, message, data) {
    super(message);
    this.name = 'ProtocolError';
    this.code = code;
    if (data !== undefined) this.data = data;
  }
}

export function errorResponse(id, code, message, data) {
  const response = {
    jsonrpc: JSON_RPC_VERSION,
    error: {
      code,
      message,
    },
  };
  if (isRequestId(id)) response.id = id;
  if (data !== undefined) response.error.data = data;
  return response;
}

export function resultResponse(id, result) {
  return {
    jsonrpc: JSON_RPC_VERSION,
    id,
    result,
  };
}

export function parseMessage(input) {
  if (typeof input !== 'string' && !Buffer.isBuffer(input)) {
    throw new ProtocolError(
      JSON_RPC_ERROR_CODES.PARSE_ERROR,
      'Parse error',
    );
  }

  let source;
  try {
    source = Buffer.isBuffer(input) ? input.toString('utf8') : input;
    // A UTF-8 BOM is not part of a JSON value.  Accepting it is useful for
    // subprocess clients while retaining strict framing rules.
    if (source.charCodeAt(0) === 0xfeff) source = source.slice(1);
    return JSON.parse(source);
  } catch {
    throw new ProtocolError(
      JSON_RPC_ERROR_CODES.PARSE_ERROR,
      'Parse error',
    );
  }
}

export function serializeMessage(message) {
  if (!isJsonValue(message) || message === undefined) {
    throw new ProtocolError(
      JSON_RPC_ERROR_CODES.INTERNAL_ERROR,
      'Message is not JSON-safe',
    );
  }
  const encoded = JSON.stringify(message);
  if (encoded === undefined || encoded.includes('\n') || encoded.includes('\r')) {
    throw new ProtocolError(
      JSON_RPC_ERROR_CODES.INTERNAL_ERROR,
      'Message contains an embedded newline',
    );
  }
  return encoded;
}

export function classifyMessage(message) {
  if (!isPlainObject(message)) {
    throw new ProtocolError(
      JSON_RPC_ERROR_CODES.INVALID_REQUEST,
      'Invalid Request',
    );
  }

  if (message.jsonrpc !== JSON_RPC_VERSION) {
    throw new ProtocolError(
      JSON_RPC_ERROR_CODES.INVALID_REQUEST,
      'Invalid Request',
      { reason: 'jsonrpc must be "2.0"' },
    );
  }

  const hasId = hasOwn(message, 'id');
  if (hasId && !isRequestId(message.id)) {
    throw new ProtocolError(
      JSON_RPC_ERROR_CODES.INVALID_REQUEST,
      'Invalid Request',
      { reason: 'id must be a string or integer' },
    );
  }

  const hasMethod = hasOwn(message, 'method');
  const hasResult = hasOwn(message, 'result');
  const hasError = hasOwn(message, 'error');

  // A gateway is a server: responses from the client are never valid inbound
  // requests.  Keeping this check here also prevents response-shaped objects
  // from accidentally reaching a tool handler.
  if (!hasMethod || hasResult || hasError) {
    throw new ProtocolError(
      JSON_RPC_ERROR_CODES.INVALID_REQUEST,
      'Invalid Request',
    );
  }

  if (typeof message.method !== 'string' || message.method.length === 0) {
    throw new ProtocolError(
      JSON_RPC_ERROR_CODES.INVALID_REQUEST,
      'Invalid Request',
      { reason: 'method must be a non-empty string' },
    );
  }

  if (hasOwn(message, 'params') && !isPlainObject(message.params)) {
    throw new ProtocolError(
      JSON_RPC_ERROR_CODES.INVALID_REQUEST,
      'Invalid Request',
      { reason: 'params must be an object' },
    );
  }

  return {
    kind: hasId ? 'request' : 'notification',
    message,
  };
}

export function createSession() {
  return {
    // unknown | modern | legacy
    era: 'unknown',
    initialized: false,
    ready: false,
    protocolVersion: null,
    clientInfo: null,
    clientCapabilities: null,
    pending: new Map(),
  };
}

export function isModernVersion(version) {
  return MODERN_PROTOCOL_VERSIONS.includes(version);
}

export function isLegacyVersion(version) {
  return LEGACY_PROTOCOL_VERSIONS.includes(version);
}

export function unsupportedVersionError(id, requested) {
  return errorResponse(
    id,
    JSON_RPC_ERROR_CODES.UNSUPPORTED_PROTOCOL_VERSION,
    'Unsupported protocol version',
    {
      supported: [...MODERN_PROTOCOL_VERSIONS],
      requested,
    },
  );
}

export function validateRequestMetadata(params) {
  if (!isPlainObject(params) || !isPlainObject(params._meta)) {
    return {
      ok: false,
      error: new ProtocolError(
        JSON_RPC_ERROR_CODES.INVALID_PARAMS,
        'Invalid params',
        { reason: 'params._meta is required for the current MCP protocol' },
      ),
    };
  }

  const metadata = params._meta;
  const version = metadata[REQUEST_META_KEYS.protocolVersion];
  if (typeof version !== 'string' || version.length === 0) {
    return {
      ok: false,
      error: new ProtocolError(
        JSON_RPC_ERROR_CODES.INVALID_PARAMS,
        'Invalid params',
        { reason: `missing ${REQUEST_META_KEYS.protocolVersion}` },
      ),
    };
  }

  const capabilities = metadata[REQUEST_META_KEYS.clientCapabilities];
  if (!isPlainObject(capabilities)) {
    return {
      ok: false,
      error: new ProtocolError(
        JSON_RPC_ERROR_CODES.INVALID_PARAMS,
        'Invalid params',
        { reason: `${REQUEST_META_KEYS.clientCapabilities} must be an object` },
      ),
    };
  }

  const clientInfo = metadata[REQUEST_META_KEYS.clientInfo];
  if (clientInfo !== undefined) {
    if (
      !isPlainObject(clientInfo) ||
      typeof clientInfo.name !== 'string' ||
      clientInfo.name.length === 0 ||
      typeof clientInfo.version !== 'string' ||
      clientInfo.version.length === 0
    ) {
      return {
        ok: false,
        error: new ProtocolError(
          JSON_RPC_ERROR_CODES.INVALID_PARAMS,
          'Invalid params',
          { reason: `${REQUEST_META_KEYS.clientInfo} must contain name and version` },
        ),
      };
    }
  }

  const progressToken = metadata[REQUEST_META_KEYS.progressToken];
  if (
    progressToken !== undefined &&
    !(
      typeof progressToken === 'string' ||
      INTEGER_ID(progressToken)
    )
  ) {
    return {
      ok: false,
      error: new ProtocolError(
        JSON_RPC_ERROR_CODES.INVALID_PARAMS,
        'Invalid params',
        { reason: 'progressToken must be a non-empty string or integer' },
      ),
    };
  }

  return {
    ok: true,
    version,
    metadata,
    clientInfo: clientInfo ?? null,
    clientCapabilities: capabilities,
  };
}

export function validateLegacyInitializeParams(params) {
  if (!isPlainObject(params)) {
    return {
      ok: false,
      error: new ProtocolError(
        JSON_RPC_ERROR_CODES.INVALID_PARAMS,
        'Invalid params',
      ),
    };
  }
  const { protocolVersion, capabilities, clientInfo } = params;
  if (typeof protocolVersion !== 'string' || protocolVersion.length === 0) {
    return {
      ok: false,
      error: new ProtocolError(
        JSON_RPC_ERROR_CODES.INVALID_PARAMS,
        'Invalid params',
        { reason: 'protocolVersion is required' },
      ),
    };
  }
  if (!isPlainObject(capabilities)) {
    return {
      ok: false,
      error: new ProtocolError(
        JSON_RPC_ERROR_CODES.INVALID_PARAMS,
        'Invalid params',
        { reason: 'capabilities must be an object' },
      ),
    };
  }
  if (
    !isPlainObject(clientInfo) ||
    typeof clientInfo.name !== 'string' ||
    clientInfo.name.length === 0 ||
    typeof clientInfo.version !== 'string' ||
    clientInfo.version.length === 0
  ) {
    return {
      ok: false,
      error: new ProtocolError(
        JSON_RPC_ERROR_CODES.INVALID_PARAMS,
        'Invalid params',
        { reason: 'clientInfo must contain name and version' },
      ),
    };
  }
  return { ok: true, protocolVersion, capabilities, clientInfo };
}

export function formatProtocolError(id, error) {
  if (error instanceof ProtocolError) {
    return errorResponse(id, error.code, error.message, error.data);
  }
  return errorResponse(
    id,
    JSON_RPC_ERROR_CODES.INTERNAL_ERROR,
    'Internal error',
  );
}
