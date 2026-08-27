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
import { isSecretLikeKey } from '../security/redaction.js';

const DEFAULT_SERVER_INFO = Object.freeze({
  name: 'ToolBraid',
  version: '0.1.0',
  description: 'Secure semantic workflow control plane',
});

const DEFAULT_INSTRUCTIONS =
  'ToolBraid exposes semantic capabilities and policy-checked workflows. Workflow execution requires a trusted server-side approval; read-only replay never replays mutation nodes.';

const MODERN_RESULT_TYPE = 'complete';

// MCP does not define a queueing contract for a server.  Rejecting excess
// work at admission is safer than allowing an unbounded set of provider calls
// (and keeps cancellation bookkeeping bounded as well).  These are gateway
// limits, not execution timeouts: an admitted handler may still run until it
// cooperatively observes its AbortSignal or completes.
const DEFAULT_MAX_ACTIVE_CALLS = 64;
const DEFAULT_MAX_SESSION_ACTIVE_CALLS = 32;
const ACTIVE_CALL_LIMIT_CODE = 'ACTIVE_CALL_LIMIT';

// Tool handlers sit on the provider side of the MCP trust boundary.  Keep
// their result/error envelopes useful, but bounded enough that a provider
// cannot turn a single call into an unbounded response or smuggle an exception
// object/stack onto the wire.
const MAX_RESULT_DEPTH = 12;
const MAX_RESULT_ENTRIES = 256;
const MAX_RESULT_NODES = 4096;
const MAX_RESULT_STRING_LENGTH = 8192;
const MAX_RESULT_BYTES = 512 * 1024;
// Leave room for truncation markers/JSON punctuation whenever the walker
// reaches the byte budget.  The emitted result remains comfortably below the
// public 512 KiB aggregate limit even when a hostile tree hits every depth and
// node bound at once.
const MAX_SANITIZED_BYTES = MAX_RESULT_BYTES - 64 * 1024;
const MAX_ERROR_CODE_LENGTH = 128;
const MAX_ERROR_MESSAGE_LENGTH = 2048;
const REDACTED_VALUE = '[REDACTED]';
const UNSERIALIZABLE_VALUE = '[UNSERIALIZABLE]';
const OMIT_VALUE = Symbol('omit provider field');
const PROVIDER_VALUE_OVERFLOW = Symbol('provider value exceeded aggregate byte budget');
const OMITTED_PROVIDER_KEYS = new Set(['cause', 'stack', 'stacktrace', 'trace']);

const BEARER_SECRET_PATTERN = /\bBearer\s+[^\s,;]+/giu;

function idKey(id) {
  return `${typeof id}:${String(id)}`;
}

function asSafeString(value, fallback, maxLength = 2048) {
  if (typeof value !== 'string' || value.length === 0) return fallback;
  return value.length > maxLength ? value.slice(0, maxLength) : value;
}

function positiveLimit(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function ownData(value, key) {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) {
    return { present: false, value: undefined };
  }
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      // Accessors are provider-controlled code.  Treat them as absent rather
      // than invoking a getter while constructing a response.
      return { present: false, value: undefined };
    }
    return { present: true, value: descriptor.value };
  } catch {
    return { present: false, value: undefined };
  }
}

function hasOwnData(value, key) {
  return ownData(value, key).present;
}

function safePlainObject(value) {
  try {
    return isPlainObject(value);
  } catch {
    return false;
  }
}

function putData(target, key, value) {
  // Defining a property avoids the special __proto__ setter on ordinary
  // objects while retaining the familiar object prototype for API callers.
  Object.defineProperty(target, key, {
    configurable: true,
    enumerable: true,
    writable: true,
    value,
  });
}

function omittedProviderKey(key) {
  if (typeof key !== 'string') return false;
  return OMITTED_PROVIDER_KEYS.has(key.toLowerCase().replace(/[^a-z0-9]/gu, ''));
}

function redactSensitiveText(value, maxLength = MAX_RESULT_STRING_LENGTH) {
  if (typeof value !== 'string') return '';
  // Bound before regex processing so a hostile provider cannot make an error
  // response spend unbounded time scanning an unbounded string.
  let text = value.length > maxLength ? value.slice(0, maxLength) : value;
  text = text
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, ' ')
    .replace(BEARER_SECRET_PATTERN, 'Bearer [REDACTED]');
  text = redactKeyedSecrets(text);
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

