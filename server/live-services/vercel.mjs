import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

import { vercelConfig } from './config.mjs';
import { liveServiceError, upstreamError } from './errors.mjs';

const VERCEL_API = 'https://api.vercel.com';
const QUOTE_VERSION = 1;
const LIVE_TARGET_ALIAS = 'checkout';

function requiredText(value, field, maximum = 512) {
  if (typeof value !== 'string' || value.trim() === '' || value.length > maximum) {
    throw liveServiceError('LIVE_INPUT_INVALID', `${field} must be a non-empty string of at most ${maximum} characters.`);
  }
  return value;
}

function boundedInteger(value, fallback, { minimum = 1, maximum = 20 } = {}) {
  if (value === undefined || value === null || value === '') return fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
    throw liveServiceError('LIVE_INPUT_INVALID', `Expected an integer from ${minimum} to ${maximum}.`);
  }
  return number;
}

function isoTimestamp(value) {
  const date = new Date(typeof value === 'number' && value < 10_000_000_000 ? value * 1000 : value);
  return Number.isFinite(date.valueOf()) ? date.toISOString() : '';
}

function deploymentId(deployment) {
  return String(deployment?.uid ?? deployment?.id ?? '');
}

function deploymentVersion(deployment) {
  return String(
    deployment?.meta?.githubCommitSha
      ?? deployment?.gitSource?.sha
      ?? deployment?.meta?.githubCommitRef
      ?? deploymentId(deployment),
  );
}

function deploymentStatus(deployment) {
  return String(deployment?.readyState ?? deployment?.state ?? 'unknown').toLowerCase();
}

function normalizeDeployment(deployment, projectId) {
  const id = deploymentId(deployment);
  if (!id) {
    throw liveServiceError('VERCEL_RESPONSE_INVALID', 'Vercel returned a deployment without an ID.', {
      status: 502,
    });
  }
  if (deployment?.projectId && deployment.projectId !== projectId) {
    throw liveServiceError('VERCEL_PROJECT_MISMATCH', 'Vercel returned a deployment outside the allowlisted project.', {
      status: 502,
    });
  }
  return Object.freeze({
    id,
    version: deploymentVersion(deployment),
    status: deploymentStatus(deployment),
    startedAt: isoTimestamp(deployment?.createdAt ?? deployment?.created ?? deployment?.buildingAt),
    target: String(deployment?.target ?? ''),
    current: deployment?.aliasAssigned === true || deployment?.current === true,
  });
}

function arrangeDeployments(deployments, environment, currentDeploymentId) {
  const ready = deployments
    .filter((deployment) => deployment.target === environment && deployment.status === 'ready')
    .sort((left, right) => String(right.startedAt).localeCompare(String(left.startedAt)));
  const current = ready.find((deployment) => deployment.id === currentDeploymentId);
  if (!current) {
    throw liveServiceError('VERCEL_ACTIVE_DEPLOYMENT_MISSING', 'No ready production deployment was found.', {
      status: 409,
    });
  }
  return [current, ...ready.filter((deployment) => deployment.id !== current.id)];
}

function optionPayload(optionId) {
  if (typeof optionId !== 'string' || !optionId.startsWith('tbq_') || optionId.length > 4096) {
    throw liveServiceError('RECOVERY_QUOTE_INVALID', 'The recovery option is not a valid signed quote.', {
      status: 409,
    });
  }
  try {
    const payload = JSON.parse(Buffer.from(optionId.slice(4), 'base64url').toString('utf8'));
    if (!payload || payload.v !== QUOTE_VERSION) throw new Error('Unsupported quote version.');
    return payload;
  } catch (cause) {
    throw liveServiceError('RECOVERY_QUOTE_INVALID', 'The recovery option is not a valid signed quote.', {
      status: 409,
      cause,
    });
  }
}

function expectedRevision(optionId, signingSecret) {
  return `h1_${createHmac('sha256', signingSecret).update(optionId, 'utf8').digest('base64url')}`;
}

export function signRecoveryQuote(payload, signingSecret) {
  const optionId = `tbq_${Buffer.from(JSON.stringify({ v: QUOTE_VERSION, ...payload }), 'utf8').toString('base64url')}`;
  return Object.freeze({ optionId, revision: expectedRevision(optionId, signingSecret) });
}

