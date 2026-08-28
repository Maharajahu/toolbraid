import assert from 'node:assert/strict';
import test from 'node:test';

import { createLiveDeployHandler } from '../../api/live-deploy.mjs';
import { createLiveHealthHandler } from '../../api/live-health.mjs';
import { createLiveSourceHandler } from '../../api/live-source.mjs';
import { createLiveStatusHandler } from '../../api/live-status.mjs';
import { createLiveRecoveryServices } from '../../providers/recovery/live-services.js';

function responseRecorder() {
  const headers = {};
  return {
    headers,
    statusCode: 0,
    setHeader(name, value) {
      headers[name] = value;
    },
    end(value) {
      this.text = value;
      this.json = JSON.parse(value);
    },
  };
}

test('live source and health handlers forward only their compatible read shapes', async () => {
  const sourceCalls = [];
  const sourceHandler = createLiveSourceHandler({
    serviceFactory: () => ({
      async readCommitHistory(input) {
        sourceCalls.push(input);
        return { changes: [] };
      },
    }),
  });
  const sourceResponse = responseRecorder();
  await sourceHandler({
    method: 'GET',
    url: '/api/live-source?repository=checkout&max_results=4',
    headers: {},
  }, sourceResponse);
  assert.equal(sourceResponse.statusCode, 200);
  assert.deepEqual(sourceResponse.json, { changes: [] });
  assert.deepEqual(sourceCalls, [{ repository: 'checkout', max_results: '4' }]);
  assert.equal(sourceResponse.headers['Cache-Control'], 'no-store');

  const healthHandler = createLiveHealthHandler({
    serviceFactory: () => ({
      async readHealth(input) {
        assert.deepEqual(input, { service: 'checkout' });
        return {
          state: 'operational',
          severity: 'ok',
          failure_rate: 0,
          first_seen_at: 'now',
          checked_at: 'now',
        };
      },
    }),
  });
  const healthResponse = responseRecorder();
  await healthHandler({ method: 'GET', url: '/api/live-health?service=checkout', headers: {} }, healthResponse);
  assert.equal(healthResponse.statusCode, 200);
  assert.equal(healthResponse.json.state, 'operational');
});

test('live status mutation requires explicit approved intent before invoking GitHub', async () => {
  let publishCount = 0;
  const handler = createLiveStatusHandler({
    serviceFactory: () => ({
      async readIncidentIssue() {
        return { incident_id: 'github:checkout#7' };
      },
      async publishIncidentUpdate(body) {
        publishCount += 1;
        assert.equal(body.request_id, 'req-1');
        return {
          update_id: 'github-comment-91',
          outcome: 'published',
          created_at: 'now',
          version: 'v2',
        };
      },
    }),
  });
  const body = {
    incident_id: 'github:checkout#7',
    version: 'v1',
    content: 'Recovered.',
    request_id: 'req-1',
  };

  const denied = responseRecorder();
  await handler({
    method: 'POST',
    url: '/api/live-status',
    headers: { 'content-type': 'application/json' },
    body,
  }, denied);
  assert.equal(denied.statusCode, 403);
  assert.equal(denied.json.error.code, 'LIVE_APPROVAL_HEADER_REQUIRED');
  assert.equal(publishCount, 0);

  const approved = responseRecorder();
  await handler({
    method: 'POST',
    url: '/api/live-status',
    headers: {
      'content-type': 'application/json',
      'x-toolbraid-intent': 'approved',
    },
    body,
  }, approved);
  assert.equal(approved.statusCode, 200);
  assert.equal(approved.json.outcome, 'published');
  assert.equal(publishCount, 1);
});

test('live deploy handler dispatches GET, prepare, and apply without widening targets', async () => {
  const calls = [];
  const handler = createLiveDeployHandler({
    serviceFactory: () => ({
      async readDeploymentHistory(input) {
        calls.push(['read', input]);
        return { rollouts: [] };
      },
      async prepareRecovery(input) {
        calls.push(['prepare', input]);
        return { option_id: 'option', revision: 'revision', summary: 'safe', checks: {} };
      },
      async applyRecovery(input) {
        calls.push(['apply', input]);
        return { change_id: 'change', outcome: 'requested', completed_at: 'now', version: 'good' };
      },
    }),
  });

  const read = responseRecorder();
  await handler({ method: 'GET', url: '/api/live-deploy?component=checkout&count=5', headers: {} }, read);
  assert.equal(read.statusCode, 200);

  for (const operation of ['prepare', 'apply']) {
    const response = responseRecorder();
    const headers = { 'content-type': 'application/json; charset=utf-8' };
    if (operation === 'apply') headers['x-toolbraid-intent'] = 'approved';
    await handler({
      method: 'POST',
      url: '/api/live-deploy',
      headers,
      body: { operation, action: 'rollback', request_id: 'request' },
    }, response);
    assert.equal(response.statusCode, 200);
  }
  assert.deepEqual(calls.map(([operation]) => operation), ['read', 'prepare', 'apply']);

  const invalid = responseRecorder();
  await handler({
    method: 'POST',
    url: '/api/live-deploy',
    headers: {
      'content-type': 'application/json',
      'x-toolbraid-intent': 'approved',
    },
    body: { operation: 'delete' },
  }, invalid);
  assert.equal(invalid.statusCode, 400);
  assert.equal(invalid.json.error.code, 'RECOVERY_ACTION_INVALID');
});

