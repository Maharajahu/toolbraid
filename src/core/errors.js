/**
 * Errors emitted by the core control plane.
 *
 * The public shape is deliberately boring.  Consumers can safely serialize an
 * error without accidentally leaking a stack, a provider exception, or an
 * arbitrary object supplied by an adapter.
 */
export class CoreError extends Error {
  constructor(code, message, options = {}) {
    super(String(message || code || 'Core operation failed'));
    this.name = 'CoreError';
    this.code = String(code || 'CORE_ERROR');
    this.retryable = options.retryable === true;
    if (options.details !== undefined) {
      this.details = safeDetails(options.details);
    }
    // Keeping a cause is useful to the server log, but it is intentionally not
    // included by toJSON().  A provider's error is untrusted input.
    if (options.cause !== undefined) this.cause = options.cause;
  }

  toJSON() {
    const value = {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
    };
    if (this.details !== undefined) value.details = this.details;
    return value;
  }
}

export function coreError(code, message, options = {}) {
  return new CoreError(code, message, options);
}

export function errorShape(error, fallback = {}) {
  if (error instanceof CoreError) return error.toJSON();
  if (error && typeof error === 'object' && typeof error.code === 'string' &&
      typeof error.message === 'string' && typeof error.retryable === 'boolean') {
    const value = {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
    };
    if (error.details !== undefined) value.details = safeDetails(error.details);
    return value;
  }
  return {
    code: String(fallback.code || 'CORE_ERROR'),
    message: String(fallback.message || 'Core operation failed'),
    retryable: fallback.retryable === true,
  };
}

function safeDetails(value) {
  try {
    return cloneJson(value);
  } catch {
    return { reason: 'details_unavailable' };
  }
}

function cloneJson(value, seen = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'bigint') return String(value);
  if (typeof value !== 'object') return undefined;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  let result;
  if (Array.isArray(value)) result = value.map((entry) => cloneJson(entry, seen));
  else {
    result = {};
    for (const key of Object.keys(value).sort()) {
      const child = cloneJson(value[key], seen);
      if (child !== undefined) result[key] = child;
    }
  }
  seen.delete(value);
  return result;
}

export function assert(condition, code, message, details) {
  if (!condition) throw new CoreError(code, message, { details });
}

