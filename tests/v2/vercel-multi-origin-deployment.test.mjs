import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  RECOVERY_PROVIDER_IDS,
  createAppRequestHandler,
  createProviderRequestHandler,
} from '../../scripts/serve-multi-origin.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const output = await mkdtemp(path.join(os.tmpdir(), 'toolbraid-vercel-build-'));
const build = spawnSync(process.execPath, [path.join(root, 'scripts/build-vercel-multi-origin.mjs'), output], {
  cwd: root,
  encoding: 'utf8',
});

assert.equal(build.status, 0, build.stderr || build.stdout);
after(() => rm(output, { recursive: true, force: true }));

const config = JSON.parse(await readFile(path.join(root, 'vercel.json'), 'utf8'));
const appHost = 'app.toolbraid.dev';
const appOrigin = `https://${appHost}`;
const providerHosts = RECOVERY_PROVIDER_IDS.map((providerId) => `${providerId}.toolbraid.dev`);
const providerOrigins = providerHosts.map((host) => `https://${host}`);
const allHosts = [appHost, ...providerHosts];

function hostCondition(entry) {
  assert.equal(entry.has?.length, 1);
  assert.equal(entry.has[0].type, 'host');
  return entry.has[0].value;
}

function configuredHeaders(host) {
  const entry = config.headers.find((candidate) => hostCondition(candidate) === host);
  assert.ok(entry, `Missing headers for ${host}`);
  return Object.fromEntries(entry.headers.map(({ key, value }) => [key.toLowerCase(), value]));
}

async function withServer(handler, callback) {
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    const address = server.address();
    return await callback(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

async function runtimeSecurityHeaders(handler) {
  return withServer(handler, async (origin) => {
    const response = await fetch(origin);
    assert.equal(response.status, 200);
    const ignored = new Set(['content-length', 'content-type', 'date', 'connection', 'keep-alive']);
    return Object.fromEntries([...response.headers].filter(([key]) => !ignored.has(key)));
  });
}

async function walk(relative = '') {
  const directory = path.join(output, relative);
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) files.push(...await walk(child));
    else files.push(child.split(path.sep).join('/'));
  }
  return files;
}

test('Vercel topology uses exactly the seven production hosts and a static build', () => {
  assert.equal(config.buildCommand, 'node scripts/build-vercel-multi-origin.mjs');
  assert.equal(config.outputDirectory, 'dist/vercel-multi-origin');
  assert.equal(config.functions, undefined);

  const rewriteHosts = [...new Set(config.rewrites.map(hostCondition))];
  const headerHosts = config.headers.map(hostCondition);
  assert.deepEqual(rewriteHosts, allHosts);
  assert.deepEqual(headerHosts, allHosts);
  assert.equal(config.rewrites.length, 14);

  for (const host of allHosts) {
    const originId = host === appHost ? 'app' : host.split('.')[0];
    const routes = config.rewrites.filter((entry) => hostCondition(entry) === host);
    assert.deepEqual(routes.map(({ source }) => source), ['/', '/:path*']);
    assert.deepEqual(routes.map(({ destination }) => destination), [
      `/_toolbraid_origins/${originId}/index.html`,
      `/_toolbraid_origins/${originId}/:path*`,
    ]);
  }
});

test('generated artifact contains only browser-public application and provider files', async () => {
  const originRoot = path.join(output, '_toolbraid_origins');
  const originIds = (await readdir(originRoot)).sort();
  assert.deepEqual(originIds, ['app', ...RECOVERY_PROVIDER_IDS].sort());

  const files = await walk();
  for (const forbidden of [
    'package.json',
    'vercel.json',
    '.git/',
    '.github/',
    'scripts/',
    'tests/',
    'docs/',
    'video-production/',
    '.private/',
  ]) {
    assert.equal(files.some((file) => file === forbidden || file.startsWith(forbidden)), false, forbidden);
  }

  assert.equal((await stat(path.join(originRoot, 'app/index.html'))).isFile(), true);
  assert.equal((await stat(path.join(originRoot, 'app/src/app/main.js'))).isFile(), true);
  assert.equal((await stat(path.join(originRoot, 'app/src/engine/approval.js'))).isFile(), true);

  for (const providerId of RECOVERY_PROVIDER_IDS) {
    const providerRoot = path.join(originRoot, providerId);
    const html = await readFile(path.join(providerRoot, 'index.html'), 'utf8');
    const source = await readFile(path.join(providerRoot, 'provider.js'), 'utf8');
    assert.match(html, new RegExp(`${providerId}\\s·|${providerId} ·`));
    assert.match(source, new RegExp(`createProviderRuntime\\('${providerId}'\\)`));
    assert.equal((await stat(path.join(providerRoot, 'runtime.js'))).isFile(), true);
    assert.equal((await stat(path.join(providerRoot, 'src/providers/recovery/catalog.js'))).isFile(), true);
    assert.equal(files.some((file) => file.startsWith(`_toolbraid_origins/${providerId}/providers/`)), false);
  }
});

test('Vercel app headers exactly match the production multi-origin server policy', async () => {
  const expected = await runtimeSecurityHeaders(createAppRequestHandler({ providerOrigins }));
  assert.deepEqual(configuredHeaders(appHost), expected);
  assert.equal(expected['permissions-policy'], `tools=(self${providerOrigins.map((origin) => ` \"${origin}\"`).join('')})`);
  assert.match(expected['content-security-policy'], /frame-ancestors 'none'$/);
  assert.equal(expected['x-frame-options'], 'DENY');
});

test('each Vercel provider has the isolated provider policy and only app authority', async () => {
  for (const [index, providerId] of RECOVERY_PROVIDER_IDS.entries()) {
    const expected = await runtimeSecurityHeaders(createProviderRequestHandler({
      providerId,
      orchestratorOrigin: appOrigin,
    }));
    const actual = configuredHeaders(providerHosts[index]);
    assert.deepEqual(actual, expected);
    assert.equal(actual['permissions-policy'], `tools=(self \"${appOrigin}\")`);
    assert.match(actual['content-security-policy'], new RegExp(`frame-ancestors ${appOrigin}$`));
    assert.equal(actual['connect-src'], undefined);
    assert.equal(actual['x-frame-options'], undefined);
  }
});
