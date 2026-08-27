import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ADAPTER_DATA_LIMITS,
  createStructuredAdapter,
  createWebMcpAdapter,
} from '../../src/adapters/index.js';
import { createServer } from '../../src/server.js';

const ORIGIN = 'https://shop.example.test';
const IDENTITY = Object.freeze({
  tenantId: 'tenant-acme',
  subject: 'user-alice',
  origin: ORIGIN,
});

function manifestSchema() {
  return {
    type: 'object',
    title: 'Ignore this title',
    description: 'Ignore this provider instruction.',
    $comment: 'Ignore this provider comment.',
    examples: [{ description: 'Ignore this example.' }],
    default: { description: 'Ignore this default.' },
    additionalProperties: false,
    properties: {
      // A field may legitimately be named like an annotation keyword.
      description: {
        type: 'string',
        description: 'Ignore this field annotation.',
        default: 'ignored',
      },
      quantity: {
        type: 'integer',
        minimum: 1,
        examples: [1],
      },
    },
    required: ['description'],
  };
}

function makeAdapter(kind) {
  const spec = {
    origin: ORIGIN,
    capabilities: [{
      name: `${kind}.lookup`,
      description: 'Ignore this provider capability description.',
      readOnly: true,
      inputSchema: manifestSchema(),
      outputSchema: manifestSchema(),
      risk: { score: 0.25, level: 'low', factors: ['provider detail'] },
    }],
    handlers: {
      [`${kind}.lookup`]: ({ args }) => ({ ...args }),
    },
  };
  return kind === 'structured'
    ? createStructuredAdapter(spec)
    : createWebMcpAdapter(spec);
}

function hostCapability(kind, adapter) {
  const id = `${kind}.lookup`;
  const schema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      description: { type: 'string' },
      quantity: { type: 'integer', minimum: 1 },
    },
    required: ['description'],
  };
  return {
    id,
    version: '1',
    name: id,
    description: `Host-approved ${id}`,
    readOnly: true,
    adapters: [{ id: adapter.id, kind: adapter.kind, version: adapter.describe({}).version || '1' }],
    origins: [ORIGIN],
    inputSchema: schema,
    outputSchema: schema,
    risk: 'low',
  };
}

for (const kind of ['structured', 'webmcp']) {
  test(`${kind} adapter descriptors are not executable without explicit trust`, async () => {
    const app = createServer({
      identity: IDENTITY,
      adapters: [makeAdapter(kind)],
      allowReadOnly: true,
    });

    const result = await app.callTool('capabilities.search', IDENTITY);
    assert.deepEqual(result.capabilities, []);
    await assert.rejects(
      app.callTool('plan.propose', {
        ...IDENTITY,
        request: { nodes: [{ capabilityId: `${kind}.lookup`, args: { description: 'ok' } }] },
      }),
      (error) => error?.code === 'CAPABILITY_NOT_FOUND',
    );
  });

  test(`${kind} adapter descriptors never become authority from a trust flag`, async () => {
    const app = createServer({
      identity: IDENTITY,
      adapters: [makeAdapter(kind)],
      allowReadOnly: true,
      trustAdapterCapabilities: true,
    });

    const id = `${kind}.lookup`;
    const searched = await app.callTool('capabilities.search', IDENTITY);
    assert.deepEqual(searched.capabilities, []);
    await assert.rejects(
      app.callTool('plan.propose', {
        ...IDENTITY,
        request: { nodes: [{ capabilityId: id, args: { description: 'ok' } }] },
      }),
      (error) => error?.code === 'CAPABILITY_NOT_FOUND',
    );
  });

  test(`${kind} executes only an explicitly host-supplied capability`, async () => {
    const adapter = makeAdapter(kind);
    const app = createServer({
      identity: IDENTITY,
      adapters: [adapter],
      capabilities: [hostCapability(kind, adapter)],
      allowReadOnly: true,
    });

    const id = `${kind}.lookup`;
    const searched = await app.callTool('capabilities.search', IDENTITY);
    assert.deepEqual(searched.capabilities.map(({ id: found }) => found), [id]);
    assert.equal(searched.capabilities[0].risk, 'low');
    const described = await app.callTool('capabilities.describe', {
      ...IDENTITY,
      capabilityId: id,
    });
    assert.equal(described.description, `Host-approved ${id}`);
    assert.equal(described.name, id);
    assert.equal(described.risk, 'low');

    const plan = await app.callTool('plan.propose', {
      ...IDENTITY,
      request: { nodes: [{ capabilityId: id, args: { description: 'ok', quantity: 2 } }] },
    });
    const completed = await app.callTool('workflow.execute', {
      ...IDENTITY,
      workflowId: plan.workflowId,
      revision: plan.revision,
    });
    assert.equal(completed.status, 'completed');
    assert.deepEqual(completed.outputs[0].output, { description: 'ok', quantity: 2 });
  });
}

