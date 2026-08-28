import { healthConfig } from './config.mjs';
import { liveServiceError } from './errors.mjs';

const LIVE_TARGET_ALIAS = 'checkout';

export function createHealthService({
  fetchImpl = globalThis.fetch,
  env = process.env,
  config = healthConfig(env),
  now = () => new Date(),
} = {}) {
  if (typeof fetchImpl !== 'function') {
    throw liveServiceError('LIVE_FETCH_MISSING', 'A fetch implementation is required.', { status: 503 });
  }

  async function check(method) {
    return fetchImpl(config.targetUrl, {
      method,
      redirect: 'follow',
      cache: 'no-store',
      signal: AbortSignal.timeout(config.timeoutMs),
      headers: { 'User-Agent': 'ToolBraid-live-health' },
    });
  }

  return Object.freeze({
    async readHealth({ service } = {}) {
      if (service !== LIVE_TARGET_ALIAS) {
        throw liveServiceError('TARGET_DENIED', 'The requested service alias is not allowlisted.', { status: 403 });
      }
      const checkedAt = now().toISOString();
      let response;
      try {
        response = await check('HEAD');
        if (response.status === 405 || response.status === 501) response = await check('GET');
      } catch {
        return {
          state: 'unavailable',
          severity: 'The allowlisted Vercel sandbox did not respond before the health deadline.',
          failure_rate: 100,
          first_seen_at: checkedAt,
          checked_at: checkedAt,
        };
      }

      const healthy = response.ok;
      return {
        state: healthy ? 'operational' : 'degraded',
        severity: healthy
          ? 'The allowlisted Vercel sandbox is responding normally.'
          : `The allowlisted Vercel sandbox returned HTTP ${response.status}.`,
        failure_rate: healthy ? 0 : 100,
        first_seen_at: checkedAt,
        checked_at: checkedAt,
      };
    },

    configSummary() {
      const target = new URL(config.targetUrl);
      return Object.freeze({ origin: target.origin, pathname: target.pathname });
    },
  });
}
