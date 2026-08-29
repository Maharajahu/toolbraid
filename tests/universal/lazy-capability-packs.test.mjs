import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_CAPABILITY_PACK_OBJECTIVE_TOKENS,
  createCapabilityPackCatalog,
} from '../../src/packs/universal/catalog.js';
import {
  CapabilityPackError,
  createCapabilityPackRegistry,
} from '../../src/packs/universal/registry.js';

function snapshot(url = 'https://example.com/app/inbox', extra = {}) {
  return {
    metadata: { url, title: 'Test page' },
    mainText: 'A bounded test page.',
    capabilityPacks: [{
      id: 'page-installed-pack',
      load: () => ({ matches: () => true, generateTools: () => [] }),
    }],
    ...extra,
  };
}

function readTool(page, name = 'pack_read') {
  return {
    version: 1,
    name,
    title: 'Read page',
    description: 'Read-only test descriptor.',
    classification: 'read',
    kind: 'read',
    risk: 'read-only',
    sourceType: 'page',
    requiresApproval: false,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, untrustedContentHint: true },
    provenance: {
      source: 'test-pack',
      pageFingerprint: page.pageFingerprint,
      sourceType: 'page',
      targetFingerprint: null,
    },
    pageFingerprint: page.pageFingerprint,
    target: { ref: null, elementRef: null, type: 'page', targetFingerprint: null, binding: {} },
    elementRef: null,
    effect: {
      classification: 'read',
      summary: 'Read test page.',
      externalStateChange: false,
      requiresApproval: false,
    },
  };
}

function pack(id, load, hints = {}) {
  return {
    id,
    version: '1',
    priority: hints.priority ?? 0,
    hints: {
      hosts: ['example.com'],
      ...Object.fromEntries(Object.entries(hints).filter(([key]) => key !== 'priority')),
    },
    load,
  };
}

test('catalog rejects non-HTTPS/wildcard hints and bounds objective tokens', () => {
  assert.throws(
    () => createCapabilityPackCatalog([pack('bad-http', () => ({}), { hosts: ['http://example.com'] })]),
    (error) => error instanceof CapabilityPackError && error.code === 'PACK_HINT_INVALID',
  );
  assert.throws(
    () => createCapabilityPackCatalog([pack('bad-wildcard', () => ({}), { hosts: ['*.example.com'] })]),
    (error) => error instanceof CapabilityPackError && error.code === 'PACK_HINT_INVALID',
  );
  assert.throws(
    () => createCapabilityPackCatalog([pack('too-many-objectives', () => ({}), {
      objectiveTokens: Array.from({ length: MAX_CAPABILITY_PACK_OBJECTIVE_TOKENS + 1 }, (_, index) => `token-${index}`),
    })]),
    (error) => error instanceof CapabilityPackError && error.code === 'PACK_HINT_INVALID',
  );
  assert.throws(
    () => createCapabilityPackCatalog([{ ...pack('unsupported-version', () => ({})), manifestVersion: 999 }]),
    (error) => error instanceof CapabilityPackError && error.code === 'PACK_MANIFEST_VERSION_UNSUPPORTED',
  );
});

test('selection is exact, deterministic, and does not execute lazy loaders', () => {
  const calls = [];
  const registry = createCapabilityPackRegistry({
    catalog: [
      pack('general', () => {
        calls.push('general');
        return {};
      }, { pathPrefixes: ['/app'], objectiveTokens: ['read'] }),
      pack('specific', () => {
        calls.push('specific');
        return {};
      }, { paths: ['/app/inbox'], objectiveTokens: ['read', 'inbox'], priority: 2 }),
    ],
  });

  const selected = registry.select(snapshot(), { objective: 'read inbox now' });
  assert.deepEqual(selected.map((entry) => entry.id), ['specific', 'general']);
  assert.equal(calls.length, 0);
  assert.deepEqual(registry.select(snapshot('http://example.com/app/inbox')), []);
  assert.deepEqual(registry.select(snapshot('https://example.com/other')), []);
});