function redactKeyedSecrets(text) {
  let output = '';
  let copyFrom = 0;
  let index = 0;
  while (index < text.length) {
    const current = text[index];
    const quoted = current === '"' || current === "'";
    const keyStart = quoted ? index + 1 : index;
    if (!isAsciiLetter(text[keyStart]) || (!quoted && keyStart > 0 && isKeyCharacter(text[keyStart - 1]))) {
      index += 1;
      continue;
    }

    let keyEnd = keyStart;
    while (keyEnd < text.length && isKeyCharacter(text[keyEnd])) keyEnd += 1;
    // Advancing past a long key is important: otherwise a long ordinary word
    // would make the bounded key matcher retry at every character.
    if (keyEnd - keyStart > 128) {
      index = keyEnd;
      continue;
    }
    if (quoted && text[keyEnd] !== current) {
      index = keyEnd;
      continue;
    }

    let separatorStart = quoted ? keyEnd + 1 : keyEnd;
    while (separatorStart < text.length && /\s/u.test(text[separatorStart])) separatorStart += 1;
    if (text[separatorStart] !== ':' && text[separatorStart] !== '=') {
      index = Math.max(index + 1, keyEnd);
      continue;
    }
    let valueStart = separatorStart + 1;
    while (valueStart < text.length && /\s/u.test(text[valueStart])) valueStart += 1;
    if (valueStart >= text.length) {
      index = valueStart;
      continue;
    }
    const valueQuote = text[valueStart] === '"' || text[valueStart] === "'"
      ? text[valueStart]
      : undefined;
    let valueEnd = valueStart;
    if (valueQuote) {
      valueEnd += 1;
      while (valueEnd < text.length && text[valueEnd] !== valueQuote) valueEnd += 1;
      if (valueEnd < text.length) valueEnd += 1;
    } else {
      while (valueEnd < text.length && !/[\s,;]/u.test(text[valueEnd])) valueEnd += 1;
    }

    const key = text.slice(keyStart, keyEnd);
    if (isSecretLikeKey(key)) {
      output += text.slice(copyFrom, valueStart);
      output += '[REDACTED]';
      copyFrom = valueEnd;
    }
    index = Math.max(index + 1, valueEnd);
  }
  return copyFrom === 0 ? text : output + text.slice(copyFrom);
}

function isAsciiLetter(value) {
  if (typeof value !== 'string' || value.length !== 1) return false;
  const code = value.charCodeAt(0);
  return (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);
}

function isKeyCharacter(value) {
  if (typeof value !== 'string' || value.length !== 1) return false;
  const code = value.charCodeAt(0);
  return (code >= 0x41 && code <= 0x5a) ||
    (code >= 0x61 && code <= 0x7a) ||
    (code >= 0x30 && code <= 0x39) ||
    value === '_' || value === '-';
}

function sanitizeErrorCode(value, fallback = 'tool_execution_error') {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_ERROR_CODE_LENGTH) {
    return fallback;
  }
  // Error codes are useful for clients, but must remain identifier-like so a
  // provider cannot put a secret, line break, or an arbitrary diagnostic blob
  // in the stable code field.
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value)) return fallback;
  return value;
}

function sanitizeErrorMessage(value, fallback = 'Tool execution failed') {
  if (typeof value !== 'string' || value.length === 0) return fallback;
  const text = redactSensitiveText(value, MAX_ERROR_MESSAGE_LENGTH);
  return text.length === 0 ? fallback : text;
}

function serializedByteLength(value) {
  try {
    const encoded = JSON.stringify(value);
    return encoded === undefined ? Infinity : Buffer.byteLength(encoded, 'utf8');
  } catch {
    return Infinity;
  }
}

function resultWithinLimit(value) {
  return serializedByteLength(value) <= MAX_RESULT_BYTES;
}

