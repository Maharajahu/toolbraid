import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const MULTI_ORIGIN_PORTS = Object.freeze({
  app: 4173,
  signals: 4174,
  pulse: 4175,
  source: 4176,
  deploy: 4177,
  status: 4178,
  mirage: 4179,
});

export const RECOVERY_PROVIDER_IDS = Object.freeze([
  'signals',
  'pulse',
  'source',
  'deploy',
  'status',
  'mirage',
]);

const MIME = Object.freeze({
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
});

const APP_FILES = Object.freeze(new Map([
  ['/', 'index.html'],
  ['/index.html', 'index.html'],
  ['/manifest.webmanifest', 'manifest.webmanifest'],
  ['/robots.txt', 'robots.txt'],
  ['/llms.txt', 'llms.txt'],
]));

const APP_DIRECTORIES = Object.freeze([
  Object.freeze({ prefix: '/assets/', directory: 'assets' }),
  Object.freeze({ prefix: '/src/', directory: 'src' }),
]);

function originFor(host, port) {
  const urlHost = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  return `http://${urlHost}:${port}`;
}

function parsePathname(requestUrl) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(requestUrl || '/', 'http://toolbraid.local').pathname);
  } catch {
    const error = new Error('Malformed request path.');
    error.statusCode = 400;
    throw error;
  }
  if (pathname.includes('\0')) {
    const error = new Error('Invalid request path.');
    error.statusCode = 400;
    throw error;
  }
  if (pathname.split('/').some((segment) => segment === '..' || segment === '.')) {
    const error = new Error('Path traversal is forbidden.');
    error.statusCode = 403;
    throw error;
  }
  return pathname;
}

function containedPath(directory, relativePath) {
  const allowedRoot = path.resolve(projectRoot, directory);
  const target = path.resolve(allowedRoot, relativePath);
  if (target !== allowedRoot && !target.startsWith(`${allowedRoot}${path.sep}`)) {
    const error = new Error('Path traversal is forbidden.');
    error.statusCode = 403;
    throw error;
  }
  return target;
}

function appFileFor(pathname) {
  const exact = APP_FILES.get(pathname);
  if (exact) return containedPath('.', exact);
  for (const route of APP_DIRECTORIES) {
    if (pathname.startsWith(route.prefix)) {
      return containedPath(route.directory, pathname.slice(route.prefix.length));
    }
  }
  return null;
}

function providerFileFor(providerId, pathname) {
  const routes = new Map([
    ['/', `providers/recovery/${providerId}.html`],
    ['/index.html', `providers/recovery/${providerId}.html`],
    ['/provider.js', `providers/recovery/${providerId}.js`],
    ['/provider.css', 'providers/recovery/provider.css'],
    ['/runtime.js', 'providers/recovery/runtime.js'],
    ['/src/providers/recovery/catalog.js', 'src/providers/recovery/catalog.js'],
  ]);
  const relativePath = routes.get(pathname);
  return relativePath ? containedPath('.', relativePath) : null;
}

function permissionsPolicy(origins) {
  return `tools=(self${origins.map((origin) => ` "${origin}"`).join('')})`;
}

export function appHeaders(providerOrigins) {
  const sourceList = providerOrigins.join(' ');
  return Object.freeze({
    'Cache-Control': 'no-store',
    'Content-Security-Policy': `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self' ${sourceList}; frame-src ${sourceList}; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'`,
    'Cross-Origin-Opener-Policy': 'same-origin-allow-popups',
    'Permissions-Policy': permissionsPolicy(providerOrigins),
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
  });
}

export function providerHeaders(orchestratorOrigin) {
  return Object.freeze({
    'Cache-Control': 'no-store',
    'Content-Security-Policy': `default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'none'; img-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors ${orchestratorOrigin}`,
    'Cross-Origin-Opener-Policy': 'same-origin-allow-popups',
    'Permissions-Policy': permissionsPolicy([orchestratorOrigin]),
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
  });
}

