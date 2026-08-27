import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); });
  });
}
async function waitFor(url) {
  for (let i = 0; i < 80; i += 1) {
    try { const response = await fetch(url); if (response.ok) return; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Server did not become ready: ${url}`);
}
function localUrl(base, current, candidate) {
  if (!candidate || candidate.startsWith('#') || candidate.startsWith('data:') || candidate.startsWith('http:') || candidate.startsWith('https:')) return null;
  return new URL(candidate, new URL(current, base)).pathname;
}
function dependencies(text, pathname, contentType) {
  const found = new Set();
  if (contentType.includes('html')) for (const match of text.matchAll(/(?:src|href)=["']([^"']+)["']/g)) found.add(match[1]);
  if (contentType.includes('javascript')) for (const match of text.matchAll(/\b(?:from|import)\s+["']([^"']+)["']/g)) found.add(match[1]);
  return [...found].map((candidate) => localUrl('http://placeholder', pathname, candidate)).filter(Boolean);
}
const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['scripts/serve.mjs', String(port)], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
let stderr = '';
server.stderr.on('data', (chunk) => { stderr += chunk; });
try {
  await waitFor(`${base}/`);
  const queue = ['/'];
  const visited = new Map();
  while (queue.length) {
    const pathname = queue.shift();
    if (visited.has(pathname)) continue;
    const response = await fetch(`${base}${pathname}`);
    assert.equal(response.status, 200, `${pathname} must return HTTP 200`);
    const contentType = response.headers.get('content-type') ?? '';
    const body = await response.text();
    visited.set(pathname, { contentType, bytes: Buffer.byteLength(body) });
    for (const dependency of dependencies(body, pathname, contentType)) if (!visited.has(dependency)) queue.push(dependency);
  }
  const rootResponse = await fetch(`${base}/`);
  assert.equal(rootResponse.headers.get('permissions-policy'), 'tools=(self)');
  assert.equal(rootResponse.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(rootResponse.headers.get('referrer-policy'), 'no-referrer');
  const html = await rootResponse.text();
  assert.equal((html.match(/<iframe\b/g) ?? []).length, 0, 'mission control must not depend on legacy provider frames');
  assert.match(html, /data-constellation/, 'constellation mount must be present');
  assert.match(html, /data-approval-dock/, 'human approval dock must be present');
  assert.match(html, /data-panel-heading/, 'evidence inspector must be present');
  assert.match(html, /data-provider-runtime/, 'isolated native provider mount must be present');
  assert.match(html, /src\/app\/main\.js/, 'mission control entry module must be linked');
  for (const pathname of [
    '/src/app/mission-control.css',
    '/src/app/main.js',
    '/src/app/constellation.js',
    '/src/app/icons.js',
    '/src/app/mission-state.js',
    '/src/app/mission-controller.js',
    '/src/engine/webmcp.js',
    '/src/engine/audit.js',
    '/src/packs/recovery/plan.js',
    '/src/providers/recovery/catalog.js',
  ]) {
    assert.ok(visited.has(pathname), `${pathname} must be reachable`);
  }
  assert.equal(
    [...visited.keys()].some((pathname) => pathname.startsWith('/providers/')),
    false,
    'provider documents must remain isolated from the local non-native harness',
  );
  const missing = await fetch(`${base}/definitely-not-a-real-file`);
  assert.equal(missing.status, 404);
  console.log(`Static smoke passed: ${visited.size} recovery resources, isolated provider runtime, security headers, and 404 handling.`);
} finally {
  server.kill('SIGTERM');
  await new Promise((resolve) => server.once('exit', resolve));
  if (stderr.trim()) process.stderr.write(stderr);
}
