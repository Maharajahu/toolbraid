import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PUBLIC_TOOL_NAMES as MCP_PUBLIC_TOOL_NAMES,
  getToolDefinitions,
  validateJsonSchema,
} from '../../src/mcp/index.js';
import {
  PUBLIC_TOOL_DEFINITIONS as RUNTIME_PUBLIC_TOOL_DEFINITIONS,
  PUBLIC_TOOL_NAMES as RUNTIME_PUBLIC_TOOL_NAMES,
  createCompositionRoot,
  createFixtureRuntime,
} from '../../src/runtime/composition-root.js';
import { createServer } from '../../src/server.js';

const EXPECTED_TOOL_NAMES = [
  'capabilities.search',
  'capabilities.describe',
  'plan.propose',
  'workflow.execute',
  'workflow.status',
  'workflow.replay_readonly',
];

const IDENTITY_FORMS = [
  { tenantId: 'tenant-a', subject: 'subject-a' },
  { tenantId: 'tenant-a', subjectId: 'subject-a' },
  { tenantId: 'tenant-a', userId: 'subject-a' },
  { identity: { tenantId: 'tenant-a', subjectId: 'subject-a' } },
];

const EXAMPLES = {
  'capabilities.search': { query: 'cart' },
  'capabilities.describe': { capabilityId: 'cart.read' },
  'plan.propose': { request: { action: 'read' } },
  'workflow.execute': { workflowId: 'workflow-1' },
  'workflow.status': { workflowId: 'workflow-1' },
  'workflow.replay_readonly': { workflowId: 'workflow-1' },
};

const FORBIDDEN_PUBLIC_NAMES = [
  'approval.grant',
  'shell.exec',
  'raw.shell',
  'dom.click',
  'page.click',
  'cookie.read',
  'filesystem.read',
];

const FORBIDDEN_APPROVAL_PROPERTIES = [
  'approval',
  'approvals',
  'approvalId',
  'approvalNonce',
  'approvalRecord',
  'approvalToken',
  'nonce',
];

function definitionMap(definitions) {
  return new Map(definitions.map((definition) => [definition.name, definition]));
}

function assertValid(schema, value, message) {
  const result = validateJsonSchema(value, schema);
  assert.equal(result.valid, true, `${message}: ${JSON.stringify(result.errors)}`);
}

function assertInvalid(schema, value, message) {
  const result = validateJsonSchema(value, schema);
  assert.equal(result.valid, false, `${message}: value unexpectedly matched schema`);
}

function hasRequiredClause(schema, seen = new Set()) {
  if (!schema || typeof schema !== 'object' || seen.has(schema)) return false;
  seen.add(schema);
  if (Array.isArray(schema.required)) return true;
  for (const keyword of ['allOf', 'anyOf', 'oneOf']) {
    if (Array.isArray(schema[keyword]) && schema[keyword].some((entry) => hasRequiredClause(entry, seen))) return true;
  }
  return false;
}

test('public MCP and runtime registries expose exactly the six contract names', async () => {
  assert.deepEqual([...MCP_PUBLIC_TOOL_NAMES], EXPECTED_TOOL_NAMES);
  assert.deepEqual([...RUNTIME_PUBLIC_TOOL_NAMES], EXPECTED_TOOL_NAMES);

  const mcpDefinitions = getToolDefinitions();
  assert.deepEqual(mcpDefinitions.map(({ name }) => name), EXPECTED_TOOL_NAMES);
  assert.equal(new Set(mcpDefinitions.map(({ name }) => name)).size, EXPECTED_TOOL_NAMES.length);
  assert.deepEqual(
    RUNTIME_PUBLIC_TOOL_DEFINITIONS.map(({ name }) => name),
    EXPECTED_TOOL_NAMES,
  );

  const app = createServer({ fixture: true });
  assert.deepEqual(app.publicToolNames, EXPECTED_TOOL_NAMES);
  assert.deepEqual(app.publicToolDefinitions.map(({ name }) => name), EXPECTED_TOOL_NAMES);
  const listed = await app.handleRequest({
    jsonrpc: '2.0',
    id: 'list',
    method: 'tools/list',
    params: {
      _meta: {
        'io.modelcontextprotocol/protocolVersion': '2026-07-28',
        'io.modelcontextprotocol/clientCapabilities': {},
      },
    },
  });
  assert.deepEqual(listed.result.tools.map(({ name }) => name), EXPECTED_TOOL_NAMES);
});

