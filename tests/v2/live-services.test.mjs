import assert from 'node:assert/strict';
import test from 'node:test';

import { githubConfig as loadGitHubConfig } from '../../server/live-services/config.mjs';
import { createGitHubService } from '../../server/live-services/github.mjs';
import { createHealthService } from '../../server/live-services/health.mjs';
import {
  createVercelService,
  signRecoveryQuote,
  verifyRecoveryQuote,
} from '../../server/live-services/vercel.mjs';

const FIXED_NOW = () => new Date('2026-08-28T12:00:00.000Z');

test('GitHub live config requires an exact immutable commit SHA', () => {
  const base = {
    TOOLBRAID_GITHUB_TOKEN: 'token',
    TOOLBRAID_GITHUB_REPOSITORY: 'Maharajahu/toolbraid',
    TOOLBRAID_GITHUB_INCIDENT_ISSUE: '7',
  };
  assert.throws(
    () => loadGitHubConfig({ ...base, TOOLBRAID_GITHUB_REF: 'competition-final' }),
    (error) => error.code === 'LIVE_CONFIG_INVALID',
  );
  assert.equal(loadGitHubConfig({
    ...base,
    TOOLBRAID_GITHUB_REF: '0123456789abcdef0123456789abcdef01234567',
  }).ref, '0123456789abcdef0123456789abcdef01234567');
});

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return structuredClone(body);
    },
  };
}

const githubConfig = Object.freeze({
  token: 'github-test-token',
  repository: Object.freeze({
    owner: 'Maharajahu',
    repo: 'toolbraid-sandbox',
    fullName: 'Maharajahu/toolbraid-sandbox',
  }),
  ref: '0123456789abcdef0123456789abcdef01234567',
  incidentIssueNumber: 7,
});

test('GitHub live source reads real commit-shaped data only through the checkout alias', async () => {
  const calls = [];
  const service = createGitHubService({
    config: githubConfig,
    async fetchImpl(url, options) {
      calls.push({ url: String(url), options });
      return jsonResponse([
        {
          sha: '249f5f8abcdef',
          commit: {
            message: 'Ship live provider bridge\n\nDetails',
            author: { name: 'release-bot', date: '2026-08-28T10:00:00.000Z' },
          },
          author: { login: 'Maharajahu' },
        },
      ]);
    },
  });

  assert.deepEqual(await service.readCommitHistory({ repository: 'checkout', max_results: 3 }), {
    changes: [{
      revision: '249f5f8abcdef',
      change_summary: 'Ship live provider bridge',
      created_at: '2026-08-28T10:00:00.000Z',
      created_by: 'Maharajahu',
    }],
  });
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/repos\/Maharajahu\/toolbraid-sandbox\/commits\?per_page=3&sha=0123456789abcdef0123456789abcdef01234567$/);
  assert.equal(calls[0].options.headers.Authorization, 'Bearer github-test-token');
  await assert.rejects(
    () => service.readCommitHistory({ repository: 'someone/else', max_results: 3 }),
    (error) => error.code === 'TARGET_DENIED' && error.status === 403,
  );
  assert.equal(calls.length, 1);
});

