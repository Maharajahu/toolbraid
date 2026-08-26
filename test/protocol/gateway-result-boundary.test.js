import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CURRENT_PROTOCOL_VERSION,
  createMcpGateway,
  isJsonValue,
} from '../../src/mcp/index.js';

function modernRequest(id, name, args = {}) {
  return {
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: {
      _meta: {
        'io.modelcontextprotocol/protocolVersion': CURRENT_PROTOCOL_VERSION,
        'io.modelcontextprotocol/clientCapabilities': {},
      },
      name,
      arguments: args,
    },
  };
}

const IDENTITY = {
  tenantId: 'tenant-boundary',
  subjectId: 'subject-boundary',
  workflowId: 'workflow-boundary',
};

test('failed workflow results become modern MCP tool errors and redact provider data', async () => {
  const gateway = createMcpGateway({
    handlers: {
      'workflow.status': () => ({
        status: 'failed',
        error: {
          code: 'UPSTREAM_TIMEOUT',
          message: 'Provider failed; Authorization: Bearer provider-secret',
          details: {
            safe: 'kept',
            accessToken: 'token-value',
            nested: { password: 'password-value' },
            stack: 'provider stack must not cross the boundary',
          },
        },
      }),
    },
  });

  const response = await gateway.handleMessage(modernRequest(1, 'workflow.status', IDENTITY));
  const result = response.result;

  assert.equal(result.isError, true);
  assert.equal(result.resultType, 'complete');
  assert.equal(result.structuredContent.status, 'failed');
  assert.equal(result.structuredContent.error.code, 'UPSTREAM_TIMEOUT');
  assert.equal(result.structuredContent.error.details.safe, 'kept');
  assert.equal(result.structuredContent.error.details.accessToken, '[REDACTED]');
  assert.equal(result.structuredContent.error.details.nested.password, '[REDACTED]');
  assert.equal('stack' in result.structuredContent.error.details, false);
  assert.doesNotMatch(JSON.stringify(response), /provider-secret|token-value|password-value|provider stack/);
  assert.equal(isJsonValue(response), true);
  assert.doesNotThrow(() => JSON.stringify(response));
});

test('a top-level error marks complete MCP results as errors without leaking stacks', async () => {
  const gateway = createMcpGateway({
    handlers: {
      'workflow.status': () => ({
        content: [{ type: 'text', text: 'provider returned an error' }],
        structuredContent: { state: 'running' },
        isError: false,
        error: {
          code: 'PROVIDER_REJECTED',
          message: 'secret=provider-secret',
          details: { stackTrace: 'do-not-return', cookie: 'cookie-value' },
        },
      }),
    },
  });

  const response = await gateway.handleMessage(modernRequest(2, 'workflow.status', IDENTITY));
  assert.equal(response.result.isError, true);
  assert.equal(response.result.error.code, 'PROVIDER_REJECTED');
  assert.equal(response.result.error.message, 'secret=[REDACTED]');
  assert.equal('stackTrace' in response.result.error.details, false);
  assert.equal(response.result.error.details.cookie, '[REDACTED]');
  assert.equal(response.result.structuredContent.state, 'running');
  assert.equal(isJsonValue(response), true);
});

test('legacy failed results retain the stable error code but omit modern-only fields', async () => {
  const gateway = createMcpGateway({
    handlers: {
      'workflow.status': () => ({
        status: 'failed',
        error: {
          code: 'ADAPTER_UNAVAILABLE',
          message: 'adapter failed',
          details: { refreshToken: 'refresh-secret', safe: true },
        },
      }),
    },
  });
  const session = gateway.createSession();
  const initialized = await gateway.handleMessage({
    jsonrpc: '2.0',
    id: 3,
    method: 'initialize',
    params: {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'boundary-test', version: '1' },
    },
  }, { session });
  assert.equal(initialized.result.protocolVersion, '2025-11-25');
  await gateway.handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }, { session });

  const response = await gateway.handleMessage({
    jsonrpc: '2.0',
    id: 4,
    method: 'tools/call',
    params: {
      name: 'workflow.status',
      arguments: IDENTITY,
    },
  }, { session });

  assert.equal(response.result.isError, true);
  assert.equal(response.result.resultType, undefined);
  assert.equal(response.result.structuredContent.error.code, 'ADAPTER_UNAVAILABLE');
  assert.equal(response.result.structuredContent.error.details.refreshToken, '[REDACTED]');
  assert.equal(response.result.structuredContent.error.details.safe, true);
  assert.equal(isJsonValue(response), true);
});

test('provider output is bounded and accessor/cycle values stay JSON-safe', async () => {
  const details = {};
  details.self = details;
  Object.defineProperty(details, 'getterSecret', {
    enumerable: true,
    get() {
      throw new Error('getter must not run');
    },
  });
  for (let index = 0; index < 1_000; index += 1) details[`entry-${index}`] = `value-${index}`;
  const gateway = createMcpGateway({
    handlers: {
      'workflow.status': () => ({
        status: 'failed',
        error: { code: 'BOUNDED_FAILURE', message: 'failed', details },
      }),
    },
  });

  const response = await gateway.handleMessage(modernRequest(5, 'workflow.status', IDENTITY));
  const safeDetails = response.result.structuredContent.error.details;
  assert.equal(response.result.isError, true);
  assert.equal(Object.keys(safeDetails).length <= 256, true);
  assert.equal(safeDetails.self, '[UNSERIALIZABLE]');
  assert.equal(safeDetails.getterSecret, '[UNSERIALIZABLE]');
  assert.equal(isJsonValue(response), true);
  assert.doesNotThrow(() => JSON.stringify(response));
});