test('every public schema requires explicit tenant and subject identity', () => {
  const definitions = definitionMap(getToolDefinitions());
  for (const name of EXPECTED_TOOL_NAMES) {
    const schema = definitions.get(name)?.inputSchema;
    assert.equal(schema?.type, 'object', `${name} must accept one object`);

    const example = EXAMPLES[name];
    assertInvalid(schema, example, `${name} must reject an identity-free request`);
    assertInvalid(schema, { ...example, tenantId: 'tenant-a' }, `${name} must reject a missing subject`);
    assertInvalid(schema, { ...example, subjectId: 'subject-a' }, `${name} must reject a missing tenant`);
    assertInvalid(schema, { ...example, tenantId: '', subjectId: 'subject-a' }, `${name} must reject an empty tenant`);
    assertInvalid(schema, { ...example, tenantId: 'tenant-a', subjectId: '' }, `${name} must reject an empty subject`);

    for (const identity of IDENTITY_FORMS) {
      assertValid(schema, { ...example, ...identity }, `${name} must accept explicit identity ${JSON.stringify(identity)}`);
    }
  }
});

test('public schemas are strict at the top level and cannot advertise approval credentials', () => {
  const definitions = definitionMap(getToolDefinitions());
  for (const name of EXPECTED_TOOL_NAMES) {
    const schema = definitions.get(name)?.inputSchema;
    assert.equal(schema?.additionalProperties, false, `${name} must declare a closed input contract`);
    for (const property of FORBIDDEN_APPROVAL_PROPERTIES) {
      assert.equal(
        Object.prototype.hasOwnProperty.call(schema?.properties ?? {}, property),
        false,
        `${name} must not advertise ${property}`,
      );
    }

    const value = {
      ...EXAMPLES[name],
      tenantId: 'tenant-a',
      subjectId: 'subject-a',
      unexpected: true,
    };
    assertInvalid(schema, value, `${name} must reject undeclared fields`);
  }
});

test('MCP schemas and runtime metadata do not drift on identity or top-level closure', () => {
  const mcp = definitionMap(getToolDefinitions());
  const runtime = definitionMap(RUNTIME_PUBLIC_TOOL_DEFINITIONS);
  for (const name of EXPECTED_TOOL_NAMES) {
    const mcpSchema = mcp.get(name)?.inputSchema;
    const runtimeSchema = runtime.get(name)?.inputSchema;
    assert.deepEqual(
      runtimeSchema?.required,
      mcpSchema?.required,
      `${name} required identity contract differs between MCP and runtime metadata`,
    );
    assert.equal(
      runtimeSchema?.additionalProperties,
      mcpSchema?.additionalProperties,
      `${name} additionalProperties differs between MCP and runtime metadata`,
    );
  }
});

test('schema-declared fields are accepted by the corresponding runtime handler', async () => {
  const runtime = createFixtureRuntime();
  const identity = { tenantId: 'tenant-acme', subjectId: 'user-alice' };

  const searchInput = {
    ...identity,
    query: 'cart',
    limit: 10,
    kind: 'read',
    adapter: 'structured',
    cursor: '0',
  };
  assertValid(
    definitionMap(getToolDefinitions()).get('capabilities.search').inputSchema,
    searchInput,
    'capabilities.search schema input',
  );
  const search = await runtime.callTool('capabilities.search', searchInput);
  assert.equal(search.tenantId, identity.tenantId);
  assert.equal(search.subjectId, identity.subjectId);

  const describeInput = {
    ...identity,
    capabilityId: 'cart.read',
  };
  assertValid(
    definitionMap(getToolDefinitions()).get('capabilities.describe').inputSchema,
    describeInput,
    'capabilities.describe schema input',
  );
  const described = await runtime.callTool('capabilities.describe', describeInput);
  assert.equal(described.id, 'cart.read');

  const planInput = {
    ...identity,
    request: { action: 'read' },
    goal: 'Read the cart',
    action: 'read',
    revision: 1,
  };
  assertValid(
    definitionMap(getToolDefinitions()).get('plan.propose').inputSchema,
    planInput,
    'plan.propose schema input',
  );
  const plan = await runtime.callTool('plan.propose', planInput);
  assert.equal(plan.status, 'proposed');

  const executeInput = {
    ...identity,
    workflowId: plan.workflowId,
    revision: plan.revision,
  };
  assertValid(
    definitionMap(getToolDefinitions()).get('workflow.execute').inputSchema,
    executeInput,
    'workflow.execute schema input',
  );
  const executed = await runtime.callTool('workflow.execute', executeInput);
  assert.equal(executed.status, 'completed');

  const statusInput = {
    ...identity,
    workflowId: plan.workflowId,
    revision: plan.revision,
  };
  assertValid(
    definitionMap(getToolDefinitions()).get('workflow.status').inputSchema,
    statusInput,
    'workflow.status schema input',
  );
  const status = await runtime.callTool('workflow.status', statusInput);
  assert.equal(status.workflowId, plan.workflowId);

  const replayInput = {
    ...identity,
    workflowId: plan.workflowId,
    revision: plan.revision,
  };
  assertValid(
    definitionMap(getToolDefinitions()).get('workflow.replay_readonly').inputSchema,
    replayInput,
    'workflow.replay_readonly schema input',
  );
  const replay = await runtime.callTool('workflow.replay_readonly', replayInput);
  assert.equal(replay.readOnly, true);
});