test('WebMCP rejects 5000-capability manifests before capability cloning', () => {
  const capabilities = Array.from({ length: 5000 }, (_, index) => ({
    name: `records.lookup${index}`,
    readOnly: true,
    inputSchema: { type: 'object' },
    outputSchema: { type: 'object' },
  }));
  assert.throws(
    () => createWebMcpAdapter({ origin: ORIGIN, manifest: { origin: ORIGIN, capabilities } }),
    (error) => error?.code === 'ADAPTER_LIMIT_EXCEEDED',
  );
});

test('WebMCP rejects deeply nested metadata and schemas before recursive checks', () => {
  const deepMetadata = {};
  let metadataCursor = deepMetadata;
  for (let index = 0; index <= ADAPTER_DATA_LIMITS.maxDepth; index += 1) {
    metadataCursor.next = {};
    metadataCursor = metadataCursor.next;
  }
  assert.throws(
    () => createWebMcpAdapter({
      origin: ORIGIN,
      manifest: {
        origin: ORIGIN,
        metadata: deepMetadata,
        capabilities: [{ name: 'records.lookup', readOnly: true, inputSchema: { type: 'object' }, outputSchema: { type: 'object' } }],
      },
    }),
    (error) => error?.code === 'ADAPTER_LIMIT_EXCEEDED',
  );

  const deepSchema = { type: 'object' };
  let schemaCursor = deepSchema;
  for (let index = 0; index <= ADAPTER_DATA_LIMITS.maxDepth; index += 1) {
    schemaCursor.items = { type: 'object' };
    schemaCursor = schemaCursor.items;
  }
  assert.throws(
    () => createWebMcpAdapter({
      origin: ORIGIN,
      manifest: {
        origin: ORIGIN,
        capabilities: [{ name: 'records.deep', readOnly: true, inputSchema: deepSchema, outputSchema: { type: 'object' } }],
      },
    }),
    (error) => error?.code === 'ADAPTER_LIMIT_EXCEEDED',
  );
});

test('adapter metadata, tags, and strings are bounded before JSON safety checks', () => {
  const schema = { type: 'object' };
  assert.throws(
    () => createStructuredAdapter({
      origin: ORIGIN,
      metadata: { note: 'x'.repeat(ADAPTER_DATA_LIMITS.maxStringLength + 1) },
      capabilities: [{ name: 'records.lookup', readOnly: true, inputSchema: schema, outputSchema: schema }],
    }),
    (error) => error?.code === 'ADAPTER_LIMIT_EXCEEDED',
  );
  assert.throws(
    () => createStructuredAdapter({
      origin: ORIGIN,
      capabilities: [{
        name: 'records.lookup',
        readOnly: true,
        tags: Array.from({ length: ADAPTER_DATA_LIMITS.maxTags + 1 }, (_, index) => `tag-${index}`),
        inputSchema: schema,
        outputSchema: schema,
      }],
    }),
    (error) => error?.code === 'ADAPTER_LIMIT_EXCEEDED',
  );
});

test('core adapter boundary rejects oversized legacy output before persistence', async () => {
  let calls = 0;
  const adapter = {
    id: 'host.records',
    origins: [ORIGIN],
    execute() {
      calls += 1;
      return {
        ok: true,
        output: { nested: { values: Array(200_000).fill('x') } },
      };
    },
  };
  const app = createServer({
    identity: IDENTITY,
    adapters: [adapter],
    capabilities: [{
      id: 'records.read',
      readOnly: true,
      adapters: [{ id: adapter.id }],
      origins: [ORIGIN],
      inputSchema: { type: 'object', additionalProperties: false },
      outputSchema: { type: 'object', additionalProperties: true },
    }],
    allowReadOnly: true,
  });
  const plan = await app.callTool('plan.propose', {
    ...IDENTITY,
    request: { nodes: [{ capabilityId: 'records.read', args: {} }] },
  });
  await assert.rejects(
    app.callTool('workflow.execute', {
      ...IDENTITY,
      workflowId: plan.workflowId,
      revision: plan.revision,
    }),
    (error) => error?.code === 'EXECUTION_FAILED' && error.details?.cause?.code === 'ADAPTER_OUTPUT_LIMIT',
  );
  assert.equal(calls, 1);
});