test('GitHub incident update is externally idempotent through a hashed comment marker', async () => {
  const issue = {
    number: 7,
    title: 'Checkout recovery drill',
    body: 'Sandbox checkout is degraded.',
    state: 'open',
    labels: [{ name: 'incident' }],
    created_at: '2026-08-28T09:00:00.000Z',
    updated_at: '2026-08-28T10:00:00.000Z',
  };
  const comments = [];
  let postCount = 0;
  const service = createGitHubService({
    config: githubConfig,
    async fetchImpl(url, options) {
      const parsed = new URL(url);
      if (options.method === 'GET' && parsed.pathname.endsWith('/issues/7')) {
        return jsonResponse(issue);
      }
      if (options.method === 'GET' && parsed.pathname.endsWith('/issues/7/comments')) {
        return jsonResponse(comments);
      }
      if (options.method === 'POST' && parsed.pathname.endsWith('/issues/7/comments')) {
        postCount += 1;
        const payload = JSON.parse(options.body);
        assert.doesNotMatch(payload.body, /approved-request-1/);
        assert.match(payload.body, /toolbraid-idempotency:[a-f0-9]{64}/);
        const comment = {
          id: 91,
          body: payload.body,
          created_at: '2026-08-28T12:00:00.000Z',
          updated_at: '2026-08-28T12:00:00.000Z',
        };
        comments.push(comment);
        issue.updated_at = '2026-08-28T12:00:01.000Z';
        return jsonResponse(comment, 201);
      }
      throw new Error(`Unexpected GitHub mock request: ${options.method} ${parsed.pathname}`);
    },
  });

  assert.deepEqual(await service.readIncidentIssue({ product: 'checkout' }), {
    incident_id: 'github:checkout#7',
    headline: 'Checkout recovery drill',
    message: 'Sandbox checkout is degraded.',
    phase: 'degraded',
    version: '2026-08-28T10:00:00.000Z',
    modified_at: '2026-08-28T10:00:00.000Z',
  });

  const input = {
    incident_id: 'github:checkout#7',
    version: '2026-08-28T10:00:00.000Z',
    headline: 'Checkout restored',
    content: 'The sandbox checkout has recovered.',
    request_id: 'approved-request-1',
  };
  const first = await service.publishIncidentUpdate(input);
  assert.deepEqual(first, {
    update_id: 'github-comment-91',
    outcome: 'published',
    created_at: '2026-08-28T12:00:00.000Z',
    version: '2026-08-28T12:00:01.000Z',
  });
  assert.deepEqual(await service.publishIncidentUpdate(input), first);
  assert.equal(postCount, 1);

  await assert.rejects(
    () => service.publishIncidentUpdate({ ...input, request_id: 'new-request', version: 'stale' }),
    (error) => error.code === 'GITHUB_INCIDENT_VERSION_STALE',
  );
  await assert.rejects(
    () => service.readIncidentIssue({ product: 'other' }),
    (error) => error.code === 'TARGET_DENIED',
  );
});

const vercelConfig = Object.freeze({
  token: 'vercel-test-token',
  projectId: 'prj_toolbraid_sandbox',
  teamId: 'team_toolbraid',
  environment: 'production',
  productionAlias: 'toolbraid-recovery-lab.vercel.app',
  signingSecret: '0123456789abcdef0123456789abcdef',
  quoteTtlSeconds: 120,
  rollbackPollIntervalMs: 1,
  rollbackMaxPolls: 4,
});

function deploymentFixtures() {
  return [
    {
      uid: 'dpl_current',
      projectId: vercelConfig.projectId,
      target: 'production',
      readyState: 'READY',
      aliasAssigned: true,
      createdAt: Date.parse('2026-08-28T11:00:00.000Z'),
      meta: { githubCommitSha: 'release-bad' },
    },
    {
      uid: 'dpl_previous',
      projectId: vercelConfig.projectId,
      target: 'production',
      readyState: 'READY',
      createdAt: Date.parse('2026-08-28T10:00:00.000Z'),
      meta: { githubCommitSha: 'release-good' },
    },
    {
      uid: 'dpl_older',
      projectId: vercelConfig.projectId,
      target: 'production',
      readyState: 'READY',
      createdAt: Date.parse('2026-08-27T10:00:00.000Z'),
      meta: { githubCommitSha: 'release-older' },
    },
  ];
}