test('public schemas reject cursor, whitespace, and identifier values rejected by runtime', async () => {
  const definitions = definitionMap(getToolDefinitions());
  const identity = { tenantId: 'tenant-a', subjectId: 'subject-a' };
  const search = definitions.get('capabilities.search').inputSchema;
  assertInvalid(search, { ...identity, kind: ' read' }, 'search kind leading whitespace');
  assertInvalid(search, { ...identity, adapter: 'structured ' }, 'search adapter trailing whitespace');
  assertInvalid(search, { ...identity, tags: [' tag'] }, 'search tag leading whitespace');
  assertInvalid(search, { ...identity, cursor: 'abc' }, 'search cursor non-numeric');
  assertInvalid(search, { ...identity, cursor: '1234567890123456' }, 'search cursor beyond safe schema bound');

  const describe = definitions.get('capabilities.describe').inputSchema;
  assertInvalid(describe, { ...identity, capabilityId: 'cart read' }, 'describe capability ID whitespace');
  assertInvalid(describe, { ...identity, capabilityId: 'cart.read', version: '1 beta' }, 'describe version whitespace');

  const propose = definitions.get('plan.propose').inputSchema;
  assertInvalid(propose, { ...identity, workflowId: 'workflow id' }, 'propose workflow ID whitespace');
  assertInvalid(propose, { ...identity, goal: ' Read the cart' }, 'propose goal leading whitespace');

  const replay = definitions.get('workflow.replay_readonly').inputSchema;
  assertInvalid(replay, { ...identity, workflowId: 'workflow-1', nodeIds: ['node id'] }, 'replay node ID whitespace');

  const runtime = createFixtureRuntime();
  await assert.rejects(
    runtime.callTool('capabilities.search', { ...identity, kind: ' read' }),
    (error) => error?.code === 'INVALID_ARGUMENT',
  );
  await assert.rejects(
    runtime.callTool('capabilities.search', { ...identity, cursor: '1234567890123456' }),
    (error) => error?.code === 'INVALID_ARGUMENT',
  );
  await assert.rejects(
    runtime.callTool('workflow.status', { ...identity, workflowId: 'workflow id' }),
    (error) => error?.code === 'INVALID_ARGUMENT',
  );
});

test('fallback capability search honors kind, adapter, tags, readOnly, limit, and cursor', async () => {
  const identity = { tenantId: 'tenant-a', subjectId: 'subject-a' };
  const runtime = createCompositionRoot({
    identity,
    capabilities: [
      { id: 'read.alpha', version: '1', readOnly: true, adapter: 'adapter-a', tags: ['mail', 'read'] },
      { id: 'read.beta', version: '1', readOnly: true, adapter: 'adapter-b', tags: ['mail'] },
      { id: 'write.gamma', version: '1', readOnly: false, adapter: 'adapter-a', tags: ['mail', 'write'] },
    ],
  });

  const filtered = await runtime.callTool('capabilities.search', {
    ...identity,
    kind: 'read',
    adapter: 'adapter-a',
    tags: ['mail'],
    readOnly: true,
    limit: 1,
  });
  assert.deepEqual(filtered.capabilities.map(({ id }) => id), ['read.alpha']);
  assert.equal(filtered.nextCursor, null);

  const firstPage = await runtime.callTool('capabilities.search', {
    ...identity,
    tags: ['mail'],
    limit: 1,
  });
  assert.deepEqual(firstPage.capabilities.map(({ id }) => id), ['read.alpha']);
  assert.equal(firstPage.total, 3);
  assert.equal(firstPage.nextCursor, '1');

  const secondPage = await runtime.callTool('capabilities.search', {
    ...identity,
    tags: ['mail'],
    limit: 1,
    cursor: firstPage.nextCursor,
  });
  assert.deepEqual(secondPage.capabilities.map(({ id }) => id), ['read.beta']);
  assert.equal(secondPage.nextCursor, '2');

  const mutation = await runtime.callTool('capabilities.search', {
    ...identity,
    kind: 'mutation',
    readOnly: false,
  });
  assert.deepEqual(mutation.capabilities.map(({ id }) => id), ['write.gamma']);
});

