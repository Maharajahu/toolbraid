/**
 * Errors raised by the security boundary are deliberately structured.  Callers
 * can safely translate these into the public `{ code, message, retryable }`
 * error envelope without inspecting exception text.
 */
export class SecurityError extends Error {
  constructor(code, message, { retryable = false, details } = {}) {
    super(message);
    this.name = "SecurityError";
    this.code = code;
    this.retryable = retryable;
    if (details !== undefined) this.details = details;
  }
}

export function securityError(code, message, options) {
  return new SecurityError(code, message, options);
}

/**
 * Convert a security exception to the error shape used by the MCP layer.
 * Unknown exceptions are intentionally made generic so implementation details
 * (and potentially sensitive values) cannot escape the trust boundary.
 */
export function toSecurityError(error, fallbackCode = "SECURITY_FAILURE") {
  if (error instanceof SecurityError) {
    return {
      code: error.code,
      message: error.message,
      retryable: Boolean(error.retryable),
      ...(error.details === undefined ? {} : { details: error.details }),
    };
  }
  return {
    code: fallbackCode,
    message: "The security check failed.",
    retryable: false,
  };
}