test('Vercel live deployment history, signed quote, revalidation, rollback, and replay are coherent', async () => {
  const calls = [];
  const deployments = deploymentFixtures();
  let rollbackStatus = null;
  let statusPolls = 0;
  let activeAliasDeploymentId = 'dpl_current';
  const service = createVercelService({
    config: vercelConfig,
    now: FIXED_NOW,
    sleep: async () => {},
    async fetchImpl(url, options) {
      const parsed = new URL(url);
      calls.push({ parsed, options });
      if (options.method === 'GET' && parsed.pathname === '/v4/aliases/toolbraid-recovery-lab.vercel.app') {
        return jsonResponse({
          alias: vercelConfig.productionAlias,
          deploymentId: activeAliasDeploymentId,
          projectId: vercelConfig.projectId,
        });
      }
      if (options.method === 'GET' && parsed.pathname === '/v6/deployments') {
        assert.equal(parsed.searchParams.get('projectId'), vercelConfig.projectId);
        assert.equal(parsed.searchParams.get('teamId'), vercelConfig.teamId);
        assert.equal(parsed.searchParams.get('target'), 'production');
        assert.equal(options.headers.Authorization, 'Bearer vercel-test-token');
        return jsonResponse({ deployments });
      }
      if (options.method === 'GET' && parsed.pathname === '/v9/projects/prj_toolbraid_sandbox') {
        if (rollbackStatus) {
          statusPolls += 1;
          if (statusPolls >= 2) {
            rollbackStatus.jobStatus = 'succeeded';
            activeAliasDeploymentId = rollbackStatus.toDeploymentId;
          }
        }
        return jsonResponse({ id: vercelConfig.projectId, lastAliasRequest: rollbackStatus });
      }
      if (options.method === 'POST' && parsed.pathname === '/v1/projects/prj_toolbraid_sandbox/rollback/dpl_previous') {
        assert.equal(options.body, undefined);
        assert.equal(options.headers['Content-Type'], undefined);
        rollbackStatus = {
          type: 'rollback',
          jobStatus: 'pending',
          toDeploymentId: 'dpl_previous',
          requestedAt: Date.parse('2026-08-28T12:00:00.000Z'),
        };
        return { ok: true, status: 201 };
      }
      throw new Error(`Unexpected Vercel mock request: ${options.method} ${parsed.pathname}`);
    },
  });

  assert.deepEqual(await service.readDeploymentHistory({ component: 'checkout', count: 2 }), {
    rollouts: [
      {
        rollout_id: 'dpl_current',
        version: 'release-bad',
        rollout_state: 'active',
        started_at: '2026-08-28T11:00:00.000Z',
        rollback_target: 'release-good',
      },
      {
        rollout_id: 'dpl_previous',
        version: 'release-good',
        rollout_state: 'ready',
        started_at: '2026-08-28T10:00:00.000Z',
        rollback_target: 'release-older',
      },
    ],
  });
  await assert.rejects(
    () => service.readDeploymentHistory({ component: 'other', count: 2 }),
    (error) => error.code === 'TARGET_DENIED',
  );

  const quote = await service.prepareRecovery({
    rollout_id: 'dpl_current',
    rollback_target: 'release-good',
    action: 'rollback',
  });
  assert.match(quote.option_id, /^tbq_/);
  assert.match(quote.revision, /^h1_/);
  assert.equal(quote.rollback_target, 'release-good');
  assert.equal(quote.valid_until, '2026-08-28T12:02:00.000Z');
  assert.equal(quote.checks.project, 'checkout');

  const applyInput = {
    option_id: quote.option_id,
    revision: quote.revision,
    request_id: 'rollback-request-1',
  };
  const applied = await service.applyRecovery(applyInput);
  assert.deepEqual(applied, {
    change_id: applied.change_id,
    outcome: 'applied',
    completed_at: '2026-08-28T12:00:00.000Z',
    version: 'release-good',
  });
  assert.match(applied.change_id, /^RCV-[a-f0-9]{12}$/);
  const afterRollback = await service.readDeploymentHistory({ component: 'checkout', count: 2 });
  assert.equal(afterRollback.rollouts[0].rollout_id, 'dpl_previous');
  assert.equal(afterRollback.rollouts[0].rollout_state, 'active');
  const postCount = calls.filter(({ options }) => options.method === 'POST').length;
  assert.deepEqual(await service.applyRecovery(applyInput), applied);
  assert.equal(calls.filter(({ options }) => options.method === 'POST').length, postCount);

  const coldService = createVercelService({
    config: vercelConfig,
    now: FIXED_NOW,
    sleep: async () => {},
    fetchImpl: async (url, options) => {
      const parsed = new URL(url);
      calls.push({ parsed, options });
      if (options.method === 'GET' && parsed.pathname === '/v4/aliases/toolbraid-recovery-lab.vercel.app') {
        return jsonResponse({
          alias: vercelConfig.productionAlias,
          deploymentId: activeAliasDeploymentId,
          projectId: vercelConfig.projectId,
        });
      }
      if (options.method === 'GET' && parsed.pathname === '/v9/projects/prj_toolbraid_sandbox') {
        return jsonResponse({ id: vercelConfig.projectId, lastAliasRequest: rollbackStatus });
      }
      if (options.method === 'GET' && parsed.pathname === '/v6/deployments') {
        return jsonResponse({ deployments });
      }
      throw new Error(`Cold replay attempted unexpected mutation: ${options.method} ${parsed.pathname}`);
    },
  });
  assert.deepEqual(await coldService.applyRecovery(applyInput), applied);
  assert.equal(calls.filter(({ options }) => options.method === 'POST').length, postCount);

  await assert.rejects(
    () => service.applyRecovery({ ...applyInput, request_id: 'tampered', revision: `${quote.revision}x` }),
    (error) => error.code === 'RECOVERY_QUOTE_INVALID',
  );
});

