import assert from 'node:assert/strict';
import test from 'node:test';

import { startUniversalFixtureServer } from '../../scripts/serve-universal-fixtures.mjs';

test('serves semantic, adversarial, media, SPA, shadow, and social fixtures', async () => {
  const server = await startUniversalFixtureServer({ port: 0 });
  try {
    for (const path of ['/article', '/form', '/spa', '/shadow', '/adversarial', '/media', '/x-post']) {
      const response = await fetch(`${server.origin}${path}`);
      assert.equal(response.status, 200, path);
      assert.match(response.headers.get('content-security-policy'), /object-src 'none'/);
      assert.match(await response.text(), /<!doctype html>/i);
    }
  } finally {
    await server.close();
  }
});
test('records a real bounded fixture mutation and exposes a receipt', async () => {
  const server = await startUniversalFixtureServer({ port: 0 });
  try {
    const response = await fetch(`${server.origin}/api/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ title: 'Recovered', audience: 'customers', message: 'Healthy', confirm: 'yes' }),
    });
    assert.equal(response.status, 201);
    assert.match(await response.text(), /fixture-submission-1 created/);
    const state = await (await fetch(`${server.origin}/api/state`)).json();
    assert.equal(state.submissions.length, 1);
    assert.equal(state.submissions[0].message, 'Healthy');
  } finally {
    await server.close();
  }
});
