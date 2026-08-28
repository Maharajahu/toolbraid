import { createVercelService } from '../server/live-services/vercel.mjs';
import { liveServiceError } from '../server/live-services/errors.mjs';
import {
  assertApprovedMutation,
  methodNotAllowed,
  queryValue,
  readJsonBody,
  routeError,
  sendJson,
} from '../server/live-services/http.mjs';

export function createLiveDeployHandler({ serviceFactory = () => createVercelService() } = {}) {
  let service;
  const getService = () => (service ??= serviceFactory());

  return async function liveDeployHandler(request, response) {
    try {
      if (request.method === 'GET') {
        const result = await getService().readDeploymentHistory({
          component: queryValue(request, 'component'),
          count: queryValue(request, 'count'),
        });
        return sendJson(response, 200, result);
      }
      if (request.method === 'POST') {
        const body = await readJsonBody(request);
        if (body.operation === 'prepare') {
          return sendJson(response, 200, await getService().prepareRecovery(body));
        }
        if (body.operation === 'apply') {
          assertApprovedMutation(request);
          return sendJson(response, 200, await getService().applyRecovery(body));
        }
        throw liveServiceError('RECOVERY_ACTION_INVALID', 'POST operation must be prepare or apply.');
      }
      return methodNotAllowed(response, ['GET', 'POST']);
    } catch (error) {
      return routeError(response, error);
    }
  };
}

export default createLiveDeployHandler();
