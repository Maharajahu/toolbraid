import { createHealthService } from '../server/live-services/health.mjs';
import { methodNotAllowed, queryValue, routeError, sendJson } from '../server/live-services/http.mjs';

export function createLiveHealthHandler({ serviceFactory = () => createHealthService() } = {}) {
  let service;
  const getService = () => (service ??= serviceFactory());

  return async function liveHealthHandler(request, response) {
    if (request.method !== 'GET') return methodNotAllowed(response, ['GET']);
    try {
      const result = await getService().readHealth({ service: queryValue(request, 'service') });
      return sendJson(response, 200, result);
    } catch (error) {
      return routeError(response, error);
    }
  };
}

export default createLiveHealthHandler();
