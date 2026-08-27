import assert from 'node:assert/strict';
import test from 'node:test';

import { createCompositionRoot } from '../../src/runtime/composition-root.js';

const ORIGIN = 'https://redaction.example.test';
const IDENTITY = Object.freeze({
  tenantId: 'tenant-redaction',
  subject: 'subject-redaction',
  origin: ORIGIN,
});

function identity() {
  return {
    tenantId: IDENTITY.tenantId,
    subject: IDENTITY.subject,
    origin: IDENTITY.origin,
  };
}

function capability() {
  return {
    id: 'orders.inspect',
    version: '1',
    name: 'orders.inspect',
    description: 'Read one order for redaction coverage',
    readOnly: true,
    mutates: false,
    mode: 'read',
    kind: 'read',
    operation: 'read',
    adapter: 'redaction-adapter',
    adapters: [{ id: 'redaction-adapter' }],
    origin: ORIGIN,
    origins: [ORIGIN],
    inputSchema: { type: 'object', additionalProperties: true },
    outputSchema: { type: 'object', additionalProperties: true },
  };
}

function createRuntime() {
  const calls = [];
  const runtime = createCompositionRoot({
    identity: IDENTITY,
    allowReadOnly: true,
    capabilities: [capability()],
    policyRules: [{
      id: 'allow-redaction-read',
      effect: 'allow',
      capabilities: ['orders.inspect'],
      origins: [ORIGIN],
      adapters: ['redaction-adapter'],
    }],
    adapters: {
      'redaction-adapter': {
        id: 'redaction-adapter',
        origin: ORIGIN,
        origins: [ORIGIN],
        capabilities: [{ id: 'orders.inspect' }],
        execute(request) {
          calls.push(request);
          if (request.args.mode === 'error') {
            throw {
              code: 'UPSTREAM_SECRET_ERROR',
              message: 'provider error',
              retryable: false,
              details: {
                password: 'error-password',
                token: 'error-token',
                safeErrorField: 'keep-error',
              },
            };
          }
          return {
            safeOutputField: 'keep-output',
            password: 'output-password',
            token: 'output-token',
            nested: {
              apiKey: 'output-api-key',
              safeNestedField: 'keep-nested-output',
            },
          };
        },
      },
    },
  });
  return { runtime, calls };
}

test('direct core runtime projections redact secrets in plan, request, node states, and outputs', async () => {
  const { runtime, calls } = createRuntime();
  const proposal = await runtime.callTool('plan.propose', {
    ...identity(),
    request: {
      workflowId: 'public-redaction-success',
      requestLabel: 'keep-request-label',
      password: 'request-password',
      token: 'request-token',
      nested: { apiToken: 'request-api-token', safeRequestField: 'keep-request' },
      nodes: [{
        nodeId: 'inspect-order',
        capabilityId: 'orders.inspect',
        args: {
          password: 'input-password',
          token: 'input-token',
          nested: { clientSecret: 'input-client-secret', safeArgField: 'keep-arg' },
        },
      }],
    },
  });

  assert.equal(proposal.request.password, '[REDACTED]');
  assert.equal(proposal.request.token, '[REDACTED]');
  assert.equal(proposal.request.nested.apiToken, '[REDACTED]');
  assert.equal(proposal.request.requestLabel, 'keep-request-label');
  assert.equal(proposal.request.nested.safeRequestField, 'keep-request');
  assert.equal(proposal.nodes[0].args.password, '[REDACTED]');
  assert.equal(proposal.nodes[0].args.token, '[REDACTED]');
  assert.equal(proposal.nodes[0].args.nested.clientSecret, '[REDACTED]');
  assert.equal(proposal.nodes[0].args.nested.safeArgField, 'keep-arg');

  const execution = await runtime.callTool('workflow.execute', {
    ...identity(),
    workflowId: proposal.workflowId,
    revision: proposal.revision,
  });
  assert.equal(execution.status, 'completed');
  assert.equal(calls.length, 1);
  // The adapter must still receive the original values. Redaction is only a
  // public projection and must not mutate the server-side execution record.
  assert.equal(calls[0].args.password, 'input-password');
  assert.equal(calls[0].args.token, 'input-token');

  const serialized = JSON.stringify(execution);
  for (const secret of [
    'request-password', 'request-token', 'request-api-token',
    'input-password', 'input-token', 'input-client-secret',
    'output-password', 'output-token', 'output-api-key',
  ]) {
    assert.equal(serialized.includes(secret), false, 'public execution leaked ' + secret);
  }
  assert.equal(execution.plan.nodes[0].args.password, '[REDACTED]');
  assert.equal(execution.plan.nodes[0].args.token, '[REDACTED]');
  assert.equal(execution.plan.nodes[0].args.nested.safeArgField, 'keep-arg');
  assert.equal(execution.nodeStates['inspect-order'].output.password, '[REDACTED]');
  assert.equal(execution.nodeStates['inspect-order'].output.nested.apiKey, '[REDACTED]');
  assert.equal(execution.nodeStates['inspect-order'].output.safeOutputField, 'keep-output');
  assert.equal(execution.outputs[0].output.token, '[REDACTED]');
  assert.equal(execution.outputs[0].output.nested.safeNestedField, 'keep-nested-output');
});

test('direct core runtime failure projections redact nested node errors while preserving safe fields', async () => {
  const { runtime } = createRuntime();
  const proposal = await runtime.callTool('plan.propose', {
    ...identity(),
    request: {
      workflowId: 'public-redaction-error',
      nodes: [{
        nodeId: 'inspect-error',
        capabilityId: 'orders.inspect',
        args: { mode: 'error', password: 'failure-input-password', safeArgField: 'keep-failure-arg' },
      }],
    },
  });

  await assert.rejects(
    runtime.callTool('workflow.execute', {
      ...identity(),
      workflowId: proposal.workflowId,
      revision: proposal.revision,
    }),
  );
  // The broker persists a failed node/workflow before surfacing the execution
  // error. Read the public status projection to exercise the direct
  // publicCoreWorkflow response path.
  const publicResult = await runtime.callTool('workflow.status', {
    ...identity(),
    workflowId: proposal.workflowId,
    revision: proposal.revision,
  });
  const serialized = JSON.stringify(publicResult);
  assert.equal(serialized.includes('error-password'), false);
  assert.equal(serialized.includes('error-token'), false);
  assert.equal(serialized.includes('failure-input-password'), false);
  assert.equal(publicResult.nodeStates['inspect-error'].error.details.password, '[REDACTED]');
  assert.equal(publicResult.nodeStates['inspect-error'].error.details.token, '[REDACTED]');
  assert.equal(publicResult.nodeStates['inspect-error'].error.details.safeErrorField, 'keep-error');
  assert.equal(publicResult.plan.nodes[0].args.password, '[REDACTED]');
  assert.equal(publicResult.plan.nodes[0].args.safeArgField, 'keep-failure-arg');
});