function writeText(response, statusCode, text, headers = {}) {
  const body = Buffer.from(text, 'utf8');
  response.writeHead(statusCode, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': body.byteLength,
    ...headers,
  });
  response.end(body);
}

function createStaticHandler({ resolveFile, headers }) {
  return async function handleStaticRequest(request, response) {
    if (!['GET', 'HEAD'].includes(request.method || 'GET')) {
      writeText(response, 405, 'Method not allowed', { Allow: 'GET, HEAD' });
      return;
    }

    try {
      const pathname = parsePathname(request.url);
      const filePath = resolveFile(pathname);
      if (!filePath) {
        writeText(response, 404, 'Not found');
        return;
      }

      const info = await stat(filePath);
      if (!info.isFile()) {
        writeText(response, 404, 'Not found');
        return;
      }
      const body = await readFile(filePath);
      response.writeHead(200, {
        ...headers,
        'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
        'Content-Length': body.byteLength,
      });
      response.end(request.method === 'HEAD' ? undefined : body);
    } catch (error) {
      const statusCode = error?.statusCode ?? (error?.code === 'ENOENT' ? 404 : 500);
      const message = statusCode === 400
        ? 'Bad request'
        : statusCode === 403
          ? 'Forbidden'
          : statusCode === 404
            ? 'Not found'
            : 'Server error';
      writeText(response, statusCode, message);
    }
  };
}

export function createAppRequestHandler({ providerOrigins }) {
  return createStaticHandler({
    resolveFile: appFileFor,
    headers: appHeaders(providerOrigins),
  });
}

export function createProviderRequestHandler({ providerId, orchestratorOrigin }) {
  if (!RECOVERY_PROVIDER_IDS.includes(providerId)) throw new TypeError(`Unknown provider: ${providerId}`);
  return createStaticHandler({
    resolveFile: (pathname) => providerFileFor(providerId, pathname),
    headers: providerHeaders(orchestratorOrigin),
  });
}

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    const handleError = (error) => {
      server.off('listening', handleListening);
      reject(error);
    };
    const handleListening = () => {
      server.off('error', handleError);
      resolve();
    };
    server.once('error', handleError);
    server.once('listening', handleListening);
    server.listen(port, host);
  });
}

function close(server) {
  return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

export async function startMultiOriginServers({
  host = process.env.HOST || '127.0.0.1',
  ports = MULTI_ORIGIN_PORTS,
} = {}) {
  const orchestratorOrigin = originFor(host, ports.app);
  const providerOrigins = Object.freeze(Object.fromEntries(
    RECOVERY_PROVIDER_IDS.map((providerId) => [providerId, originFor(host, ports[providerId])]),
  ));
  const servers = [];

  try {
    const appServer = http.createServer(createAppRequestHandler({ providerOrigins: Object.values(providerOrigins) }));
    await listen(appServer, ports.app, host);
    servers.push(appServer);

    for (const providerId of RECOVERY_PROVIDER_IDS) {
      const server = http.createServer(createProviderRequestHandler({ providerId, orchestratorOrigin }));
      await listen(server, ports[providerId], host);
      servers.push(server);
    }
  } catch (error) {
    await Promise.allSettled(servers.map(close));
    throw error;
  }

  let closed = false;
  return Object.freeze({
    orchestratorOrigin,
    providerOrigins,
    async close() {
      if (closed) return;
      closed = true;
      await Promise.all(servers.map(close));
    },
  });
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const runtime = await startMultiOriginServers();
  console.log(`ToolBraid orchestrator: ${runtime.orchestratorOrigin}`);
  for (const providerId of RECOVERY_PROVIDER_IDS) {
    console.log(`${providerId.padEnd(8)} provider: ${runtime.providerOrigins[providerId]}`);
  }

  const shutdown = async () => {
    await runtime.close();
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}
