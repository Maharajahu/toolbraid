import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CapabilityCatalog,
  CoreError,
  canonicalHash as coreCanonicalHash,
  jsonClone,
  stableStringify,
} from '../../src/core/index.js';
import {
  ApprovalAuthority,
} from '../../src/security/index.js';

const binding = Object.freeze({
  tenantId: 'tenant-a',
  subjectId: 'subject-a',
  workflowId: 'workflow-a',
  revision: 1,
  nodeId: 'node-a',
  origin: 'https://safe.example',
  adapter: 'structured-api',
  capabilityId: 'payments.charge',
  capabilityVersion: '1',
  args: Object.freeze({ amount: 10 }),
});

function approvalAuthority() {
  const authority = new ApprovalAuthority({
    clock: () => 1_000,
    idFactory: () => 'approval-redteam-1',
    nonceFactory: () => 'redteam-nonce-abcdefghijklmnopqrstuvwxyz',
  });
  return { authority, issuer: authority.createIssuer('redteam') };
}

test('one-object approval envelopes reject nested-binding substitution', () => {
  const { authority, issuer } = approvalAuthority();
  const credential = issuer.issue(binding);

  const result = authority.verifyAndConsume({
    ...binding,
    origin: 'https://evil.example',
    adapter: 'vision',
    args: { amount: 1_000_000 },
    binding,
    approval: credential,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'INVALID_BINDING');

  // Rejecting the ambiguous envelope must not burn the real credential.
  assert.equal(authority.verifyAndConsume({ binding, approval: credential }).consumed, true);
});

test('core canonicalization preserves __proto__ as data and rejects ambiguous objects', () => {
  const protoKey = JSON.parse('{"__proto__":{"admin":true}}');
  const cloned = jsonClone(protoKey);
  assert.equal(Object.getPrototypeOf(cloned), Object.prototype);
  assert.equal(Object.prototype.hasOwnProperty.call(cloned, '__proto__'), true);
  assert.deepEqual(cloned.__proto__, { admin: true });
  assert.equal(stableStringify(protoKey), '{"__proto__":{"admin":true}}');
  assert.notEqual(coreCanonicalHash(protoKey), coreCanonicalHash({}));
  assert.equal({}.admin, undefined);

  assert.throws(() => stableStringify([, 'value']), (error) =>
    error instanceof CoreError && error.code === 'INVALID_JSON');

  let getterCalls = 0;
  const accessor = {};
  Object.defineProperty(accessor, 'secret', {
    enumerable: true,
    get() {
      getterCalls += 1;
      return 'leaked';
    },
  });
  assert.throws(() => stableStringify(accessor), (error) =>
    error instanceof CoreError && error.code === 'INVALID_JSON');
  assert.equal(getterCalls, 0);
  assert.throws(() => stableStringify({ value: '\ud800' }), (error) =>
    error instanceof CoreError && error.code === 'INVALID_JSON');
});

test('catalog rejects non-HTTP and non-origin execution targets', () => {
  const capability = (origin) => ({
    id: 'records.read',
    version: '1',
    readOnly: true,
    origins: [origin],
    adapters: [{ id: 'api' }],
  });
  for (const origin of [
    'file:///etc/passwd',
    'http://user:password@example.test',
    'https://example.test/private',
    'https://example.test/?next=http://169.254.169.254',
  ]) {
    assert.throws(() => new CapabilityCatalog({ capabilities: [capability(origin)] }), (error) =>
      error instanceof CoreError && error.code === 'INVALID_CAPABILITY');
  }

  const catalog = new CapabilityCatalog({ capabilities: [capability('HTTPS://EXAMPLE.TEST:443/')] });
  const described = catalog.describe({
    tenantId: 'tenant-a',
    subjectId: 'subject-a',
    capabilityId: 'records.read',
    version: '1',
  });
  assert.deepEqual(described.origins, ['https://example.test']);
});
