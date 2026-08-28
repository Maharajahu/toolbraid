import { liveServiceError } from './errors.mjs';

function required(env, name) {
  const value = env?.[name];
  if (typeof value !== 'string' || value.trim() === '') {
    throw liveServiceError('LIVE_CONFIG_MISSING', `Required live-service configuration ${name} is missing.`, {
      status: 503,
    });
  }
  return value.trim();
}

function optional(env, name) {
  const value = env?.[name];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function parseRepository(value) {
  const match = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})$/.exec(value);
  if (!match || match[2].endsWith('.git')) {
    throw liveServiceError('LIVE_CONFIG_INVALID', 'TOOLBRAID_GITHUB_REPOSITORY must be exactly owner/repository.', {
      status: 503,
    });
  }
  return Object.freeze({ owner: match[1], repo: match[2], fullName: value });
}

function positiveInteger(value, name, { minimum = 1, maximum = Number.MAX_SAFE_INTEGER } = {}) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
    throw liveServiceError('LIVE_CONFIG_INVALID', `${name} must be an integer from ${minimum} to ${maximum}.`, {
      status: 503,
    });
  }
  return number;
}

export function githubConfig(env = process.env) {
  const repository = parseRepository(required(env, 'TOOLBRAID_GITHUB_REPOSITORY'));
  const ref = required(env, 'TOOLBRAID_GITHUB_REF');
  if (!/^[a-f0-9]{40}$/i.test(ref)) {
    throw liveServiceError('LIVE_CONFIG_INVALID', 'TOOLBRAID_GITHUB_REF must be the exact 40-character degraded-release commit SHA.', {
      status: 503,
    });
  }
  return Object.freeze({
    token: required(env, 'TOOLBRAID_GITHUB_TOKEN'),
    repository,
    ref,
    incidentIssueNumber: positiveInteger(
      required(env, 'TOOLBRAID_GITHUB_INCIDENT_ISSUE'),
      'TOOLBRAID_GITHUB_INCIDENT_ISSUE',
    ),
  });
}

export function vercelConfig(env = process.env) {
  const signingSecret = required(env, 'TOOLBRAID_RECOVERY_SIGNING_SECRET');
  if (Buffer.byteLength(signingSecret, 'utf8') < 32) {
    throw liveServiceError(
      'LIVE_CONFIG_INVALID',
      'TOOLBRAID_RECOVERY_SIGNING_SECRET must contain at least 32 bytes.',
      { status: 503 },
    );
  }
  const productionAlias = required(env, 'TOOLBRAID_VERCEL_PRODUCTION_ALIAS').toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/.test(productionAlias) || productionAlias.includes('..')) {
    throw liveServiceError('LIVE_CONFIG_INVALID', 'TOOLBRAID_VERCEL_PRODUCTION_ALIAS must be one exact hostname.', {
      status: 503,
    });
  }
  return Object.freeze({
    token: required(env, 'TOOLBRAID_VERCEL_TOKEN'),
    projectId: required(env, 'TOOLBRAID_VERCEL_PROJECT_ID'),
    teamId: optional(env, 'TOOLBRAID_VERCEL_TEAM_ID'),
    environment: optional(env, 'TOOLBRAID_VERCEL_ENVIRONMENT') ?? 'production',
    productionAlias,
    signingSecret,
    quoteTtlSeconds: positiveInteger(
      optional(env, 'TOOLBRAID_RECOVERY_QUOTE_TTL_SECONDS') ?? '120',
      'TOOLBRAID_RECOVERY_QUOTE_TTL_SECONDS',
      { minimum: 30, maximum: 300 },
    ),
    rollbackPollIntervalMs: positiveInteger(
      optional(env, 'TOOLBRAID_VERCEL_ROLLBACK_POLL_MS') ?? '1000',
      'TOOLBRAID_VERCEL_ROLLBACK_POLL_MS',
      { minimum: 100, maximum: 1000 },
    ),
    rollbackMaxPolls: positiveInteger(
      optional(env, 'TOOLBRAID_VERCEL_ROLLBACK_MAX_POLLS') ?? '45',
      'TOOLBRAID_VERCEL_ROLLBACK_MAX_POLLS',
      { minimum: 2, maximum: 60 },
    ),
  });
}

export function healthConfig(env = process.env) {
  let target;
  try {
    target = new URL(required(env, 'TOOLBRAID_VERCEL_HEALTH_URL'));
  } catch (error) {
    if (error?.code === 'LIVE_CONFIG_MISSING') throw error;
    throw liveServiceError('LIVE_CONFIG_INVALID', 'TOOLBRAID_VERCEL_HEALTH_URL must be an absolute HTTPS URL.', {
      status: 503,
    });
  }
  if (target.protocol !== 'https:' || target.username || target.password || target.hash) {
    throw liveServiceError('LIVE_CONFIG_INVALID', 'TOOLBRAID_VERCEL_HEALTH_URL must be an absolute HTTPS URL.', {
      status: 503,
    });
  }
  return Object.freeze({
    targetUrl: target.href,
    timeoutMs: positiveInteger(
      optional(env, 'TOOLBRAID_HEALTH_TIMEOUT_MS') ?? '5000',
      'TOOLBRAID_HEALTH_TIMEOUT_MS',
      { minimum: 500, maximum: 10000 },
    ),
  });
}