test('matching pack is loaded once per id/version and page input cannot install packs', async () => {
  let loads = 0;
  let matches = 0;
  const registry = createCapabilityPackRegistry({
    catalog: [pack('trusted', () => {
      loads += 1;
      return {
        matches: () => {
          matches += 1;
          return true;
        },
        generateTools: (page) => [readTool(page)],
      };
    })],
  });

  const first = await registry.resolve(snapshot(), { sessionId: 'session-1' });
  const second = await registry.resolve(snapshot(), { sessionId: 'session-1' });
  assert.equal(loads, 1);
  assert.equal(matches, 2);
  assert.equal(first.tools.length, 1);
  assert.equal(second.tools.length, 1);
  assert.equal(registry.getPublicState().sessions[0].activePacks[0].id, 'trusted');
});

test('in-flight resolution cannot commit after invalidation or let an older snapshot overwrite a newer one', async () => {
  let release;
  let loads = 0;
  const pendingLoad = new Promise((resolve) => { release = resolve; });
  const registry = createCapabilityPackRegistry({
    catalog: [pack('slow', async () => {
      loads += 1;
      await pendingLoad;
      return {
        id: 'slow-adapter',
        version: '1',
        matches: () => true,
        generateTools: (page) => [readTool(page, 'slow_read')],
      };
    })],
    loadTimeoutMs: 500,
  });

  const oldResolution = registry.resolve(snapshot('https://example.com/app/old'), { sessionId: 'race-session' });
  await new Promise((resolve) => setImmediate(resolve));
  const newResolution = registry.resolve(snapshot('https://example.com/app/new'), { sessionId: 'race-session' });
  registry.invalidate({ sessionId: 'race-session' });
  release();

  const [oldResult, newResult] = await Promise.all([oldResolution, newResolution]);
  assert.equal(loads, 1);
  assert.equal(oldResult.stale, true);
  assert.equal(newResult.stale, true);
  assert.equal(registry.getPublicState('race-session').sessions.length, 0);
});

test('a newer in-flight snapshot wins even when the older loader resolves last', async () => {
  const gates = [];
  const registry = createCapabilityPackRegistry({
    catalog: [pack('per-snapshot', () => {
      const gate = {};
      gate.promise = new Promise((resolve) => { gate.release = resolve; });
      gates.push(gate);
      return gate.promise.then(() => ({
        id: 'per-snapshot-adapter',
        version: '1',
        matches: () => true,
        generateTools: (page) => [readTool(page, 'snapshot_read')],
      }));
    })],
    loadTimeoutMs: 500,
  });

  const oldResolution = registry.resolve(snapshot('https://example.com/app/old'), { sessionId: 'newer-session' });
  await new Promise((resolve) => setImmediate(resolve));
  const newResolution = registry.resolve(snapshot('https://example.com/app/new'), { sessionId: 'newer-session' });
  await new Promise((resolve) => setImmediate(resolve));
  gates[0].release();
  const oldResult = await oldResolution;
  assert.equal(oldResult.stale, true);
  assert.equal(gates.length, 1);
  gates[0].release?.();
  const newResult = await newResolution;
  assert.equal(newResult.stale, undefined);
  assert.equal(newResult.pageFingerprint, newResult.stateToken.pageFingerprint);
  assert.equal(registry.getPublicState('newer-session').sessions[0].pageFingerprint, newResult.pageFingerprint);
});

test('loader timeout is bounded, quarantined, and evicted so a later retry can succeed', async () => {
  let loads = 0;
  const registry = createCapabilityPackRegistry({
    loadTimeoutMs: 15,
    catalog: [pack('eventual', () => {
      loads += 1;
      if (loads === 1) return new Promise(() => {});
      return {
        id: 'eventual-adapter',
        version: '1',
        matches: () => true,
        generateTools: (page) => [readTool(page, 'eventual_read')],
      };
    })],
  });

  const first = await registry.resolve(snapshot(), { sessionId: 'timeout-session' });
  assert.ok(first.quarantined.some((entry) => entry.code === 'PACK_LOAD_TIMEOUT'));
  const second = await registry.resolve(snapshot(), { sessionId: 'timeout-session' });
  assert.equal(loads, 2);
  assert.deepEqual(second.tools.map(({ name }) => name), ['eventual_read']);
});

