import test from 'node:test';
import assert from 'node:assert/strict';

import {
  UNIVERSAL_BUILTIN_CAPABILITY_PACKS,
  UNIVERSAL_GITHUB_CAPABILITY_PACK,
  UNIVERSAL_VERCEL_CAPABILITY_PACK,
  UNIVERSAL_X_CAPABILITY_PACK,
  createInternalUniversalBuiltinCapabilityPackCatalog,
  createUniversalBuiltinCapabilityPackCatalog,
} from '../../src/packs/universal/builtins.js';
import { createCapabilityPackRegistry } from '../../src/packs/universal/registry.js';
import {
  createGitHubAdapter,
  createSiteAdapterRegistry,
  createVercelAdapter,
  createXPostAdapter,
} from '../../src/site-adapters/index.js';

function snapshot(url) {
  return {
    metadata: { url, title: 'Built-in pack fixture' },
    mainText: 'Bounded fixture content.',
    headings: [],
    links: [],
    forms: [],
    accessibleControls: [],
    elementRefs: [],
  };
}

test('built-in manifests are bounded, deterministic, and use exact HTTPS hosts', () => {
  assert.deepEqual(
    UNIVERSAL_BUILTIN_CAPABILITY_PACKS.map(({ id, version, priority, maxTools }) => ({ id, version, priority, maxTools })),
    [
      { id: 'site.github', version: '1', priority: 90, maxTools: 4 },
      { id: 'site.vercel', version: '1', priority: 90, maxTools: 4 },
      { id: 'site.x', version: '1', priority: 100, maxTools: 8 },
    ],
  );
  for (const manifest of UNIVERSAL_BUILTIN_CAPABILITY_PACKS) {
    assert.deepEqual(manifest.hints.pathPrefixes, ['/']);
    assert.ok(manifest.hints.hosts.every((host) => !host.includes('://') && !host.includes('*')));
    assert.ok(manifest.hints.objectiveTokens.length > 0);
    assert.ok(manifest.maxTools >= 1 && manifest.maxTools <= 8);
    assert.equal(Object.hasOwn(manifest, 'load'), false);
    assert.equal(Object.values(manifest).some((value) => typeof value === 'function'), false);
  }
  assert.deepEqual(createUniversalBuiltinCapabilityPackCatalog(), UNIVERSAL_BUILTIN_CAPABILITY_PACKS);
  const internal = createInternalUniversalBuiltinCapabilityPackCatalog();
  assert.equal(internal.length, UNIVERSAL_BUILTIN_CAPABILITY_PACKS.length);
  assert.equal(internal.every((manifest) => typeof manifest.load === 'function'), true);
});

test('built-in selection is exact by HTTPS host and adapter route', () => {
  const registry = createCapabilityPackRegistry({
    catalog: createInternalUniversalBuiltinCapabilityPackCatalog(),
  });
  assert.deepEqual(registry.select(snapshot('https://x.com/alice/status/123')).map(({ id }) => id), ['site.x']);
  assert.deepEqual(registry.select(snapshot('https://github.com/acme/tool')).map(({ id }) => id), ['site.github']);
  assert.deepEqual(registry.select(snapshot('https://vercel.com/acme/tool')).map(({ id }) => id), ['site.vercel']);
  assert.deepEqual(registry.select(snapshot('http://x.com/alice/status/123')), []);
  assert.deepEqual(registry.select(snapshot('https://evil-x.com/alice/status/123')), []);
  assert.deepEqual(registry.select(snapshot('https://github.com.evil.test/acme/tool')), []);
});

test('each lazy loader invokes the existing adapter creator and exposes only its current read surface', async () => {
  const expected = [
    ['site.x', UNIVERSAL_X_CAPABILITY_PACK, 'x-post', 'read_x_post', 'https://x.com/alice/status/123'],
    ['site.github', UNIVERSAL_GITHUB_CAPABILITY_PACK, 'github', 'read_github_repository', 'https://github.com/acme/tool'],
    ['site.vercel', UNIVERSAL_VERCEL_CAPABILITY_PACK, 'vercel', 'read_vercel_project', 'https://vercel.com/acme/tool'],
  ];
  const trusted = createInternalUniversalBuiltinCapabilityPackCatalog();
  for (const [packId, publicManifest, adapterId, toolName, url] of expected) {
    const manifest = trusted.find((entry) => entry.id === packId);
    assert.equal(Object.hasOwn(publicManifest, 'load'), false);
    const adapter = await manifest.load();
    assert.equal(adapter.id, adapterId);
    assert.equal(adapter.version, '1');
    assert.equal(typeof adapter.matches, 'function');
    assert.equal(typeof adapter.generateTools, 'function');
    const result = await createCapabilityPackRegistry({ catalog: [manifest] }).resolve(snapshot(url));
    assert.deepEqual(result.tools.map(({ name }) => name), [toolName]);
    assert.equal(result.tools[0].adapter.id, adapterId);
    assert.equal(result.tools[0].adapter.version, '1');
    assert.equal(result.tools.some((tool) => typeof tool.execute === 'function'), false);
    assert.equal(result.tools.some((tool) => tool.classification === 'mutate'), false);
  }
});

test('built-in descriptors execute through the existing Universal verified-read runtime without duplication', async () => {
  const cases = [
    ['site.x', 'https://x.com/alice/status/123', createXPostAdapter(), 'x-post', 'x-post'],
    ['site.github', 'https://github.com/acme/tool', createGitHubAdapter(), 'github', 'github-repository'],
    ['site.vercel', 'https://vercel.com/acme/tool', createVercelAdapter(), 'vercel', 'vercel-project'],
  ];
  const trusted = createInternalUniversalBuiltinCapabilityPackCatalog();
  for (const [packId, url, adapter, adapterId, resultType] of cases) {
    const packRegistry = createCapabilityPackRegistry({
      catalog: [trusted.find((manifest) => manifest.id === packId)],
    });
    const page = snapshot(url);
    const resolved = await packRegistry.resolve(page, { sessionId: `${packId}-runtime` });
    assert.equal(resolved.tools.length, 1);
    assert.equal(new Set(resolved.tools.map(({ name }) => name)).size, resolved.tools.length);
    assert.deepEqual(resolved.tools[0].adapter, { id: adapterId, version: '1' });
    const runtime = createSiteAdapterRegistry({ adapters: [adapter] });
    const read = runtime.executeRead(resolved.tools[0], page);
    assert.equal(read.type, resultType);
  }
});