function sanitizeProviderValue(value, options = {}) {
  const state = {
    maxDepth: options.maxDepth ?? MAX_RESULT_DEPTH,
    maxEntries: options.maxEntries ?? MAX_RESULT_ENTRIES,
    maxNodes: options.maxNodes ?? MAX_RESULT_NODES,
    maxStringLength: options.maxStringLength ?? MAX_RESULT_STRING_LENGTH,
    maxBytes: options.maxBytes ?? MAX_SANITIZED_BYTES,
    bytes: 0,
    overflowed: false,
    nodes: 0,
    seen: new WeakSet(),
  };
  const result = walkProviderValue(value, state, 0, undefined);
  const safe = result === OMIT_VALUE ? UNSERIALIZABLE_VALUE : result;
  if (state.overflowed && safe !== null && typeof safe === 'object') {
    try {
      Object.defineProperty(safe, PROVIDER_VALUE_OVERFLOW, { value: true });
    } catch {
      // The sanitized value is still bounded; an unmarkable primitive/object
      // will be handled by the final serialized-size check.
    }
  }
  return safe;
}

function reserveProviderBytes(state, bytes) {
  if (!Number.isSafeInteger(bytes) || bytes < 0 || state.bytes + bytes > state.maxBytes) {
    state.overflowed = true;
    return false;
  }
  state.bytes += bytes;
  return true;
}

function providerValueOverflowed(value) {
  return Boolean(value && typeof value === 'object' && value[PROVIDER_VALUE_OVERFLOW] === true);
}

function encodedProviderBytes(value) {
  try {
    const encoded = JSON.stringify(value);
    return encoded === undefined ? Infinity : Buffer.byteLength(encoded, 'utf8');
  } catch {
    return Infinity;
  }
}

function providerMarker(state) {
  return reserveProviderBytes(state, encodedProviderBytes(UNSERIALIZABLE_VALUE))
    ? UNSERIALIZABLE_VALUE
    : OMIT_VALUE;
}

function sanitizeProviderError(value) {
  const safe = sanitizeProviderValue(value);
  if (!safePlainObject(value) || !safePlainObject(safe)) return safe;

  const code = ownData(value, 'code');
  if (code.present) putData(safe, 'code', sanitizeErrorCode(code.value));
  const message = ownData(value, 'message');
  if (message.present) putData(safe, 'message', sanitizeErrorMessage(message.value));
  const details = ownData(value, 'details');
  if (details.present) {
    const safeDetails = sanitizeProviderValue(details.value);
    putData(safe, 'details', safeDetails);
    if (providerValueOverflowed(safeDetails)) markProviderValueOverflow(safe);
  }
  return safe;
}

function sanitizeResultPayload(value) {
  const safe = sanitizeProviderValue(value);
  if (!safePlainObject(value) || !safePlainObject(safe)) return safe;
  const error = ownData(value, 'error');
  if (error.present) {
    const safeError = sanitizeProviderError(error.value);
    putData(safe, 'error', safeError);
    if (providerValueOverflowed(safeError)) markProviderValueOverflow(safe);
  }
  return safe;
}

function markProviderValueOverflow(value) {
  if (value === null || typeof value !== 'object') return;
  try {
    Object.defineProperty(value, PROVIDER_VALUE_OVERFLOW, { value: true });
  } catch {
    // Bounded sanitized values are still safe if a host object cannot carry
    // the diagnostic marker; the final size check remains authoritative.
  }
}

