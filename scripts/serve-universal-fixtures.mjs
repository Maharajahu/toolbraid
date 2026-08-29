import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtureRoot = path.join(root, 'fixtures', 'universal');

const ROUTES = new Map([
  ['/', 'index.html'],
  ['/article', 'article.html'],
  ['/form', 'form.html'],
  ['/spa', 'spa.html'],
  ['/spa/incident/INC-42', 'spa.html'],
  ['/shadow', 'shadow.html'],
  ['/adversarial', 'adversarial.html'],
  ['/media', 'media.html'],
  ['/x-post', 'x-post.html'],
  ['/assets/fixture-captions.vtt', 'fixture-captions.vtt'],
]);

const MIME = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.vtt', 'text/vtt; charset=utf-8'],
]);

function send(response, status, body, contentType = 'text/plain; charset=utf-8', extra = {}) {
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
  response.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': bytes.byteLength,
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'self' data:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self' data:; object-src 'none'; base-uri 'none'",
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    ...extra,
  });
  response.end(bytes);
}

function readBody(request, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error('Request body too large.'), { statusCode: 413 }));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

export function createUniversalFixtureHandler() {
  const state = { submissions: [], nextId: 1 };
  return async function handle(request, response) {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    try {
      if (request.method === 'GET' && url.pathname === '/api/state') {
        send(response, 200, JSON.stringify(state), 'application/json; charset=utf-8');
        return;
      }
      if (request.method === 'POST' && url.pathname === '/api/reset') {
        state.submissions.length = 0;
        state.nextId = 1;
        send(response, 200, JSON.stringify({ reset: true }), 'application/json; charset=utf-8');
        return;
      }
      if (request.method === 'POST' && url.pathname === '/api/submit') {
        const params = new URLSearchParams(await readBody(request));
        const submission = {
          id: `fixture-submission-${state.nextId++}`,
          title: params.get('title'),
          audience: params.get('audience'),
          message: params.get('message'),
          confirm: params.get('confirm'),
        };
        state.submissions.push(submission);
        send(response, 201, `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Publication receipt</title></head><body><main><h1>Publication receipt</h1><p role="status">${submission.id} created</p><a href="/form">Return to form</a></main></body></html>`, 'text/html; charset=utf-8');
        return;
      }
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        send(response, 405, 'Method not allowed', 'text/plain; charset=utf-8', { Allow: 'GET, HEAD, POST' });
        return;
      }
      const relative = ROUTES.get(url.pathname);
      if (!relative) {
        if (url.pathname === '/assets/fixture-audio.wav' || url.pathname === '/assets/fixture-video.mp4') {
          send(response, 404, 'Fixture media intentionally absent; degradation must remain visible.');
          return;
        }
        send(response, 404, 'Not found');
        return;
      }
      const target = path.join(fixtureRoot, relative);
      const body = await readFile(target);
      send(response, 200, request.method === 'HEAD' ? Buffer.alloc(0) : body, MIME.get(path.extname(target)) ?? 'application/octet-stream');
    } catch (error) {
      send(response, error?.statusCode ?? 500, error?.statusCode ? error.message : 'Server error');
    }
  };
}

export function startUniversalFixtureServer({ host = '127.0.0.1', port = 4190 } = {}) {
  const server = http.createServer(createUniversalFixtureHandler());
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve(Object.freeze({
        origin: `http://${host}:${server.address().port}`,
        close: () => new Promise((done, fail) => server.close((error) => error ? fail(error) : done())),
      }));
    });
  });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const runtime = await startUniversalFixtureServer({ port: Number(process.env.PORT ?? 4190) });
  console.log(`ToolBraid Universal fixtures: ${runtime.origin}`);
  const shutdown = async () => { await runtime.close(); process.exit(0); };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}
