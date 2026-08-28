import { createGitHubService } from '../server/live-services/github.mjs';
import {
  assertApprovedMutation,
  methodNotAllowed,
  queryValue,
  readJsonBody,
  routeError,
  sendJson,
} from '../server/live-services/http.mjs';

export function createLiveStatusHandler({ serviceFactory = () => createGitHubService() } = {}) {
  let service;
  const getService = () => (service ??= serviceFactory());

  return async function liveStatusHandler(request, response) {
    try {
      if (request.method === 'GET') {
        const result = await getService().readIncidentIssue({
          product: queryValue(request, 'product'),
        });
        return sendJson(response, 200, result);
      }
      if (request.method === 'POST') {
        assertApprovedMutation(request);
        const result = await getService().publishIncidentUpdate(await readJsonBody(request));
        return sendJson(response, 200, result);
      }
      return methodNotAllowed(response, ['GET', 'POST']);
    } catch (error) {
      return routeError(response, error);
    }
  };
}

export default createLiveStatusHandler();
