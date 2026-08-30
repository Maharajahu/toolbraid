import assert from 'node:assert/strict';
import test from 'node:test';

import { createLiveHealthHandler } from '../../api/live-health.mjs';

function responseRecorder() {
  return {
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    end(body) { this.body = JSON.parse(body); },
  };
}

test('fails the allowlisted primary probe on demand without calling the real health target', async () => {
  let serviceCalls = 0;
  const handler = createLiveHealthHandler({
    serviceFactory: () => ({
      async readHealth() {
        serviceCalls += 1;
        return { state: 'operational' };
      },
    }),
  });
  const response = responseRecorder();

  await handler({
    method: 'GET',
    url: '/api/live-health?service=checkout&scenario=primary-health-unavailable',
  }, response);

  assert.equal(response.statusCode, 503);
  assert.equal(response.body.error.code, 'CONTROLLED_PRIMARY_UNAVAILABLE');
  assert.equal(serviceCalls, 0);
});

test('rejects unknown fault scenarios and preserves the normal health path', async () => {
  let serviceCalls = 0;
  const handler = createLiveHealthHandler({
    serviceFactory: () => ({
      async readHealth({ service }) {
        serviceCalls += 1;
        return { state: 'operational', service };
      },
    }),
  });

  const denied = responseRecorder();
  await handler({ method: 'GET', url: '/api/live-health?service=checkout&scenario=unknown' }, denied);
  assert.equal(denied.statusCode, 403);
  assert.equal(denied.body.error.code, 'SCENARIO_DENIED');

  const normal = responseRecorder();
  await handler({ method: 'GET', url: '/api/live-health?service=checkout' }, normal);
  assert.equal(normal.statusCode, 200);
  assert.equal(normal.body.service, 'checkout');
  assert.equal(serviceCalls, 1);
});