test('live client and API handlers share one contract for all seven operations', async () => {
  const observed = [];
  const handlers = {
    '/api/live-health': createLiveHealthHandler({
      serviceFactory: () => ({
        async readHealth(input) {
          observed.push(['health.read', input]);
          return {
            state: 'operational', severity: 'ok', failure_rate: 0, first_seen_at: 't1', checked_at: 't1',
          };
        },
      }),
    }),
    '/api/live-source': createLiveSourceHandler({
      serviceFactory: () => ({
        async readCommitHistory(input) {
          observed.push(['source.read', input]);
          return { changes: [] };
        },
      }),
    }),
    '/api/live-deploy': createLiveDeployHandler({
      serviceFactory: () => ({
        async readDeploymentHistory(input) {
          observed.push(['deploy.read', input]);
          return { rollouts: [] };
        },
        async prepareRecovery(input) {
          observed.push(['deploy.prepare', input]);
          assert.equal(input.action, 'rollback');
          return {
            option_id: 'signed-option',
            revision: 'signed-revision',
            rollback_target: 'dpl_previous',
            valid_until: 'later',
            summary: 'restore',
            checks: {},
          };
        },
        async applyRecovery(input) {
          observed.push(['deploy.apply', input]);
          return { change_id: 'change', outcome: 'applied', completed_at: 't2', version: 'good' };
        },
      }),
    }),
    '/api/live-status': createLiveStatusHandler({
      serviceFactory: () => ({
        async readIncidentIssue(input) {
          observed.push(['status.read', input]);
          return {
            incident_id: 'github:checkout#7',
            headline: 'Incident',
            message: 'Investigating',
            phase: 'investigating',
            version: 'v1',
            modified_at: 't1',
          };
        },
        async publishIncidentUpdate(input) {
          observed.push(['status.publish', input]);
          return { update_id: 'comment', outcome: 'published', created_at: 't2', version: 'v2' };
        },
      }),
    }),
  };

  async function handlerFetch(url, init) {
    const parsed = new URL(url);
    const handler = handlers[parsed.pathname];
    assert.ok(handler, `Missing handler for ${parsed.pathname}`);
    const headers = Object.fromEntries(
      Object.entries(init.headers ?? {}).map(([name, value]) => [name.toLowerCase(), value]),
    );
    observed.push(['http', {
      path: parsed.pathname,
      method: init.method,
      approved: headers['x-toolbraid-intent'] === 'approved',
    }]);
    const response = responseRecorder();
    await handler({
      method: init.method,
      url: `${parsed.pathname}${parsed.search}`,
      headers,
      body: init.body === undefined ? undefined : JSON.parse(init.body),
    }, response);
    return new Response(response.text, { status: response.statusCode, headers: response.headers });
  }

  const client = createLiveRecoveryServices({
    baseOrigin: 'https://provider.toolbraid.test',
    fetchImpl: handlerFetch,
  });
  await client.health.probe({ service: 'checkout', window_minutes: 30 });
  await client.source.traceChanges({ repository: 'checkout', max_results: 5 });
  await client.deploy.listRollouts({ component: 'checkout', env: 'production', count: 5 });
  await client.deploy.stageRecovery({
    rollout_id: 'dpl_current', rollback_target: 'dpl_previous', action: 'rollback',
  });
  await client.deploy.executeRollback({
    option_id: 'signed-option', revision: 'signed-revision', request_id: 'apply-1',
  });
  await client.status.readNotice({ product: 'checkout' });
  await client.status.publishNotice({
    incident_id: 'github:checkout#7', version: 'v1', content: 'Recovered', request_id: 'publish-1',
  });

  assert.deepEqual(
    observed.filter(([kind]) => kind !== 'http').map(([kind]) => kind),
    [
      'health.read',
      'source.read',
      'deploy.read',
      'deploy.prepare',
      'deploy.apply',
      'status.read',
      'status.publish',
    ],
  );
  const httpCalls = observed.filter(([kind]) => kind === 'http').map(([, call]) => call);
  assert.deepEqual(httpCalls.map(({ method }) => method), ['GET', 'GET', 'GET', 'POST', 'POST', 'GET', 'POST']);
  assert.deepEqual(httpCalls.map(({ approved }) => approved), [false, false, false, false, true, false, true]);
});

test('parsed mutation bodies still enforce the 16KB server limit and object shape', async () => {
  let calls = 0;
  const handler = createLiveStatusHandler({
    serviceFactory: () => ({
      async publishIncidentUpdate() {
        calls += 1;
        return {};
      },
    }),
  });
  const baseRequest = {
    method: 'POST',
    url: '/api/live-status',
    headers: {
      'content-type': 'application/json',
      'x-toolbraid-intent': 'approved',
    },
  };

  const oversized = responseRecorder();
  await handler({ ...baseRequest, body: { content: 'x'.repeat(17_000) } }, oversized);
  assert.equal(oversized.statusCode, 413);
  assert.equal(oversized.json.error.code, 'LIVE_BODY_TOO_LARGE');

  const array = responseRecorder();
  await handler({ ...baseRequest, body: [] }, array);
  assert.equal(array.statusCode, 400);
  assert.equal(array.json.error.code, 'LIVE_JSON_INVALID');
  assert.equal(calls, 0);
});