function walkProviderValue(value, state, depth, key) {
  if (omittedProviderKey(key)) return OMIT_VALUE;
  if (isSecretLikeKey(key)) {
    return reserveProviderBytes(state, encodedProviderBytes(REDACTED_VALUE))
      ? REDACTED_VALUE
      : OMIT_VALUE;
  }
  if (state.bytes >= state.maxBytes) return OMIT_VALUE;
  if (depth > state.maxDepth || state.nodes >= state.maxNodes) return providerMarker(state);
  state.nodes += 1;

  if (value === null) {
    return reserveProviderBytes(state, 4) ? null : OMIT_VALUE;
  }
  switch (typeof value) {
    case 'string':
      {
        const safe = redactSensitiveText(value, state.maxStringLength);
        return reserveProviderBytes(state, encodedProviderBytes(safe)) ? safe : OMIT_VALUE;
      }
    case 'boolean':
      return reserveProviderBytes(state, value ? 4 : 5) ? value : OMIT_VALUE;
    case 'number':
      if (!Number.isFinite(value)) return providerMarker(state);
      return reserveProviderBytes(state, encodedProviderBytes(value)) ? value : OMIT_VALUE;
    case 'undefined':
    case 'bigint':
    case 'function':
    case 'symbol':
      return providerMarker(state);
    case 'object':
      break;
    default:
      return providerMarker(state);
  }

  if (state.seen.has(value)) return providerMarker(state);
  state.seen.add(value);
  try {
    if (Array.isArray(value)) {
      if (!reserveProviderBytes(state, 2)) return OMIT_VALUE;
      const length = Number.isSafeInteger(value.length) && value.length >= 0 ? value.length : 0;
      const result = [];
      const count = Math.min(length, state.maxEntries);
      for (let index = 0; index < count; index += 1) {
        const separatorBytes = result.length === 0 ? 0 : 1;
        if (!reserveProviderBytes(state, separatorBytes)) break;
        const entry = ownData(value, String(index));
        const child = entry.present
          ? walkProviderValue(entry.value, state, depth + 1, undefined)
          : providerMarker(state);
        if (child === OMIT_VALUE) {
          state.bytes -= separatorBytes;
          break;
        }
        result.push(child);
      }
      return result;
    }

    let prototype;
    let keys;
    try {
      prototype = Object.getPrototypeOf(value);
      keys = Object.keys(value);
    } catch {
      return providerMarker(state);
    }
    if (prototype !== Object.prototype && prototype !== null) return providerMarker(state);

    if (!reserveProviderBytes(state, 2)) return OMIT_VALUE;
    const result = {};
    for (const childKey of keys.slice(0, state.maxEntries)) {
      if (omittedProviderKey(childKey)) continue;
      const separatorBytes = Object.keys(result).length === 0 ? 0 : 1;
      const keyBytes = encodedProviderBytes(childKey) + 1;
      if (!reserveProviderBytes(state, separatorBytes + keyBytes)) break;
      const entry = ownData(value, childKey);
      if (!entry.present) {
        putData(result, childKey, UNSERIALIZABLE_VALUE);
        continue;
      }
      const child = walkProviderValue(entry.value, state, depth + 1, childKey);
      if (child !== OMIT_VALUE) {
        putData(result, childKey, child);
      } else {
        state.bytes -= separatorBytes + keyBytes;
        break;
      }
    }
    return result;
  } catch {
    return providerMarker(state);
  } finally {
    state.seen.delete(value);
  }
}

