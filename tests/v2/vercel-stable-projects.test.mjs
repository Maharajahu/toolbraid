import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';

import { RECOVERY_DEPLOYMENT_PROFILES } from '../../src/providers/recovery/catalog.js';
import {
  appHeaders,
  providerHeaders,
  RECOVERY_PROVIDER_IDS,
} from '../../scripts/serve-multi-origin.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'toolbraid-vercel-stable-'));
const output = path.join(temporaryRoot, 'projects');
const multiOriginOutput = path.join(temporaryRoot, 'multi-origin');
const build = spawnSync(process.execPath, [
  path.join(root, 'scripts/build-vercel-stable-projects.mjs'),
  output,
  multiOriginOutput,
], {
  cwd: root,
  encoding: 'utf8',
});

assert.equal(build.status, 0, build.stderr || build.stdout);
after(() => rm(temporaryRoot, { recursive: true, force: true }));

const manifest = JSON.parse(await readFile(
  path.join(root, 'deployment/vercel-stable-projects.json'),
  'utf8',
));
const profile = RECOVERY_DEPLOYMENT_PROFILES.vercelStable;
const originIds = ['app', ...RECOVERY_PROVIDER_IDS];

function headerObject(config) {
  assert.equal(config.headers.length, 1);
  assert.equal(config.headers[0].source, '/(.*)');
  return Object.fromEntries(config.headers[0].headers.map(({ key, value }) => [key, value]));
}

function assertSelfContainedBuildConfig(config) {
  assert.equal(config.framework, null);
  assert.equal(config.buildCommand, '');
  assert.equal(config.installCommand, '');
  assert.equal(config.outputDirectory, '.');
}

test('stable manifest pins all seven project names and production aliases', () => {
  assert.equal(manifest.profile, profile.id);
  assert.deepEqual(Object.keys(manifest.projects), originIds);
  assert.equal(manifest.projects.app.project, 'toolbraid-webmcp');
  assert.equal(manifest.projects.app.origin, profile.orchestratorOrigin);

  for (const providerId of RECOVERY_PROVIDER_IDS) {
    assert.equal(manifest.projects[providerId].project, `toolbraid-${providerId}-webmcp`);
    assert.equal(manifest.projects[providerId].origin, profile.providerOrigins[providerId]);
  }
});

test('stable build emits one self-contained root per Vercel project with scoped live functions', async () => {
  assert.deepEqual((await readdir(output)).sort(), [...originIds].sort());
  assert.equal((await stat(path.join(output, 'app/index.html'))).isFile(), true);
  assert.equal((await stat(path.join(output, 'app/src/app/main.js'))).isFile(), true);

  for (const providerId of RECOVERY_PROVIDER_IDS) {
    const providerRoot = path.join(output, providerId);
    assert.equal((await stat(path.join(providerRoot, 'index.html'))).isFile(), true);
    assert.equal((await stat(path.join(providerRoot, 'provider.js'))).isFile(), true);
    assert.equal((await stat(path.join(providerRoot, 'runtime.js'))).isFile(), true);
    assert.equal((await stat(path.join(providerRoot, 'live-services.js'))).isFile(), true);
  }

  const liveRoutes = {
    signals: 'live-health.mjs',
    pulse: 'live-health.mjs',
    source: 'live-source.mjs',
    deploy: 'live-deploy.mjs',
    status: 'live-status.mjs',
  };
  for (const [providerId, route] of Object.entries(liveRoutes)) {
    assert.equal((await stat(path.join(output, providerId, 'api', route))).isFile(), true);
    assert.equal((await stat(path.join(output, providerId, 'server/live-services'))).isDirectory(), true);
  }
  await assert.rejects(stat(path.join(output, 'app/api')));
  await assert.rejects(stat(path.join(output, 'mirage/api')));
});

test('each stable project carries only its exact production security policy', async () => {
  const appConfig = JSON.parse(await readFile(path.join(output, 'app/vercel.json'), 'utf8'));
  assertSelfContainedBuildConfig(appConfig);
  assert.equal(appConfig.rewrites, undefined);
  assert.deepEqual(
    headerObject(appConfig),
    appHeaders(Object.values(profile.providerOrigins)),
  );

  for (const providerId of RECOVERY_PROVIDER_IDS) {
    const providerConfig = JSON.parse(await readFile(
      path.join(output, providerId, 'vercel.json'),
      'utf8',
    ));
    assertSelfContainedBuildConfig(providerConfig);
    assert.equal(providerConfig.rewrites, undefined);
    assert.deepEqual(headerObject(providerConfig), providerHeaders(profile.orchestratorOrigin));
    assert.deepEqual(
      providerConfig.functions,
      providerId === 'deploy' ? { 'api/live-deploy.mjs': { maxDuration: 60 } } : undefined,
    );
  }
});