test('capabilities.describe honors versioned fallback records and the core catalog object contract', async () => {
  const identity = { tenantId: 'tenant-a', subjectId: 'subject-a' };
  const runtime = createCompositionRoot({
    identity,
    capabilities: [
      { id: 'safe.lookup', version: '1', readOnly: true, description: 'v1' },
      { id: 'safe.lookup', version: '2', readOnly: true, description: 'v2' },
    ],
  });
  const v1 = await runtime.callTool('capabilities.describe', {
    ...identity,
    capabilityId: 'safe.lookup',
    version: '1',
  });
  const v2 = await runtime.callTool('capabilities.describe', {
    ...identity,
    capabilityId: 'safe.lookup',
    version: '2',
  });
  assert.equal(v1.version, '1');
  assert.equal(v1.description, 'v1');
  assert.equal(v2.version, '2');
  assert.equal(v2.description, 'v2');
  await assert.rejects(
    runtime.callTool('capabilities.describe', {
      ...identity,
      capabilityId: 'safe.lookup',
      version: 'missing',
    }),
    (error) => error?.code === 'CAPABILITY_NOT_FOUND',
  );

  const coreRuntime = createCompositionRoot({
    withCore: true,
    identity,
    capabilities: [{ id: 'safe.lookup', version: '1', readOnly: true, description: 'core' }],
  });
  const coreDescription = await coreRuntime.callTool('capabilities.describe', {
    ...identity,
    capabilityId: 'safe.lookup',
    version: '1',
  });
  assert.equal(coreDescription.description, 'core');
  assert.equal(coreDescription.version, '1');
});

test('fallback plans preserve top-level goal, workflowId, and revision semantics', async () => {
  const identity = { tenantId: 'tenant-acme', subjectId: 'user-alice' };
  const runtime = createFixtureRuntime();
  const plan = await runtime.callTool('plan.propose', {
    ...identity,
    request: { action: 'read' },
    goal: 'Read the cart for review',
    workflowId: 'contract-plan-42',
    revision: 3,
  });
  assert.equal(plan.workflowId, 'contract-plan-42');
  assert.equal(plan.revision, 3);
  assert.equal(plan.goal, 'Read the cart for review');
  assert.equal(plan.request.goal, 'Read the cart for review');

  const status = await runtime.callTool('workflow.status', {
    ...identity,
    workflowId: plan.workflowId,
    revision: plan.revision,
  });
  assert.equal(status.workflowId, plan.workflowId);
  assert.equal(status.revision, plan.revision);
});

test('unsafe capability IDs are rejected and unsafe or secret descriptor metadata is redacted', async () => {
  const identity = { tenantId: 'tenant-a', subjectId: 'subject-a' };
  const unsafeIds = [
    'approval.grant',
    'approval.issue',
    'approval.inject',
    'dom.evaluate',
    'page.evaluate',
    'browser.evaluate',
    'shell.exec',
    'raw.click',
    'cookie.read',
    'filesystem.read',
    'command.run',
    'process.spawn',
  ];
  for (const id of unsafeIds) {
    assert.throws(
      () => createCompositionRoot({ identity, capabilities: [{ id, readOnly: true }] }),
      (error) => error?.code === 'CAPABILITY_NOT_ALLOWED',
      `${id} must not be accepted as a semantic capability`,
    );
  }

  const runtime = createCompositionRoot({
    identity,
    capabilities: [{
      id: 'safe.read',
      readOnly: true,
      command: 'must-not-leak',
      shell: 'must-not-leak',
      metadata: {
        apiToken: 'secret-token',
        nested: {
          password: 'secret-password',
          shell: 'must-not-leak',
          shell_command: 'punctuation-bypass',
          'java-script': 'punctuation-bypass',
          raw_action: 'punctuation-bypass',
        },
      },
      providerMetadata: { cookie: 'secret-cookie' },
    }],
  });
  const described = await runtime.callTool('capabilities.describe', { ...identity, capabilityId: 'safe.read' });
  const searched = await runtime.callTool('capabilities.search', identity);
  for (const value of [described, searched]) {
    const encoded = JSON.stringify(value);
    assert.equal(encoded.includes('must-not-leak'), false);
    assert.equal(encoded.includes('secret-token'), false);
    assert.equal(encoded.includes('secret-password'), false);
    assert.equal(encoded.includes('secret-cookie'), false);
    assert.equal(encoded.includes('punctuation-bypass'), false);
  }
  assert.equal(described.command, undefined);
  assert.equal(described.shell, undefined);
  assert.equal(described.metadata.apiToken, '[REDACTED]');
  assert.equal(described.metadata.nested.password, '[REDACTED]');
  assert.equal(described.metadata.nested.shell, undefined);
  assert.equal(described.providerMetadata.cookie, undefined);
});

