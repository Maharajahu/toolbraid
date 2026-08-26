import test from 'node:test';
import assert from 'node:assert/strict';

import { createServer } from '../../src/server.js';

const VERSION = '2026-07-28';
const META = Object.freeze({
  'io.modelcontextprotocol/protocolVersion': VERSION,
  'io.modelcontextprotocol/clientCapabilities': {},
});

async function withServer(options, action) {
  const app = createServer({ fixture: true, ...options });
  const server = await app.listen(0, '127.0.0.1');
  const address = server.address();
  try {
    return await action({ app, url: `http://127.0.0.1:${address.port}` });
  } finally {
    await app.close();
  }
}

function request(method, params = {}, id = 1) {
  return { jsonrpc: '2.0', id, method, params: { ...params, _meta: META } };
}

function headers(method, name, extra = {}) {
  return {
    accept: 'application/json, text/event-stream',
    'content-type': 'application/json',
    'mcp-protocol-version': VERSION,
    'mcp-method': method,
    ...(name === undefined ? {} : { 'mcp-name': name }),
    ...extra,
  };
}

test('HTTP MCP endpoint validates mirrored headers and exposes six tools', async () => {
  await withServer({}, async ({ url }) => {
    const response = await fetch(`${url}/mcp`, {
      method: 'POST',
      headers: headers('tools/list'),
      body: JSON.stringify(request('tools/list')),
    });
    assert.equal(response.status, 200);
    const value = await response.json();
    assert.deepEqual(value.result.tools.map(({ name }) => name), [
      'capabilities.search',
      'capabilities.describe',
      'plan.propose',
      'workflow.execute',
      'workflow.status',
      'workflow.replay_readonly',
    ]);
  });
});

test('HTTP MCP endpoint rejects missing and mismatched metadata headers', async () => {
  await withServer({}, async ({ url }) => {
    const missing = await fetch(`${url}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request('tools/list')),
    });
    assert.equal(missing.status, 400);
    assert.equal((await missing.json()).error.code, -32020);

    const mismatch = await fetch(`${url}/mcp`, {
      method: 'POST',
      headers: headers('tools/call', 'workflow.status'),
      body: JSON.stringify(request('tools/call', {
        name: 'capabilities.search',
        arguments: { tenantId: 'tenant-a', subjectId: 'user-a', query: 'x' },
      })),
    });
    assert.equal(mismatch.status, 400);
    assert.equal((await mismatch.json()).error.code, -32020);
  });
});

test('HTTP MCP endpoint maps unknown methods to 404 and notifications to 202', async () => {
  await withServer({}, async ({ url }) => {
    const unknown = await fetch(`${url}/mcp`, {
      method: 'POST',
      headers: headers('unknown/method'),
      body: JSON.stringify(request('unknown/method')),
    });
    assert.equal(unknown.status, 404);
    assert.equal((await unknown.json()).error.code, -32601);

    const notification = request('tools/list');
    delete notification.id;
    const accepted = await fetch(`${url}/mcp`, {
      method: 'POST',
      headers: headers('tools/list'),
      body: JSON.stringify(notification),
    });
    assert.equal(accepted.status, 202);
    assert.equal(await accepted.text(), '');
  });
});

test('HTTP MCP endpoint fails closed on browser origins unless explicitly allowed', async () => {
  await withServer({}, async ({ url }) => {
    const denied = await fetch(`${url}/mcp`, {
      method: 'POST',
      headers: headers('tools/list', undefined, { origin: 'https://client.example' }),
      body: JSON.stringify(request('tools/list')),
    });
    assert.equal(denied.status, 403);
  });

  await withServer({ allowedHttpOrigins: ['https://client.example'] }, async ({ url }) => {
    const allowed = await fetch(`${url}/mcp`, {
      method: 'POST',
      headers: headers('tools/list', undefined, { origin: 'https://client.example' }),
      body: JSON.stringify(request('tools/list')),
    });
    assert.equal(allowed.status, 200);
  });
});

test('HTTP MCP endpoint enforces its path, method, media type and body limit', async () => {
  await withServer({}, async ({ url }) => {
    assert.equal((await fetch(`${url}/mcp`)).status, 405);
    assert.equal((await fetch(`${url}/rpc`, { method: 'POST' })).status, 404);

    const media = await fetch(`${url}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: '{}',
    });
    assert.equal(media.status, 415);

    const oversized = await fetch(`${url}/mcp`, {
      method: 'POST',
      headers: headers('tools/list'),
      body: `{"padding":"${'x'.repeat(1024 * 1024)}"}`,
    });
    assert.equal(oversized.status, 413);
    assert.equal((await oversized.json()).error.code, 'REQUEST_TOO_LARGE');
  });
});