function textForValue(value) {
  if (typeof value === 'string') return redactSensitiveText(value, MAX_RESULT_STRING_LENGTH);
  if (value === undefined) return '';
  try {
    const encoded = JSON.stringify(value);
    return encoded === undefined
      ? UNSERIALIZABLE_VALUE
      : redactSensitiveText(encoded, MAX_RESULT_STRING_LENGTH);
  } catch {
    return UNSERIALIZABLE_VALUE;
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

function toolExecutionError(code, message, details, modern, { enforceSize = true } = {}) {
  const safeCode = sanitizeErrorCode(code);
  const safeMessage = sanitizeErrorMessage(message);
  const retryable = ownData(details, 'retryable');
  const detailValue = ownData(details, 'details');
  const structuredContent = {
    code: safeCode,
    message: safeMessage,
    retryable: retryable.present && retryable.value === true,
  };
  if (detailValue.present) {
    const safeDetails = sanitizeProviderValue(detailValue.value);
    if (safeDetails !== OMIT_VALUE) structuredContent.details = safeDetails;
    if (providerValueOverflowed(safeDetails)) markProviderValueOverflow(structuredContent);
  }
  const result = {
    content: [{ type: 'text', text: safeMessage }],
    structuredContent,
    isError: true,
  };
  if (modern) result.resultType = MODERN_RESULT_TYPE;
  if (enforceSize && (providerValueOverflowed(structuredContent) || !resultWithinLimit(result))) {
    return toolExecutionError(
      'result_too_large',
      'Tool result exceeds the maximum size',
      undefined,
      modern,
      { enforceSize: false },
    );
  }
  return result;
}

function validContentBlock(block) {
  if (!safePlainObject(block) || typeof block.type !== 'string') return false;
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

function errorInstance(value) {
  try {
    return value instanceof Error;
  } catch {
    return false;
  }
}

function errorInfo(value) {
  const code = ownData(value, 'code');
  const message = ownData(value, 'message');
  const retryable = ownData(value, 'retryable');
  const details = ownData(value, 'details');
  return {
    code: sanitizeErrorCode(code.present ? code.value : undefined),
    message: sanitizeErrorMessage(message.present ? message.value : undefined),
    retryable: retryable.present && retryable.value === true,
    ...(details.present ? { details: details.value } : {}),
  };
}

function failedStatus(value) {
  const status = ownData(value, 'status');
  return status.present && status.value === 'failed';
}

function indicatesFailure(value, structuredValue, { ordinary = false } = {}) {
  if (failedStatus(value)) return true;
  if (safePlainObject(structuredValue) && failedStatus(structuredValue)) return true;
  // Complete MCP ToolResult envelopes retain fail-closed presence semantics:
  // even a null/empty `error` field is an explicit provider assertion.  An
  // ordinary semantic value is different; a compatibility `error: null`
  // field (such as on a completed workflow snapshot) represents success.
  const error = ownData(value, 'error');
  return error.present && (!ordinary || (
    error.value !== null && error.value !== undefined && error.value !== false && error.value !== ''
  ));
}

function normalizedContent(value) {
  if (!Array.isArray(value)) return undefined;
  const content = [];
  let count;
  try {
    count = Math.min(value.length, MAX_RESULT_ENTRIES);
  } catch {
    return undefined;
  }
  for (let index = 0; index < count; index += 1) {
    const entry = ownData(value, String(index));
    if (!entry.present) return undefined;
    const block = sanitizeProviderValue(entry.value, {
      maxDepth: 6,
      maxEntries: MAX_RESULT_ENTRIES,
      maxNodes: MAX_RESULT_NODES,
      maxStringLength: MAX_RESULT_STRING_LENGTH,
    });
    if (!safePlainObject(block) || !validContentBlock(block)) return undefined;
    content.push(block);
  }
  return content;
}

function normalizeToolResult(value, modern) {
  // A handler may return a complete MCP ToolResult, or an ordinary JSON value
  // which the gateway wraps in structured and text content.
  if (errorInstance(value)) {
    const info = errorInfo(value);
    return toolExecutionError(info.code, info.message, info, modern);
  }

  const complete = safePlainObject(value) && (
    hasOwnData(value, 'content') ||
    hasOwnData(value, 'structuredContent') ||
    hasOwnData(value, 'isError')
  );
  if (!complete) {
    const structuredContent = value === undefined ? null : sanitizeResultPayload(value);
    if (providerValueOverflowed(structuredContent)) {
      return toolExecutionError('result_too_large', 'Tool result exceeds the maximum size', undefined, modern);
    }
    const result = normalizeWrappedResult(
      structuredContent,
      indicatesFailure(value, structuredContent, { ordinary: true }),
      modern,
    );
    return resultWithinLimit(result)
      ? result
      : toolExecutionError('result_too_large', 'Tool result exceeds the maximum size', undefined, modern);
  }

  let result = sanitizeResultPayload(value);
  if (!safePlainObject(result)) {
    return toolExecutionError('invalid_tool_result', 'Tool returned an invalid result', undefined, modern);
  }
  if (providerValueOverflowed(result)) {
    return toolExecutionError('result_too_large', 'Tool result exceeds the maximum size', undefined, modern);
  }

  const rawContent = ownData(value, 'content');
  if (rawContent.present) {
    const content = normalizedContent(rawContent.value);
    if (content === undefined) {
      return toolExecutionError('invalid_tool_result', 'Tool returned invalid content', undefined, modern);
    }
    putData(result, 'content', content);
  } else {
    const rawStructured = ownData(value, 'structuredContent');
    const textSource = rawStructured.present
      ? ownData(result, 'structuredContent').value
      : ownData(result, 'error').value;
    result.content = [
      {
        type: 'text',
        text: textSource === undefined ? '' : textForValue(textSource),
      },
    ];
  }

  const rawStructured = ownData(value, 'structuredContent');
  if (rawStructured.present) {
    putData(result, 'structuredContent', sanitizeResultPayload(rawStructured.value));
  }

  const rawIsError = ownData(value, 'isError');
  putData(result, 'isError', (rawIsError.present && rawIsError.value === true)
    || indicatesFailure(value, rawStructured.present ? rawStructured.value : undefined));
  if (modern) {
    const resultType = ownData(value, 'resultType');
    result.resultType = typeof resultType.value === 'string' && resultType.value.length > 0
      ? redactSensitiveText(resultType.value, 128)
      : MODERN_RESULT_TYPE;
  } else {
    delete result.resultType;
    // resultType was introduced after the legacy handshake era.  Do not leak
    // current-only fields into legacy clients through a handler's result.
  }
  if (!isJsonValue(result)) {
    return toolExecutionError('invalid_tool_result', 'Tool returned non-JSON data', undefined, modern);
  }
  return resultWithinLimit(result)
    ? result
    : toolExecutionError('result_too_large', 'Tool result exceeds the maximum size', undefined, modern);
}

function normalizeWrappedResult(structuredContent, isError, modern) {
  const result = {
    content: [{ type: 'text', text: textForValue(structuredContent) }],
    structuredContent,
    isError: Boolean(isError),
  };
  if (modern) result.resultType = MODERN_RESULT_TYPE;
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

function isNotificationCandidate(message) {
  // Once a JSON-RPC object has a valid version and a method but no id, it is a
  // notification for response purposes even when a later structural check
  // rejects its params.  JSON-RPC notifications are never answerable.
  return Boolean(
    isPlainObject(message) &&
    message.jsonrpc === '2.0' &&
    !hasOwn(message, 'id') &&
    hasOwn(message, 'method'),
  );
}

export class McpGateway {
  constructor(options = {}) {
    this.options = isPlainObject(options) ? options : {};
    this.serverInfo = normalizeServerInfo(this.options.serverInfo);
    this.instructions = asSafeString(this.options.instructions, DEFAULT_INSTRUCTIONS, 4096);
    this.requireIdentity = this.options.requireIdentity !== false;
    this.maxActiveCalls = positiveLimit(
      this.options.maxActiveCalls ?? this.options.maxConcurrentCalls,
      DEFAULT_MAX_ACTIVE_CALLS,
    );
    this.maxSessionActiveCalls = positiveLimit(
      this.options.maxSessionActiveCalls ?? this.options.maxConcurrentCallsPerSession,
      DEFAULT_MAX_SESSION_ACTIVE_CALLS,
    );
    this.activeCalls = 0;
    this.sessionCallState = new WeakMap();
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

    const releaseCall = this.#admitCall(context.session ?? this.defaultSession, modern);
    if (!releaseCall) {
      return toolExecutionError(
        ACTIVE_CALL_LIMIT_CODE,
        'Gateway active-call limit reached; retry later',
        {
          retryable: true,
          details: {
            limit: this.maxActiveCalls,
            sessionLimit: this.maxSessionActiveCalls,
          },
        },
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
      const info = errorInfo(error);
      return toolExecutionError(
        info.code,
        info.message,
        info,
        modern,
      );
    } finally {
      releaseCall();
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
      return isNotificationCandidate(message) ? null : formatProtocolError(undefined, error);
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

  #admitCall(session) {
    const key = session && (typeof session === 'object' || typeof session === 'function')
      ? session
      : this.defaultSession;
    let state = this.sessionCallState.get(key);
    if (!state) {
      state = { active: 0 };
      this.sessionCallState.set(key, state);
    }
    if (this.activeCalls >= this.maxActiveCalls || state.active >= this.maxSessionActiveCalls) return undefined;

    this.activeCalls += 1;
    state.active += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.activeCalls = Math.max(0, this.activeCalls - 1);
      state.active = Math.max(0, state.active - 1);
    };
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
