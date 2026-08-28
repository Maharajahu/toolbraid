export class LiveServiceError extends Error {
  constructor(code, message, { status = 400, cause } = {}) {
    super(message, { cause });
    this.name = 'LiveServiceError';
    this.code = code;
    this.status = status;
  }
}

export function liveServiceError(code, message, options) {
  return new LiveServiceError(code, message, options);
}

export function upstreamError(provider, response) {
  const status = Number(response?.status) || 502;
  return new LiveServiceError(
    `${provider.toUpperCase()}_UPSTREAM_REJECTED`,
    `${provider} rejected the request with HTTP ${status}.`,
    { status: 502 },
  );
}

export function publicError(error) {
  if (error instanceof LiveServiceError) {
    return {
      status: error.status,
      body: { error: { code: error.code, message: error.message } },
    };
  }
  return {
    status: 500,
    body: {
      error: {
        code: 'LIVE_SERVICE_INTERNAL',
        message: 'The live service could not complete the request.',
      },
    },
  };
}
