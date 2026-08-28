const ROUTES = Object.freeze({
  health: '/api/live-health',
  source: '/api/live-source',
  deploy: '/api/live-deploy',
  status: '/api/live-status',
});

function liveServiceError(code, message, details = {}) {
  const error = new Error(message);
  error.name = 'LiveRecoveryServiceError';
  error.code = code;
  error.details = details;
  return error;
}

function boundedJson(value, label) {
  let serialized;
  try {
    serialized = JSON.stringify(value ?? {});
  } catch {
    throw liveServiceError('LIVE_REQUEST_INVALID', `${label} is not JSON serializable.`);
  }
  if (serialized.length > 16_384) {
    throw liveServiceError('LIVE_REQUEST_TOO_LARGE', `${label} exceeds the live service request limit.`);
  }
  return serialized;
}

async function responsePayload(response) {
  const contentType = response.headers?.get?.('content-type') ?? '';
  if (contentType.includes('application/json')) {
    try {
      return await response.json();
    } catch {
      throw liveServiceError('LIVE_RESPONSE_INVALID', 'The live service returned malformed JSON.');
    }
  }
  const text = await response.text();
  return text ? { message: text.slice(0, 512) } : {};
}

async function request(fetchImpl, baseOrigin, route, {
  method = 'GET',
  input = null,
  approvedIntent = false,
  signal,
} = {}) {
  const url = new URL(route, baseOrigin);
  const init = {
    method,
    headers: { Accept: 'application/json' },
    cache: 'no-store',
    credentials: 'same-origin',
    signal,
  };
  if (input !== null) {
    if (method === 'GET') {
      for (const [key, value] of Object.entries(input)) {
        if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
      }
    } else {
      init.headers['Content-Type'] = 'application/json';
      init.body = boundedJson(input, 'Live service input');
    }
  }
  if (approvedIntent) init.headers['x-toolbraid-intent'] = 'approved';

  let response;
  try {
    response = await fetchImpl(url, init);
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    throw liveServiceError('LIVE_SERVICE_UNREACHABLE', 'The live provider service could not be reached.', {
      route,
      cause: error instanceof Error ? error.message : String(error),
    });
  }

  const payload = await responsePayload(response);
  if (!response.ok) {
    const exposedError = payload?.error && typeof payload.error === 'object' ? payload.error : payload;
    throw liveServiceError(
      typeof exposedError?.code === 'string' ? exposedError.code : `LIVE_HTTP_${response.status}`,
      typeof exposedError?.message === 'string' ? exposedError.message : 'The live provider service rejected the request.',
      { route, status: response.status },
    );
  }
  return payload;
}

export function createLiveRecoveryServices({
  baseOrigin = globalThis.location?.origin,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (typeof baseOrigin !== 'string' || !baseOrigin) {
    throw new TypeError('A live provider origin is required.');
  }
  const origin = new URL(baseOrigin).origin;
  if (typeof fetchImpl !== 'function') throw new TypeError('A fetch implementation is required.');

  return Object.freeze({
    health: Object.freeze({
      probe: (input, options = {}) => request(fetchImpl, origin, ROUTES.health, {
        method: 'GET', input: { service: input.service ?? input.target }, signal: options.signal,
      }),
    }),
    source: Object.freeze({
      traceChanges: (input, options = {}) => request(fetchImpl, origin, ROUTES.source, {
        method: 'GET', input, signal: options.signal,
      }),
    }),
    deploy: Object.freeze({
      listRollouts: (input, options = {}) => request(fetchImpl, origin, ROUTES.deploy, {
        method: 'GET', input, signal: options.signal,
      }),
      stageRecovery: (input, options = {}) => request(fetchImpl, origin, ROUTES.deploy, {
        method: 'POST', input: { ...input, operation: 'prepare' }, signal: options.signal,
      }),
      executeRollback: (input, options = {}) => request(fetchImpl, origin, ROUTES.deploy, {
        method: 'POST', input: { operation: 'apply', ...input }, approvedIntent: true, signal: options.signal,
      }),
    }),
    status: Object.freeze({
      readNotice: (input, options = {}) => request(fetchImpl, origin, ROUTES.status, {
        method: 'GET', input, signal: options.signal,
      }),
      publishNotice: (input, options = {}) => request(fetchImpl, origin, ROUTES.status, {
        method: 'POST', input: { action: 'publish', ...input }, approvedIntent: true, signal: options.signal,
      }),
    }),
  });
}

export { ROUTES as LIVE_RECOVERY_ROUTES };
