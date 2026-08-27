import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CURRENT_PROTOCOL_VERSION,
  JSON_RPC_ERROR_CODES,
  PUBLIC_TOOL_NAMES,
  createMcpGateway,
  getToolSchema,
} from '../../src/mcp/index.js';

function meta(version = CURRENT_PROTOCOL_VERSION) {
  return {
    _meta: {
      'io.modelcontextprotocol/protocolVersion': version,
      'io.modelcontextprotocol/clientCapabilities': {},
      'io.modelcontextprotocol/clientInfo': { name: 'protocol-test', version: '1.0.0' },
    },
  };
}

function modernRequest(id, method, params = {}) {
  return {
    jsonrpc: '2.0',
    id,
    method,
    params: { ...meta(), ...params },
  };
}

test('public tool registry is exactly the six frozen tools', async () => {
  const gateway = createMcpGateway({ requireIdentity: false });
  const response = await gateway.handleMessage(modernRequest(1, 'tools/list'));
  assert.equal(response.jsonrpc, '2.0');
  assert.equal(response.id, 1);
  assert.equal(response.result.resultType, 'complete');
  assert.deepEqual(response.result.tools.map((tool) => tool.name), PUBLIC_TOOL_NAMES);

  response.result.tools[0].name = 'mutated';
  const second = await gateway.handleMessage(modernRequest(2, 'tools/list'));
  assert.equal(second.result.tools[0].name, PUBLIC_TOOL_NAMES[0]);
});

test('malformed notifications never receive a JSON-RPC response', async () => {
  const gateway = createMcpGateway({ requireIdentity: false });
  assert.equal(await gateway.handleMessage({
    jsonrpc: '2.0',
    method: 'notifications/initialized',
    params: [],
  }), null);
  assert.equal(await gateway.handleMessage({
    jsonrpc: '2.0',
    method: 'tools/call',
    params: 'not-an-object',
  }), null);
});

test('getToolSchema returns an isolated deeply frozen schema boundary', () => {
  const first = getToolSchema('capabilities.search');
  const second = getToolSchema('capabilities.search');
  assert.notEqual(first, second);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.properties), true);
  assert.equal(Object.isFrozen(first.properties.cursor), true);
  assert.throws(() => {
    first.properties.cursor.maxLength = 1;
  }, TypeError);
  assert.equal(second.properties.cursor.maxLength, 15);
});

test('modern server/discover advertises the current protocol and tools capability', async () => {
  const gateway = createMcpGateway({ requireIdentity: false });
  const response = await gateway.handleMessage(modernRequest('discover', 'server/discover'));
  assert.deepEqual(response.result.supportedVersions, [CURRENT_PROTOCOL_VERSION]);
  assert.deepEqual(response.result.capabilities, { tools: { listChanged: false } });
  assert.equal(response.result.resultType, 'complete');
  assert.equal(response.result._meta['io.modelcontextprotocol/serverInfo'].name, 'ToolBraid');
});

test('modern tools/call dispatches only a public tool and passes explicit context', async () => {
  let observed;
  const gateway = createMcpGateway({
    handlers: {
      'capabilities.search': (args, context) => {
        observed = { args, context };
        return { matches: ['calendar.read'] };
      },
    },
  });
  const response = await gateway.handleMessage(modernRequest(2, 'tools/call', {
    name: 'capabilities.search',
    arguments: { tenantId: 'tenant-a', subjectId: 'user-a', query: 'calendar' },
  }));
  assert.equal(response.result.resultType, 'complete');
  assert.equal(response.result.isError, false);
  assert.deepEqual(response.result.structuredContent, { matches: ['calendar.read'] });
  assert.equal(observed.args.tenantId, 'tenant-a');
  assert.deepEqual(observed.context.identity, { tenantId: 'tenant-a', subjectId: 'user-a' });
  assert.equal(observed.context.protocolVersion, CURRENT_PROTOCOL_VERSION);
});

test('missing explicit identity fails closed before invoking a handler', async () => {
  let called = false;
  const gateway = createMcpGateway({
    handlers: { 'capabilities.search': () => { called = true; return { ok: true }; } },
  });
  const response = await gateway.handleMessage(modernRequest(3, 'tools/call', {
    name: 'capabilities.search',
    arguments: { query: 'calendar' },
  }));
  assert.equal(called, false);
  assert.equal(response.result.isError, true);
  assert.equal(response.result.structuredContent.code, 'identity_required');
});

test('unknown tools are protocol errors and cannot be injected through handlers', async () => {
  let called = false;
  const gateway = createMcpGateway({
    handlers: { shell: () => { called = true; return { ok: true }; } },
    requireIdentity: false,
  });
  const response = await gateway.handleMessage(modernRequest(4, 'tools/call', {
    name: 'shell',
    arguments: {},
  }));
  assert.equal(response.error.code, JSON_RPC_ERROR_CODES.INVALID_PARAMS);
  assert.equal(called, false);
});

