import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { RECOVERY_DEPLOYMENT_PROFILES } from '../src/providers/recovery/catalog.js';
import { appHeaders, providerHeaders, RECOVERY_PROVIDER_IDS } from './serve-multi-origin.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.resolve(process.argv[2] ?? path.join(projectRoot, 'dist', 'vercel-stable-projects'));
const multiOriginOutput = path.resolve(process.argv[3] ?? path.join(projectRoot, 'dist', 'vercel-multi-origin'));
const manifestPath = path.join(projectRoot, 'deployment', 'vercel-stable-projects.json');
const profile = RECOVERY_DEPLOYMENT_PROFILES.vercelStable;
const LIVE_API_BY_PROVIDER = Object.freeze({
  signals: 'live-health.mjs',
  pulse: 'live-health.mjs',
  source: 'live-source.mjs',
  deploy: 'live-deploy.mjs',
  status: 'live-status.mjs',
});

function isWithin(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function assertSafeOutput(target) {
  const allowedRoots = [path.join(projectRoot, 'dist'), os.tmpdir()];
  if (!allowedRoots.some((allowedRoot) => isWithin(allowedRoot, target))) {
    throw new Error(`Stable Vercel output must stay inside ${path.join(projectRoot, 'dist')} or the system temporary directory.`);
  }
}

function vercelConfig(headers, { liveApi } = {}) {
  return {
    $schema: 'https://openapi.vercel.sh/vercel.json',
    cleanUrls: false,
    trailingSlash: false,
    ...(liveApi === 'live-deploy.mjs'
      ? { functions: { 'api/live-deploy.mjs': { maxDuration: 60 } } }
      : {}),
    headers: [{
      source: '/(.*)',
      headers: Object.entries(headers).map(([key, value]) => ({ key, value })),
    }],
  };
}

function runMultiOriginBuild() {
  const result = spawnSync(process.execPath, [
    path.join(projectRoot, 'scripts', 'build-vercel-multi-origin.mjs'),
    multiOriginOutput,
  ], {
    cwd: projectRoot,
    encoding: 'utf8',
  });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || 'Multi-origin build failed.');
}

assertSafeOutput(output);
assertSafeOutput(multiOriginOutput);
runMultiOriginBuild();

const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const expectedIds = ['app', ...RECOVERY_PROVIDER_IDS];
if (manifest.profile !== profile.id || Object.keys(manifest.projects).join(',') !== expectedIds.join(',')) {
  throw new Error('Stable Vercel project manifest does not match the recovery deployment profile.');
}

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });

for (const originId of expectedIds) {
  const project = manifest.projects[originId];
  const expectedOrigin = originId === 'app'
    ? profile.orchestratorOrigin
    : profile.providerOrigins[originId];
  if (project.origin !== expectedOrigin) {
    throw new Error(`Stable Vercel origin mismatch for ${originId}.`);
  }

  const projectOutput = path.join(output, originId);
  await cp(path.join(multiOriginOutput, '_toolbraid_origins', originId), projectOutput, {
    recursive: true,
    force: true,
  });
  const liveApi = LIVE_API_BY_PROVIDER[originId];
  if (liveApi) {
    await mkdir(path.join(projectOutput, 'api'), { recursive: true });
    await cp(path.join(projectRoot, 'api', liveApi), path.join(projectOutput, 'api', liveApi), {
      force: true,
    });
    await cp(path.join(projectRoot, 'server', 'live-services'), path.join(projectOutput, 'server', 'live-services'), {
      recursive: true,
      force: true,
    });
  }
  const securityHeaders = originId === 'app'
    ? appHeaders(Object.values(profile.providerOrigins))
    : providerHeaders(profile.orchestratorOrigin);
  await writeFile(
    path.join(projectOutput, 'vercel.json'),
    `${JSON.stringify(vercelConfig(securityHeaders, { liveApi }), null, 2)}\n`,
    'utf8',
  );
}

console.log(`Stable Vercel deployment roots written to ${output} (7 linked projects).`);