test('configured runtime identity is never a substitute for caller identity', async () => {
  const runtime = createFixtureRuntime();
  const requests = [
    ['capabilities.search', {}],
    ['capabilities.describe', { capabilityId: 'cart.read' }],
    ['plan.propose', { request: { action: 'read' } }],
  ];
  for (const [name, args] of requests) {
    await assert.rejects(
      runtime.callTool(name, args),
      (error) => error?.code === 'IDENTITY_REQUIRED',
      `${name} must reject an omitted caller identity`,
    );
  }
});

test('no public name or dispatch path exposes approval grant or raw interaction primitives', async () => {
  const runtime = createCompositionRoot({
    identity: { tenantId: 'tenant-a', subject: 'subject-a' },
    capabilities: [{ id: 'safe.read', readOnly: true }],
  });
  const gateway = createServer({ root: runtime });

  for (const forbidden of FORBIDDEN_PUBLIC_NAMES) {
    assert.equal(MCP_PUBLIC_TOOL_NAMES.includes(forbidden), false, `${forbidden} is publicly named`);
    assert.equal(RUNTIME_PUBLIC_TOOL_NAMES.includes(forbidden), false, `${forbidden} is runtime-public`);
    await assert.rejects(
      runtime.callTool(forbidden, {}),
      (error) => error?.code === 'TOOL_NOT_FOUND',
      `${forbidden} must not dispatch through runtime.callTool`,
    );
    const response = await gateway.handleRequest({
      jsonrpc: '2.0',
      id: forbidden,
      method: 'tools/call',
      params: {
        _meta: {
          'io.modelcontextprotocol/protocolVersion': '2026-07-28',
          'io.modelcontextprotocol/clientCapabilities': {},
        },
        name: forbidden,
        arguments: { tenantId: 'tenant-a', subjectId: 'subject-a' },
      },
    });
    assert.equal(response.error?.code, -32602, `${forbidden} must fail as an unknown MCP tool`);
  }
});

test('unsafe semantic capabilities are not discoverable as public capabilities', async () => {
  const unsafe = [
    'raw.click',
    'shell.exec',
    'cookie.read',
    'filesystem.read',
  ];
  let runtime;
  try {
    runtime = createCompositionRoot({
      identity: { tenantId: 'tenant-a', subject: 'subject-a' },
      capabilities: [
        { id: 'safe.read', readOnly: true },
        ...unsafe.map((id) => ({ id, readOnly: true })),
      ],
    });
  } catch (error) {
    assert.match(String(error?.code || error?.message), /unsafe|capability|not_allowed/i);
    return;
  }
  const result = await runtime.callTool('capabilities.search', {
    tenantId: 'tenant-a',
    subject: 'subject-a',
  });
  const ids = result.capabilities.map((entry) => entry.id);
  for (const id of unsafe) assert.equal(ids.includes(id), false, `${id} leaked from capability discovery`);
});

test('declared top-level schemas are valid dependency-free JSON Schemas', () => {
  for (const definition of getToolDefinitions()) {
    assert.equal(typeof definition.name, 'string');
    const schema = definition.inputSchema;
    assert.equal(typeof schema, 'object');
    assert.equal(schema.type, 'object');
    assert.equal(typeof schema.properties, 'object');
    const declaresRequired = hasRequiredClause(schema);
    assert.equal(declaresRequired, true, `${definition.name} must declare required fields`);
    assert.equal(typeof schema.additionalProperties, 'boolean');
    for (const [name, property] of Object.entries(schema.properties)) {
      assert.equal(typeof property, 'object', `${definition.name}.${name} must be a schema object`);
    }
  }
});
