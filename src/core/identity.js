import { CoreError } from './errors.js';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/+\-]{0,199}$/;

/**
 * Resolve an operation's explicit tenant/subject identity.
 *
 * Both `{ identity: { tenantId, subjectId } }` and top-level
 * `{ tenantId, subjectId }` are accepted for ergonomic adapters.  The latter
 * is still explicit; there is intentionally no process-global fallback.
 */
export function requireIdentity(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new CoreError('IDENTITY_REQUIRED', 'Explicit tenant and subject identity is required');
  }

  const nested = input.identity;
  const hasNested = nested !== undefined;
  if (hasNested && (!nested || typeof nested !== 'object' || Array.isArray(nested))) {
    throw new CoreError('INVALID_IDENTITY', 'identity must be an object');
  }

  const source = hasNested ? nested : input;
  const tenantId = source.tenantId;
  const subjectId = source.subjectId ?? source.userId;
  if (hasNested && input.tenantId !== undefined && input.tenantId !== tenantId) {
    throw new CoreError('INVALID_IDENTITY', 'Conflicting tenant identity values');
  }
  const topSubject = input.subjectId ?? input.userId;
  if (hasNested && topSubject !== undefined && topSubject !== subjectId) {
    throw new CoreError('INVALID_IDENTITY', 'Conflicting subject identity values');
  }
  validateId(tenantId, 'tenantId');
  validateId(subjectId, 'subjectId');
  return { tenantId, subjectId };
}

export function validateIdentity(identity) {
  try {
    return requireIdentity({ identity });
  } catch (error) {
    if (error instanceof CoreError) throw error;
    throw new CoreError('INVALID_IDENTITY', 'Invalid identity');
  }
}

export function sameIdentity(left, right) {
  return Boolean(left && right && left.tenantId === right.tenantId && left.subjectId === right.subjectId);
}

export function identityKey(identity) {
  const value = validateIdentity(identity);
  return `${encodeURIComponent(value.tenantId)}:${encodeURIComponent(value.subjectId)}`;
}

function validateId(value, field) {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
    throw new CoreError('INVALID_IDENTITY', `${field} must be a non-empty identifier`, {
      details: { field },
    });
  }
}

