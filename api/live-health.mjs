import { createHealthService } from '../server/live-services/health.mjs';
import { methodNotAllowed, queryValue, routeError, sendJson } from '../server/live-services/http.mjs';
import { liveServiceError } from '../server/live-services/errors.mjs';

const CONTROLLED_HEALTH_FAULT = 'primary-health-unavailable';

export function createLiveHealthHandler({ serviceFactory = () => createHealthService() } = {}) {
  let service;
  const getService = () => (service ??= serviceFactory());

  return async function liveHealthHandler(request, response) {
    if (request.method !== 'GET') return methodNotAllowed(response, ['GET']);
    try {
      const scenario = queryValue(request, 'scenario');
      if (scenario !== undefined && scenario !== CONTROLLED_HEALTH_FAULT) {
        throw liveServiceError('SCENARIO_DENIED', 'The requested health scenario is not allowlisted.', { status: 403 });
      }
      if (scenario === CONTROLLED_HEALTH_FAULT) {
        throw liveServiceError(
          'CONTROLLED_PRIMARY_UNAVAILABLE',
          'The disposable recovery lab intentionally rejected the primary health probe.',
          { status: 503 },
        );
      }
      const result = await getService().readHealth({ service: queryValue(request, 'service') });
      return sendJson(response, 200, result);
    } catch (error) {
      return routeError(response, error);
    }
  };
}

export default createLiveHealthHandler();