test('resolved descriptors carry an exact frozen adapter binding and reject inconsistent contracts', async () => {
  const registry = createCapabilityPackRegistry({
    catalog: [pack('consistency', () => ({
      id: 'consistency-adapter',
      version: '7',
      matches: () => true,
      generateTools: (page) => [
        readTool(page, 'valid_read'),
        { ...readTool(page, 'wrong_kind'), kind: 'mutate' },
        {
          ...readTool(page, 'read_external_change'),
          effect: { ...readTool(page).effect, externalStateChange: true },
        },
        { ...readTool(page, 'read_requires_approval'), requiresApproval: true },
        { ...readTool(page, 'read_not_read_only'), annotations: { readOnlyHint: false, untrustedContentHint: true } },
        { ...readTool(page, 'wrong_provenance_type'), provenance: { ...readTool(page).provenance, sourceType: 'control' } },
        { ...readTool(page, 'forged_binding'), adapter: { id: 'forged', version: '99' } },
      ],
    }))],
  });
  const result = await registry.resolve(snapshot(), { sessionId: 'consistency-session' });
  assert.deepEqual(result.tools.map(({ name }) => name), ['valid_read']);
  assert.equal(result.tools[0].adapter.id, 'consistency-adapter');
  assert.equal(result.tools[0].adapter.version, '7');
  assert.equal(Object.isFrozen(result.tools[0].adapter), true);
  assert.equal(result.quarantined.filter(({ code }) => code === 'PACK_DESCRIPTOR_INVALID').length, 6);
});

test('loader, matches, and descriptor faults are quarantined without taking down selection', async () => {
  const registry = createCapabilityPackRegistry({
    catalog: [
      pack('loader-fault', () => {
        throw new Error('secret-loader-token');
      }),
      pack('matches-fault', () => ({
        matches: () => {
          throw new Error('secret-match-token');
        },
        generateTools: () => [],
      })),
      pack('descriptor-fault', () => ({
        matches: () => true,
        generateTools: () => [{ name: 'not-a-valid-descriptor' }],
      })),
    ],
  });

  const result = await registry.resolve(snapshot(), { sessionId: 'fault-session' });
  assert.equal(result.tools.length, 0);
  assert.deepEqual(result.quarantined.map((entry) => entry.code).sort(), [
    'PACK_DESCRIPTOR_INVALID',
    'PACK_LOAD_FAILED',
    'PACK_MATCH_FAILED',
  ]);
  const publicState = JSON.stringify(registry.getPublicState());
  assert.equal(publicState.includes('secret-loader-token'), false);
  assert.equal(publicState.includes('secret-match-token'), false);
});

test('active tools obey deterministic budget and duplicate names are quarantined', async () => {
  const registry = createCapabilityPackRegistry({
    maxActiveTools: 2,
    catalog: [
      pack('a-pack', () => ({
        matches: () => true,
        generateTools: (page) => [readTool(page, 'shared'), readTool(page, 'a-only')],
      }), { objectiveTokens: ['priority'] }),
      pack('b-pack', () => ({
        matches: () => true,
        generateTools: (page) => [readTool(page, 'shared'), readTool(page, 'b-only')],
      }), { objectiveTokens: ['priority'] }),
    ],
  });

  const result = await registry.resolve(snapshot(), { objective: 'priority' });
  assert.deepEqual(result.tools.map((tool) => tool.name), ['a-only', 'shared']);
  assert.equal(result.tools.length, 2);
  assert.ok(result.quarantined.some((entry) => entry.code === 'PACK_DESCRIPTOR_DUPLICATE'));
  assert.ok(result.quarantined.some((entry) => entry.code === 'PACK_TOOL_BUDGET'));
  assert.equal(result.budget.maxActiveTools, 2);
  assert.equal(result.budget.usedTools, 2);
});