test('Vercel rollback confirms from the production alias when lastAliasRequest is absent', async () => {
  const deployments = deploymentFixtures();
  let activeAliasDeploymentId = 'dpl_current';
  let rollbackPosts = 0;
  const service = createVercelService({
    config: vercelConfig,
    now: FIXED_NOW,
    sleep: async () => {},
    async fetchImpl(url, options) {
      const parsed = new URL(url);
      if (options.method === 'GET' && parsed.pathname === '/v4/aliases/toolbraid-recovery-lab.vercel.app') {
        return jsonResponse({
          alias: vercelConfig.productionAlias,
          deploymentId: activeAliasDeploymentId,
          projectId: vercelConfig.projectId,
        });
      }
      if (options.method === 'GET' && parsed.pathname === '/v6/deployments') {
        return jsonResponse({ deployments });
      }
      if (options.method === 'GET' && parsed.pathname === '/v9/projects/prj_toolbraid_sandbox') {
        return jsonResponse({ id: vercelConfig.projectId, lastAliasRequest: null });
      }
      if (options.method === 'POST' && parsed.pathname === '/v1/projects/prj_toolbraid_sandbox/rollback/dpl_previous') {
        rollbackPosts += 1;
        activeAliasDeploymentId = 'dpl_previous';
        return { ok: true, status: 201 };
      }
      throw new Error(`Unexpected Vercel mock request: ${options.method} ${parsed.pathname}`);
    },
  });

  const quote = await service.prepareRecovery({
    rollout_id: 'dpl_current',
    rollback_target: 'release-good',
    action: 'rollback',
  });
  const result = await service.applyRecovery({
    option_id: quote.option_id,
    revision: quote.revision,
    request_id: 'alias-confirmed-rollback',
  });

  assert.equal(result.outcome, 'applied');
  assert.equal(result.version, 'release-good');
  assert.equal(rollbackPosts, 1);
});

test('Vercel recovery skips duplicate deployments of the active release', async () => {
  const deployments = [
    ...deploymentFixtures().slice(0, 1),
    {
      uid: 'dpl_duplicate',
      projectId: vercelConfig.projectId,
      target: 'production',
      readyState: 'READY',
      createdAt: Date.parse('2026-08-28T10:30:00.000Z'),
      meta: { githubCommitSha: 'release-bad' },
    },
    ...deploymentFixtures().slice(1),
  ];
  const service = createVercelService({
    config: vercelConfig,
    now: FIXED_NOW,
    sleep: async () => {},
    async fetchImpl(url, options) {
      const parsed = new URL(url);
      if (options.method === 'GET' && parsed.pathname === '/v4/aliases/toolbraid-recovery-lab.vercel.app') {
        return jsonResponse({
          alias: vercelConfig.productionAlias,
          deploymentId: 'dpl_current',
          projectId: vercelConfig.projectId,
        });
      }
      if (options.method === 'GET' && parsed.pathname === '/v6/deployments') {
        return jsonResponse({ deployments });
      }
      throw new Error(`Unexpected Vercel mock request: ${options.method} ${parsed.pathname}`);
    },
  });

  const history = await service.readDeploymentHistory({ component: 'checkout', count: 3 });
  assert.deepEqual(
    history.rollouts.map(({ rollout_id, version }) => ({ rollout_id, version })),
    [
      { rollout_id: 'dpl_current', version: 'release-bad' },
      { rollout_id: 'dpl_previous', version: 'release-good' },
      { rollout_id: 'dpl_older', version: 'release-older' },
    ],
  );
  const quote = await service.prepareRecovery({
    rollout_id: 'dpl_current',
    rollback_target: 'release-good',
    action: 'rollback',
  });
  assert.equal(quote.rollback_target, 'release-good');
});

