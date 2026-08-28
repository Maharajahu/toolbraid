import { liveServiceError, publicError } from './errors.mjs';

const MAX_BODY_BYTES = 16 * 1024;

function parseJsonObject(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw liveServiceError('LIVE_JSON_INVALID', 'The request body is not valid JSON.');
  }
  if (parsed === null || Array.isArray(parsed) || typeof parsed !== 'object') {
    throw liveServiceError('LIVE_JSON_INVALID', 'The request body must be a JSON object.');
  }
  return parsed;
}

export function sendJson(response, status, body, extraHeaders = {}) {
  response.statusCode = status;
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  for (const [name, value] of Object.entries(extraHeaders)) response.setHeader(name, value);
  response.end(JSON.stringify(body));
}

export function queryValue(request, name) {
  const direct = request?.query?.[name];
  if (Array.isArray(direct)) return direct[0];
  if (direct !== undefined) return direct;
  try {
    return new URL(request?.url ?? '/', 'https://toolbraid.invalid').searchParams.get(name) ?? undefined;
  } catch {
    return undefined;
  }
}

export async function readJsonBody(request, { maximumBytes = MAX_BODY_BYTES } = {}) {
  const contentType = String(request?.headers?.['content-type'] ?? '').toLowerCase();
  if (!contentType.startsWith('application/json')) {
    throw liveServiceError('LIVE_CONTENT_TYPE', 'Mutation requests must use application/json.', { status: 415 });
  }
  if (request.body !== undefined && request.body !== null) {
    if (typeof request.body === 'object' && !Buffer.isBuffer(request.body)) {
      if (Array.isArray(request.body) || Object.getPrototypeOf(request.body) !== Object.prototype) {
        throw liveServiceError('LIVE_JSON_INVALID', 'The request body must be a JSON object.');
      }
      let serialized;
      try {
        serialized = JSON.stringify(request.body);
      } catch {
        throw liveServiceError('LIVE_JSON_INVALID', 'The request body is not valid JSON.');
      }
      if (Buffer.byteLength(serialized, 'utf8') > maximumBytes) {
        throw liveServiceError('LIVE_BODY_TOO_LARGE', 'The request body is too large.', { status: 413 });
      }
      return request.body;
    }
    const text = Buffer.isBuffer(request.body) ? request.body.toString('utf8') : String(request.body);
    if (Buffer.byteLength(text, 'utf8') > maximumBytes) {
      throw liveServiceError('LIVE_BODY_TOO_LARGE', 'The request body is too large.', { status: 413 });
    }
    return parseJsonObject(text);
  }

  const chunks = [];
  let byteLength = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    byteLength += buffer.byteLength;
    if (byteLength > maximumBytes) {
      throw liveServiceError('LIVE_BODY_TOO_LARGE', 'The request body is too large.', { status: 413 });
    }
    chunks.push(buffer);
  }
  return parseJsonObject(Buffer.concat(chunks).toString('utf8'));
}

export function assertApprovedMutation(request) {
  if (request?.headers?.['x-toolbraid-intent'] !== 'approved') {
    throw liveServiceError(
      'LIVE_APPROVAL_HEADER_REQUIRED',
      'The approved mutation intent header is required.',
      { status: 403 },
    );
  }
}

export function methodNotAllowed(response, methods) {
  return sendJson(
    response,
    405,
    { error: { code: 'LIVE_METHOD_NOT_ALLOWED', message: 'HTTP method not allowed.' } },
    { Allow: methods.join(', ') },
  );
}

export function routeError(response, error) {
  const exposed = publicError(error);
  return sendJson(response, exposed.status, exposed.body);
}
