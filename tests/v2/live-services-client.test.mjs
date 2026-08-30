import assert from 'node:assert/strict';
import test from 'node:test';

import { createLiveRecoveryServices } from '../../providers/recovery/live-services.js';

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

test('routes live provider operations to same-origin server functions', async () => {
  const calls = [];
  const services = createLiveRecoveryServices({
    baseOrigin: 'https://provider.example',
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      return jsonResponse({ accepted: true });
    },
  });

  await services.health.probe({ service: 'checkout' });
  await services.health.probe({ target: 'checkout', lookback: '10m' });
  await services.source.traceChanges({ repository: 'checkout' });
  await services.deploy.listRollouts({ component: 'checkout', env: 'production' });
  await services.deploy.stageRecovery({ rollout_id: 'dpl_bad', rollback_target: 'dpl_good', action: 'rollback' });
  await services.deploy.executeRollback({ option_id: 'quote', revision: 'sig', request_id: 'req-1' });
  await services.status.readNotice({ product: 'checkout' });
  await services.status.publishNotice({ incident_id: '1', version: 'v1', content: 'Recovered', request_id: 'req-2' });

  assert.deepEqual(calls.map(({ url }) => new URL(url).pathname), [
    '/api/live-health',
    '/api/live-health',
    '/api/live-source',
    '/api/live-deploy',
    '/api/live-deploy',
    '/api/live-deploy',
    '/api/live-status',
    '/api/live-status',
  ]);
  assert.deepEqual(calls.map(({ init }) => init.body ? JSON.parse(init.body).operation ?? null : null), [
    null,
    null,
    null,
    null,
    'prepare',
    'apply',
    null,
    null,
  ]);
  assert.equal(JSON.parse(calls[4].init.body).action, 'rollback');
  assert.equal(JSON.parse(calls[7].init.body).action, 'publish');
  assert.ok(calls.every(({ url }) => new URL(url).origin === 'https://provider.example'));
  assert.ok(calls.every(({ init }) => init.credentials === 'same-origin'));
  assert.deepEqual(calls.map(({ init }) => init.method), ['GET', 'GET', 'GET', 'GET', 'POST', 'POST', 'GET', 'POST']);
  assert.equal(new URL(calls[0].url).searchParams.get('service'), 'checkout');
  assert.equal(new URL(calls[1].url).searchParams.get('service'), 'checkout');
  assert.equal(new URL(calls[2].url).searchParams.get('repository'), 'checkout');
  assert.equal(new URL(calls[3].url).searchParams.get('component'), 'checkout');
  assert.equal(new URL(calls[6].url).searchParams.get('product'), 'checkout');
  assert.equal(calls[5].init.headers['x-toolbraid-intent'], 'approved');
  assert.equal(calls[7].init.headers['x-toolbraid-intent'], 'approved');
  assert.ok(calls.filter((_, index) => index !== 5 && index !== 7)
    .every(({ init }) => init.headers['x-toolbraid-intent'] === undefined));
});

test('surfaces bounded live API errors without leaking response bodies', async () => {
  const services = createLiveRecoveryServices({
    baseOrigin: 'https://provider.example',
    fetchImpl: async () => jsonResponse({ error: { code: 'TARGET_DENIED', message: 'Configured sandbox only.' } }, 403),
  });

  await assert.rejects(
    services.deploy.executeRollback({ option_id: 'quote', revision: 'sig', request_id: 'req-1' }),
    (error) => error.code === 'TARGET_DENIED'
      && error.message === 'Configured sandbox only.'
      && error.details.status === 403,
  );
});

test('sends the controlled incident fault only to the configured primary health provider', async () => {
  const urls = [];
  const services = createLiveRecoveryServices({
    baseOrigin: 'https://signals.example',
    healthScenario: 'primary-health-unavailable',
    fetchImpl: async (url) => {
      urls.push(new URL(url));
      return jsonResponse({ accepted: true });
    },
  });

  await services.health.probe({ service: 'checkout' });
  assert.equal(urls[0].searchParams.get('scenario'), 'primary-health-unavailable');
  assert.throws(
    () => createLiveRecoveryServices({
      baseOrigin: 'https://signals.example',
      healthScenario: 'arbitrary-fault',
      fetchImpl: async () => jsonResponse({}),
    }),
    /Unknown live health scenario/,
  );
});