test('recovery quote HMAC rejects payload and signature tampering', () => {
  const payload = {
    projectId: 'prj_toolbraid_sandbox',
    environment: 'production',
    activeDeploymentId: 'dpl_current',
    targetDeploymentId: 'dpl_previous',
    targetVersion: 'release-good',
    issuedAt: 1,
    expiresAt: 2,
  };
  const quote = signRecoveryQuote(payload, vercelConfig.signingSecret);
  assert.deepEqual(verifyRecoveryQuote(quote.optionId, quote.revision, vercelConfig.signingSecret), {
    v: 1,
    ...payload,
  });
  assert.throws(
    () => verifyRecoveryQuote(`${quote.optionId}A`, quote.revision, vercelConfig.signingSecret),
    (error) => error.code === 'RECOVERY_QUOTE_INVALID',
  );
});

test('Vercel sandbox health uses HEAD, falls back to GET, and returns fixture-compatible fields', async () => {
  const methods = [];
  const service = createHealthService({
    config: { targetUrl: 'https://toolbraid-sandbox.vercel.app/health', timeoutMs: 1000 },
    now: FIXED_NOW,
    async fetchImpl(_url, options) {
      methods.push(options.method);
      return options.method === 'HEAD'
        ? { ok: false, status: 405 }
        : { ok: true, status: 200, async json() { return { checkout: { failureRatePercent: 0.02 } }; } };
    },
  });

  assert.deepEqual(await service.readHealth({ service: 'checkout' }), {
    state: 'operational',
    severity: 'The allowlisted Vercel sandbox is responding normally.',
    failure_rate: 0.02,
    first_seen_at: '2026-08-28T12:00:00.000Z',
    checked_at: '2026-08-28T12:00:00.000Z',
  });
  assert.deepEqual(methods, ['HEAD', 'GET']);
  await assert.rejects(
    () => service.readHealth({ service: 'other' }),
    (error) => error.code === 'TARGET_DENIED',
  );

  const degraded = createHealthService({
    config: { targetUrl: 'https://toolbraid-sandbox.vercel.app/health', timeoutMs: 1000 },
    now: FIXED_NOW,
    async fetchImpl(_url, options) {
      return options.method === 'HEAD'
        ? { ok: false, status: 405 }
        : {
            ok: false,
            status: 503,
            async json() {
              return {
                checkout: { failureRatePercent: 37.6 },
                incident: { severity: 'SEV-1', symptom: 'Checkout authorization failures' },
              };
            },
          };
    },
  });
  assert.deepEqual(await degraded.readHealth({ service: 'checkout' }), {
    state: 'degraded',
    severity: 'SEV-1: Checkout authorization failures',
    failure_rate: 37.6,
    first_seen_at: '2026-08-28T12:00:00.000Z',
    checked_at: '2026-08-28T12:00:00.000Z',
  });

  const unavailable = createHealthService({
    config: { targetUrl: 'https://toolbraid-sandbox.vercel.app/health', timeoutMs: 1000 },
    now: FIXED_NOW,
    async fetchImpl() {
      throw new Error('secret network detail');
    },
  });
  assert.equal((await unavailable.readHealth({ service: 'checkout' })).state, 'unavailable');
});