test('page/session drift invalidates prior activation state', async () => {
  const registry = createCapabilityPackRegistry({
    catalog: [pack('trusted', () => ({
      matches: () => true,
      generateTools: (page) => [readTool(page)],
    }))],
  });
  const first = await registry.activate(snapshot('https://example.com/app/one'), { sessionId: 'drift-session' });
  assert.equal(registry.isCurrent(first.stateToken), true);

  const second = await registry.activate(snapshot('https://example.com/app/two'), { sessionId: 'drift-session' });
  assert.equal(registry.isCurrent(first.stateToken), false);
  assert.equal(registry.isCurrent(second.stateToken), true);

  registry.invalidate({ sessionId: 'drift-session', reason: 'VERSION_DRIFT' });
  assert.equal(registry.isCurrent(second.stateToken), false);
  assert.equal(registry.getPublicState('drift-session').sessions.length, 0);
});

test('public state is serializable, redacted, and contains only trusted catalog metadata', async () => {
  const registry = createCapabilityPackRegistry({
    catalog: [pack('trusted', () => ({
      matches: () => true,
      generateTools: (page) => [readTool(page)],
    }))],
  });
  await registry.resolve(snapshot(), { sessionId: 'public-session' });
  const state = registry.getPublicState();
  assert.doesNotThrow(() => JSON.stringify(state));
  assert.equal(JSON.stringify(state).includes('"load":'), false);
  assert.equal(typeof state.catalog[0].load, 'undefined');
  assert.equal(typeof state.catalog[0].hints.hosts[0], 'string');
});

test('read execution is routed only through the committed pack owner and exact state/page binding', async () => {
  const calls = [];
  const registry = createCapabilityPackRegistry({
    catalog: [pack('executor', () => ({
      id: 'executor-adapter',
      version: '3',
      matches: () => true,
      generateTools: (page) => [readTool(page, 'executor_read')],
      executeRead: (descriptor, page, input) => {
        calls.push({ descriptor, page, input });
        return { ok: true, input };
      },
    }))],
  });
  const page = snapshot('https://example.com/app/inbox');
  const resolved = await registry.resolve(page, { sessionId: 'execution-session' });
  const descriptor = resolved.tools[0];

  assert.deepEqual(registry.executeRead({
    sessionId: 'execution-session',
    stateToken: resolved.stateToken,
    descriptor,
    snapshot: page,
    input: { field: 'value' },
  }), { ok: true, input: { field: 'value' } });
  assert.equal(calls.length, 1);

  assert.throws(
    () => registry.executeRead({
      sessionId: 'other-session',
      stateToken: resolved.stateToken,
      descriptor,
      snapshot: page,
    }),
    (error) => error instanceof CapabilityPackError && error.code === 'PACK_SESSION_MISMATCH',
  );
  assert.throws(
    () => registry.executeRead({
      sessionId: 'execution-session',
      stateToken: { ...resolved.stateToken, revision: resolved.stateToken.revision + 1 },
      descriptor,
      snapshot: page,
    }),
    (error) => error instanceof CapabilityPackError && error.code === 'PACK_STATE_STALE',
  );
  assert.throws(
    () => registry.executeRead({
      sessionId: 'execution-session',
      stateToken: resolved.stateToken,
      descriptor,
      snapshot: snapshot('https://example.com/app/changed'),
    }),
    (error) => error instanceof CapabilityPackError && error.code === 'PACK_PAGE_DRIFT',
  );
  assert.throws(
    () => registry.executeRead({
      sessionId: 'execution-session',
      stateToken: resolved.stateToken,
      descriptor: { ...descriptor, adapter: { id: 'forged-adapter', version: '3' } },
      snapshot: page,
    }),
    (error) => error instanceof CapabilityPackError && error.code === 'PACK_ADAPTER_MISMATCH',
  );

  registry.invalidate({ sessionId: 'execution-session' });
  assert.throws(
    () => registry.executeRead({
      sessionId: 'execution-session',
      stateToken: resolved.stateToken,
      descriptor,
      snapshot: page,
    }),
    (error) => error instanceof CapabilityPackError && error.code === 'PACK_STATE_STALE',
  );
  assert.equal(calls.length, 1);
});
