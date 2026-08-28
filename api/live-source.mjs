import { createGitHubService } from '../server/live-services/github.mjs';
import { methodNotAllowed, queryValue, routeError, sendJson } from '../server/live-services/http.mjs';

export function createLiveSourceHandler({ serviceFactory = () => createGitHubService() } = {}) {
  let service;
  const getService = () => (service ??= serviceFactory());

  return async function liveSourceHandler(request, response) {
    if (request.method !== 'GET') return methodNotAllowed(response, ['GET']);
    try {
      const result = await getService().readCommitHistory({
        repository: queryValue(request, 'repository'),
        max_results: queryValue(request, 'max_results'),
      });
      return sendJson(response, 200, result);
    } catch (error) {
      return routeError(response, error);
    }
  };
}

export default createLiveSourceHandler();
