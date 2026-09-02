import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import {
  RECOVERY_PROVIDER_IDS,
  createAppRequestHandler,
  createProviderRequestHandler,
} from '../../scripts/serve-multi-origin.mjs';

const ORCHESTRATOR = 'http://127.0.0.1:4173';
const PROVIDER_ORIGINS = RECOVERY_PROVIDER_IDS.map((_, index) => `http://127.0.0.1:${4174 + index}`);

async function withServer(handler, callback) {
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  try {
    return await callback(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

test('application origin delegates WebMCP only to the six provider origins', async () => {
  const handler = createAppRequestHandler({ providerOrigins: PROVIDER_ORIGINS });
  await withServer(handler, async (origin) => {
    const response = await fetch(`${origin}/live.html`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /^text\/html/);
    assert.equal(
      response.headers.get('permissions-policy'),
      `tools=(self${PROVIDER_ORIGINS.map((providerOrigin) => ` "${providerOrigin}"`).join('')})`,
    );
    assert.match(response.headers.get('content-security-policy'), /frame-src http:\/\/127\.0\.0\.1:4174/);
    assert.match(await response.text(), /src\/app\/main\.js/);
  });
});

test('application origin denies repository internals and unsupported methods', async () => {
  const handler = createAppRequestHandler({ providerOrigins: PROVIDER_ORIGINS });
  await withServer(handler, async (origin) => {
    assert.equal((await fetch(`${origin}/.git/config`)).status, 404);
    assert.notEqual((await fetch(`${origin}/src/%2e%2e/package.json`)).status, 200);
    const post = await fetch(`${origin}/`, { method: 'POST' });
    assert.equal(post.status, 405);
    assert.equal(post.headers.get('allow'), 'GET, HEAD');
  });
});

for (const providerId of RECOVERY_PROVIDER_IDS) {
  test(`${providerId} origin serves only its assigned native provider document`, async () => {
    const handler = createProviderRequestHandler({ providerId, orchestratorOrigin: ORCHESTRATOR });
    await withServer(handler, async (origin) => {
      const documentResponse = await fetch(`${origin}/`);
      assert.equal(documentResponse.status, 200);
      assert.equal(
        documentResponse.headers.get('permissions-policy'),
        `tools=(self "${ORCHESTRATOR}")`,
      );
      assert.match(documentResponse.headers.get('content-security-policy'), new RegExp(`frame-ancestors ${ORCHESTRATOR}`));
      assert.match(await documentResponse.text(), new RegExp(`${providerId}\\s·|${providerId} ·`));

      const entryResponse = await fetch(`${origin}/provider.js`);
      const entrySource = await entryResponse.text();
      assert.equal(entryResponse.status, 200);
      assert.match(entrySource, /document\.modelContext\.registerTool\(\{/);
      assert.match(entrySource, /\{ exposedTo: \[orchestratorOrigin\], signal \}/);
      assert.match(entrySource, new RegExp(`createProviderRuntime\\('${providerId}'\\)`));

      assert.equal((await fetch(`${origin}/src/providers/recovery/catalog.js`)).status, 200);
      assert.equal((await fetch(`${origin}/package.json`)).status, 404);
      assert.equal((await fetch(`${origin}/providers/recovery/pulse.html`)).status, 404);

      const head = await fetch(`${origin}/provider.js`, { method: 'HEAD' });
      assert.equal(head.status, 200);
      assert.equal(await head.text(), '');
    });
  });
}