test('input schema failures are tool execution errors, not gateway crashes', async () => {
  const gateway = createMcpGateway({ requireIdentity: false });
  const response = await gateway.handleMessage(modernRequest(5, 'tools/call', {
    name: 'capabilities.search',
    arguments: { tenantId: 42, subjectId: 'user-a' },
  }));
  assert.equal(response.result.isError, true);
  assert.equal(response.result.structuredContent.code, 'invalid_tool_input');
  assert.match(response.result.content[0].text, /tenantId/);
});

test('handler failures are sanitized to actionable tool errors', async () => {
  const gateway = createMcpGateway({
    handlers: {
      'workflow.status': () => {
        const error = new Error('provider failed');
        error.stack = 'secret stack trace';
        throw error;
      },
    },
  });
  const response = await gateway.handleMessage(modernRequest(6, 'tools/call', {
    name: 'workflow.status',
    arguments: { tenantId: 'tenant-a', subjectId: 'user-a', workflowId: 'wf-1' },
  }));
  assert.equal(response.result.isError, true);
  assert.equal(response.result.structuredContent.code, 'tool_execution_error');
  assert.equal(response.result.content[0].text, 'provider failed');
  assert.doesNotMatch(JSON.stringify(response), /secret stack trace/);
});

test('modern requests require per-request metadata and supported protocol versions', async () => {
  const gateway = createMcpGateway({ requireIdentity: false });
  const missingMetadata = await gateway.handleMessage({
    jsonrpc: '2.0',
    id: 7,
    method: 'tools/list',
    params: {},
  });
  assert.equal(missingMetadata.error.code, JSON_RPC_ERROR_CODES.INVALID_PARAMS);

  const unsupported = await gateway.handleMessage(modernRequest(8, 'tools/list', {
    _meta: {
      'io.modelcontextprotocol/protocolVersion': '1900-01-01',
      'io.modelcontextprotocol/clientCapabilities': {},
    },
  }));
  assert.equal(unsupported.error.code, JSON_RPC_ERROR_CODES.UNSUPPORTED_PROTOCOL_VERSION);
  assert.deepEqual(unsupported.error.data.supported, [CURRENT_PROTOCOL_VERSION]);
});

test('legacy initialize/initialized compatibility is connection-scoped and omits current fields', async () => {
  const gateway = createMcpGateway({ requireIdentity: false });
  const session = gateway.createSession();
  const initialize = await gateway.handleMessage({
    jsonrpc: '2.0',
    id: 9,
    method: 'initialize',
    params: {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'legacy-test', version: '1.0.0' },
    },
  }, { session });
  assert.equal(initialize.result.protocolVersion, '2025-11-25');

  const beforeReady = await gateway.handleMessage({
    jsonrpc: '2.0', id: 10, method: 'tools/list', params: {},
  }, { session });
  assert.equal(beforeReady.error.code, JSON_RPC_ERROR_CODES.NOT_INITIALIZED);

  assert.equal(await gateway.handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }, { session }), null);
  const listed = await gateway.handleMessage({
    jsonrpc: '2.0', id: 11, method: 'tools/list', params: {},
  }, { session });
  assert.equal(listed.result.resultType, undefined);
  assert.equal(listed.result.tools.length, 6);
});

test('modern and legacy protocol eras cannot be mixed on one connection', async () => {
  const gateway = createMcpGateway({ requireIdentity: false });
  const session = gateway.createSession();
  const modern = await gateway.handleMessage(modernRequest(12, 'tools/list'), { session });
  assert.equal(modern.result.resultType, 'complete');
  const mixed = await gateway.handleMessage({
    jsonrpc: '2.0', id: 13, method: 'initialize',
    params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'x', version: '1' } },
  }, { session });
  assert.equal(mixed.error.code, JSON_RPC_ERROR_CODES.INVALID_REQUEST);
});

test('notifications never receive responses', async () => {
  const gateway = createMcpGateway({ requireIdentity: false });
  assert.equal(await gateway.handleMessage({
    jsonrpc: '2.0', method: 'notifications/unknown', params: {},
  }), null);
  assert.equal(await gateway.handleMessage({
    jsonrpc: '2.0', method: 'notifications/initialized', params: {},
  }), null);
});

test('invalid JSON-RPC objects produce standard errors without an id', async () => {
  const gateway = createMcpGateway({ requireIdentity: false });
  const parseError = await gateway.handleMessage('{not json');
  assert.equal(parseError.error.code, JSON_RPC_ERROR_CODES.PARSE_ERROR);
  assert.equal('id' in parseError, false);

  const nullId = await gateway.handleMessage({ jsonrpc: '2.0', id: null, method: 'ping', params: {} });
  assert.equal(nullId.error.code, JSON_RPC_ERROR_CODES.INVALID_REQUEST);

  const responseShaped = await gateway.handleMessage({ jsonrpc: '2.0', id: 1, result: {} });
  assert.equal(responseShaped.error.code, JSON_RPC_ERROR_CODES.INVALID_REQUEST);
});