export function verifyRecoveryQuote(optionId, revision, signingSecret) {
  const expected = Buffer.from(expectedRevision(optionId, signingSecret), 'utf8');
  const actual = Buffer.from(String(revision ?? ''), 'utf8');
  if (actual.byteLength !== expected.byteLength || !timingSafeEqual(actual, expected)) {
    throw liveServiceError('RECOVERY_QUOTE_INVALID', 'The recovery quote signature is invalid.', {
      status: 409,
    });
  }
  return optionPayload(optionId);
}

export function createVercelService({
  fetchImpl = globalThis.fetch,
  env = process.env,
  config = vercelConfig(env),
  now = () => new Date(),
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  idempotencyStore = new Map(),
} = {}) {
  if (typeof fetchImpl !== 'function') {
    throw liveServiceError('LIVE_FETCH_MISSING', 'A fetch implementation is required.', { status: 503 });
  }
  if (config.environment !== 'production') {
    throw liveServiceError('LIVE_CONFIG_INVALID', 'Live rollback is restricted to the production environment.', {
      status: 503,
    });
  }

  const headers = Object.freeze({
    Accept: 'application/json',
    Authorization: `Bearer ${config.token}`,
    'User-Agent': 'ToolBraid-live-services',
  });

  function apiUrl(path, query = {}) {
    const url = new URL(path, VERCEL_API);
    if (config.teamId) url.searchParams.set('teamId', config.teamId);
    for (const [name, value] of Object.entries(query)) {
      if (value !== undefined) url.searchParams.set(name, String(value));
    }
    return url;
  }

  async function fetchVercel(path, { method = 'GET', query, body } = {}) {
    let response;
    try {
      response = await fetchImpl(apiUrl(path, query), {
        method,
        headers: body === undefined ? headers : { ...headers, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (cause) {
      throw liveServiceError('VERCEL_UNAVAILABLE', 'Vercel could not be reached.', { status: 502, cause });
    }
    if (!response.ok) throw upstreamError('Vercel', response);
    return response;
  }

  async function listRaw(limit) {
    const response = await fetchVercel('/v6/deployments', {
      query: {
        projectId: config.projectId,
        target: config.environment,
        limit,
      },
    });
    let payload;
    try {
      payload = await response.json();
    } catch (cause) {
      throw liveServiceError('VERCEL_RESPONSE_INVALID', 'Vercel returned an invalid deployment history.', {
        status: 502,
        cause,
      });
    }
    if (!Array.isArray(payload?.deployments)) {
      throw liveServiceError('VERCEL_RESPONSE_INVALID', 'Vercel returned an invalid deployment history.', {
        status: 502,
      });
    }
    return arrangeDeployments(
      payload.deployments.map((deployment) => normalizeDeployment(deployment, config.projectId)),
      config.environment,
      await readCurrentDeploymentId(),
    );
  }

  async function readCurrentDeploymentId() {
    const response = await fetchVercel(`/v4/aliases/${encodeURIComponent(config.productionAlias)}`, {
      query: { projectId: config.projectId },
    });
    let alias;
    try {
      alias = await response.json();
    } catch (cause) {
      throw liveServiceError('VERCEL_RESPONSE_INVALID', 'Vercel returned an invalid production alias.', {
        status: 502,
        cause,
      });
    }
    const activeId = String(alias?.deploymentId ?? '');
    if (!activeId || (alias?.projectId && alias.projectId !== config.projectId)) {
      throw liveServiceError('VERCEL_ACTIVE_DEPLOYMENT_MISSING', 'The allowlisted production alias has no active deployment.', {
        status: 409,
      });
    }
    return activeId;
  }

  async function readProjectRollback() {
    const response = await fetchVercel(`/v9/projects/${encodeURIComponent(config.projectId)}`);
    let project;
    try {
      project = await response.json();
    } catch (cause) {
      throw liveServiceError('VERCEL_RESPONSE_INVALID', 'Vercel returned invalid rollback status.', {
        status: 502,
        cause,
      });
    }
    if (project?.id && project.id !== config.projectId) {
      throw liveServiceError('VERCEL_PROJECT_MISMATCH', 'Vercel returned status outside the allowlisted project.', {
        status: 502,
      });
    }
    const request = project?.lastAliasRequest;
    return request && typeof request === 'object'
      ? {
          status: String(request.jobStatus ?? ''),
          targetDeploymentId: String(request.toDeploymentId ?? ''),
          requestedAt: Number(request.requestedAt ?? 0),
          type: String(request.type ?? ''),
        }
      : null;
  }

  function matchingCompletedRollback(status, payload) {
    return status
      && status.type === 'rollback'
      && status.status === 'succeeded'
      && status.targetDeploymentId === payload.targetDeploymentId
      && status.requestedAt >= payload.issuedAt;
  }

  async function waitForRollback(payload) {
    const maximumPolls = config.rollbackMaxPolls ?? 20;
    const intervalMs = config.rollbackPollIntervalMs ?? 250;
    for (let attempt = 0; attempt < maximumPolls; attempt += 1) {
      const status = await readProjectRollback();
      if (matchingCompletedRollback(status, payload)) return status;
      if (
        status
        && status.type === 'rollback'
        && status.targetDeploymentId === payload.targetDeploymentId
        && (status.status === 'failed' || status.status === 'skipped')
      ) {
        throw liveServiceError('VERCEL_ROLLBACK_FAILED', `Vercel reported rollback status ${status.status}.`, {
          status: 502,
        });
      }
      if (attempt + 1 < maximumPolls) await sleep(intervalMs);
    }
    throw liveServiceError(
      'VERCEL_ROLLBACK_TIMEOUT',
      'Vercel accepted the rollback but did not confirm alias completion before the deadline.',
      { status: 504 },
    );
  }

  function rolloutOutput(deployments, limit) {
    return {
      rollouts: deployments.slice(0, limit).map((deployment, index) => ({
        rollout_id: deployment.id,
        version: deployment.version,
        rollout_state: index === 0 ? 'active' : deployment.status,
        started_at: deployment.startedAt,
        rollback_target: deployments[index + 1]?.version ?? deployment.version,
      })),
    };
  }

  function assertTarget(active, target, requestedActiveId, requestedTargetId) {
    if (active.id !== requestedActiveId) {
      throw liveServiceError('RECOVERY_QUOTE_STALE', 'The active Vercel deployment changed after approval.', {
        status: 409,
      });
    }
    if (!target || target.id !== requestedTargetId || target.id === active.id) {
      throw liveServiceError(
        'RECOVERY_TARGET_INVALID',
        'Only the immediately previous ready production deployment can be restored.',
        { status: 409 },
      );
    }
  }

  function assertPreparedTarget(active, target, requestedActiveId, requestedTargetVersion) {
    if (active.id !== requestedActiveId) {
      throw liveServiceError('RECOVERY_QUOTE_STALE', 'The active Vercel deployment changed before recovery preparation.', {
        status: 409,
      });
    }
    if (!target || target.id === active.id || target.version !== requestedTargetVersion) {
      throw liveServiceError(
        'RECOVERY_TARGET_INVALID',
        'Only the immediately previous ready production release can be restored.',
        { status: 409 },
      );
    }
  }

  function operationResult(payload, target, requestId, completedAt = now().valueOf()) {
    const digest = createHash('sha256')
      .update(`${requestId}\0${payload.targetDeploymentId}`, 'utf8')
      .digest('hex')
      .slice(0, 12);
    return {
      change_id: `RCV-${digest}`,
      outcome: 'applied',
      completed_at: new Date(completedAt).toISOString(),
      version: target.version,
    };
  }

  return Object.freeze({
    async readDeploymentHistory({ component, count } = {}) {
      if (component !== LIVE_TARGET_ALIAS) {
        throw liveServiceError('TARGET_DENIED', 'The requested service alias is not allowlisted.', { status: 403 });
      }
      const limit = boundedInteger(count, 5);
      return rolloutOutput(await listRaw(Math.max(limit + 1, 10)), limit);
    },

    async prepareRecovery(input = {}) {
      const rolloutId = requiredText(input.rollout_id, 'rollout_id');
      const rollbackTarget = requiredText(input.rollback_target, 'rollback_target');
      if (input.action !== 'rollback') {
        throw liveServiceError('RECOVERY_ACTION_INVALID', 'Only rollback recovery can be prepared.');
      }
      const deployments = await listRaw(20);
      const [active, target] = deployments;
      assertPreparedTarget(active, target, rolloutId, rollbackTarget);

      const issuedAt = now().valueOf();
      const expiresAt = issuedAt + (config.quoteTtlSeconds * 1000);
      const signed = signRecoveryQuote({
        projectId: config.projectId,
        productionAlias: config.productionAlias,
        environment: config.environment,
        activeDeploymentId: active.id,
        targetDeploymentId: target.id,
        targetVersion: target.version,
        issuedAt,
        expiresAt,
      }, config.signingSecret);
      return {
        option_id: signed.optionId,
        revision: signed.revision,
        rollback_target: target.version,
        valid_until: new Date(expiresAt).toISOString(),
        summary: `Restore ${LIVE_TARGET_ALIAS} from ${active.version} to ${target.version}.`,
        checks: {
          expectedActiveDeploymentId: active.id,
          project: LIVE_TARGET_ALIAS,
          environment: config.environment,
          targetReadyState: target.status,
        },
      };
    },

    async applyRecovery(input = {}) {
      const optionId = requiredText(input.option_id, 'option_id', 4096);
      const revision = requiredText(input.revision, 'revision', 256);
      const requestId = requiredText(input.request_id, 'request_id', 128);
      const signature = `${optionId}\0${revision}`;
      const cached = idempotencyStore.get(requestId);
      if (cached) {
        if (cached.signature !== signature) {
          throw liveServiceError(
            'IDEMPOTENCY_KEY_REUSED',
            'The idempotency key was already used for a different recovery quote.',
            { status: 409 },
          );
        }
        return structuredClone(cached.result);
      }

      const payload = verifyRecoveryQuote(optionId, revision, config.signingSecret);
      if (
        payload.projectId !== config.projectId
        || payload.environment !== config.environment
        || typeof payload.expiresAt !== 'number'
        || typeof payload.activeDeploymentId !== 'string'
        || typeof payload.targetDeploymentId !== 'string'
      ) {
        throw liveServiceError('RECOVERY_QUOTE_INVALID', 'The recovery quote does not match the allowlisted project.', {
          status: 409,
        });
      }
      if (now().valueOf() > payload.expiresAt) {
        throw liveServiceError('RECOVERY_QUOTE_EXPIRED', 'The recovery quote has expired.', { status: 409 });
      }

      const existingRollback = await readProjectRollback();
      if (matchingCompletedRollback(existingRollback, payload)) {
        const deployments = await listRaw(20);
        const target = deployments.find((deployment) => deployment.id === payload.targetDeploymentId) ?? {
          id: payload.targetDeploymentId,
          version: String(payload.targetVersion ?? payload.targetDeploymentId),
        };
        const result = operationResult(payload, target, requestId, existingRollback.requestedAt);
        idempotencyStore.set(requestId, { signature, result: structuredClone(result) });
        return structuredClone(result);
      }

      const deployments = await listRaw(20);
      const [active, target] = deployments;
      let result;
      if (active.id === payload.targetDeploymentId) {
        result = operationResult(payload, active, requestId);
      } else {
        assertTarget(active, target, payload.activeDeploymentId, payload.targetDeploymentId);
        await fetchVercel(
          `/v1/projects/${encodeURIComponent(config.projectId)}/rollback/${encodeURIComponent(target.id)}`,
          { method: 'POST' },
        );
        const completed = await waitForRollback(payload);
        result = operationResult(payload, target, requestId, completed.requestedAt);
      }
      idempotencyStore.set(requestId, { signature, result: structuredClone(result) });
      return structuredClone(result);
    },

    configSummary() {
      return Object.freeze({
        projectId: config.projectId,
        teamIdConfigured: Boolean(config.teamId),
        environment: config.environment,
      });
    },
  });
}
