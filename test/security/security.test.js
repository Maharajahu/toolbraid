import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ApprovalAuthority,
  AuditLog,
  PolicyEngine,
  SecurityError,
  canonicalHash,
  canonicalJson,
  redactSecrets,
} from "../../src/security/index.js";

const BASE = Object.freeze({
  tenantId: "tenant-a",
  subjectId: "subject-a",
  workflowId: "workflow-a",
  revision: 7,
  nodeId: "node-a",
  origin: "https://EXAMPLE.com:443",
  adapter: "Structured-API",
  args: Object.freeze({ amount: 25, currency: "USD" }),
});

function makeAuthority({ now = 1_000 } = {}) {
  let clockNow = now;
  let nonce = 0;
  let id = 0;
  const audit = new AuditLog({ clock: () => clockNow });
  const authority = new ApprovalAuthority({
    clock: () => clockNow,
    audit,
    idFactory: () => `approval-${++id}`,
    nonceFactory: () => `nonce-${++nonce}-abcdefghijklmnopqrstuvwxyz`,
  });
  return {
    authority,
    issuer: authority.createIssuer("test-server"),
    audit,
    advance(ms) {
      clockNow += ms;
    },
  };
}

test("canonical JSON sorts objects and hashes one representation", () => {
  const left = { z: 1, a: [true, null, "ok"], nested: { b: 2, a: 1 } };
  const right = { nested: { a: 1, b: 2 }, a: [true, null, "ok"], z: 1 };
  assert.equal(canonicalJson(left), '{"a":[true,null,"ok"],"nested":{"a":1,"b":2},"z":1}');
  assert.equal(canonicalJson(left), canonicalJson(right));
  assert.equal(canonicalHash(left), canonicalHash(right));
  assert.equal(canonicalJson(-0), "0");
  assert.throws(() => canonicalJson({ value: undefined }), /JSON-safe/);
  assert.throws(() => canonicalJson({ value: Number.NaN }), /finite/);
  assert.throws(() => canonicalJson({ value: 1n }), /JSON-safe/);
});

test("canonical JSON rejects ambiguous object forms and cycles", () => {
  const cyclic = {};
  cyclic.self = cyclic;
  assert.throws(() => canonicalJson(cyclic), (error) => error instanceof SecurityError && error.code === "INVALID_CANONICAL_JSON");
  assert.throws(() => canonicalJson([, 1]), /Sparse/);
  assert.throws(() => canonicalJson(new Date(0)), /plain JSON/);
  assert.throws(() => canonicalJson({ get value() { return "secret"; } }), /Accessor/);
  assert.throws(() => canonicalJson("\ud800"), /surrogate/);
  const polluted = Object.create(null);
  polluted.__proto__ = { compromised: true };
  assert.equal(canonicalJson(polluted), '{"__proto__":{"compromised":true}}');
});

test("trusted approval binds every execution dimension and is single-use", () => {
  const { authority, issuer } = makeAuthority();
  const token = issuer.issue(BASE, { ttlMs: 500 });

  assert.equal(authority.verify(BASE, token).ok, true);
  assert.equal(authority.consume({ ...BASE, origin: "https://example.com" }, token).consumed, true);
  assert.equal(authority.consume(BASE, token).code, "APPROVAL_REPLAY");
});

for (const [field, change] of [
  ["tenantId", "tenant-b"],
  ["subjectId", "subject-b"],
  ["workflowId", "workflow-b"],
  ["revision", 8],
  ["nodeId", "node-b"],
  ["origin", "https://evil.example"],
  ["adapter", "vision"],
  ["args", { amount: 26, currency: "USD" }],
]) {
  test(`approval cannot be swapped to a different ${field}`, () => {
    const { authority, issuer } = makeAuthority();
    const token = issuer.issue(BASE, { ttlMs: 500 });
    const request = { ...BASE, [field]: change };
    assert.equal(authority.consume(request, token).code, "APPROVAL_BINDING_MISMATCH");
    // A failed swap does not burn the legitimate approval.
    assert.equal(authority.consume(BASE, token).consumed, true);
  });
}

test("approval nonce is required, expires, and cannot be issued by consumers", () => {
  const { authority, issuer, advance } = makeAuthority();
  assert.equal("issue" in authority, false);
  const token = issuer.issue(BASE, { ttlMs: 10 });
  assert.equal(authority.consume(BASE, { ...token, nonce: `${token.nonce}x` }).code, "APPROVAL_INVALID");
  advance(10);
  assert.equal(authority.consume(BASE, token).code, "APPROVAL_EXPIRED");
});

test("one-object approval records recompute aliases and consume exactly once", () => {
  const { authority, issuer } = makeAuthority();
  const { subjectId, adapter, ...baseAliases } = BASE;
  const token = issuer.issue({
    ...baseAliases,
    subject: subjectId,
    adapterId: adapter,
  });
  assert.equal(authority.verifyAndConsume({
    ...baseAliases,
    subject: BASE.subjectId,
    adapterId: BASE.adapter,
    approvalId: token.approvalId,
    approvalNonce: token.nonce,
  }).consumed, true);
});

test("policy requires explicit allow rules and trusted approval for mutations", () => {
  const { authority, issuer } = makeAuthority();
  const policy = new PolicyEngine({
    approvalAuthority: authority,
    rules: [{
      effect: "allow",
      id: "send",
      tenantId: "tenant-a",
      subjectId: "subject-a",
      origin: "https://example.com",
      adapter: "structured-api",
      capability: "payments.charge",
      mutation: true,
    }],
  });
  const withoutApproval = policy.authorize({ ...BASE, capability: "payments.charge", mutation: true });
  assert.equal(withoutApproval.code, "APPROVAL_REQUIRED");

  const token = issuer.issue(BASE, { ttlMs: 500 });
  const authorized = policy.authorize({ ...BASE, capability: "payments.charge", mutation: true, approval: token });
  assert.equal(authorized.allowed, true);
  assert.equal(authorized.authorized, true);
  assert.equal(policy.authorize({ ...BASE, capability: "payments.charge", mutation: true, approval: token }).code, "APPROVAL_REPLAY");
});

test("policy denies origin or adapter swaps before adapter execution", () => {
  const { authority, issuer } = makeAuthority();
  const policy = new PolicyEngine({
    approvalAuthority: authority,
    rules: [{ effect: "allow", tenantId: "tenant-a", capability: "payments.charge", mutation: true }],
  });
  const token = issuer.issue(BASE, { ttlMs: 500 });
  assert.equal(policy.authorize({ ...BASE, capability: "payments.charge", mutation: true, origin: "https://evil.example", approval: token }).code, "APPROVAL_BINDING_MISMATCH");
  assert.equal(policy.authorize({ ...BASE, capability: "payments.charge", mutation: true, adapter: "vision", approval: token }).code, "APPROVAL_BINDING_MISMATCH");
  assert.equal(policy.authorize({ ...BASE, capability: "payments.charge", mutation: true, approval: token }).authorized, true);
});

test("read-only policy can be enabled independently and defaults fail closed", () => {
  const read = { ...BASE, capability: "catalog.search", mutation: false };
  assert.equal(new PolicyEngine().evaluate(read).code, "POLICY_DENIED");
  assert.equal(new PolicyEngine({ allowReadOnly: true }).authorize(read).authorized, true);
  assert.equal(new PolicyEngine({ allowReadOnly: true }).evaluate({ ...read, mutation: true }).code, "POLICY_DENIED");
});

test("audit log is append-only, hash chained, and redacts nested secret-like keys", () => {
  let now = 4_000;
  const log = new AuditLog({ clock: () => now });
  const source = {
    type: "adapter.result",
    tenantId: "tenant-a",
    details: {
      access_token: "do-not-log",
      nested: { password: "also-do-not-log" },
      safe: "visible",
    },
  };
  const first = log.append(source);
  assert.equal(first.details.access_token, "[REDACTED]");
  assert.equal(first.details.nested.password, "[REDACTED]");
  assert.equal(first.details.safe, "visible");
  assert.equal(Object.isFrozen(first), true);
  assert.throws(() => { first.tenantId = "tampered"; }, TypeError);
  source.details.safe = "changed outside";
  now += 1;
  log.append("workflow.completed", { tenantId: "tenant-a", authorization: "secret" });
  const snapshot = log.entries();
  assert.throws(() => { snapshot[0].details.safe = "mutated snapshot"; }, TypeError);
  assert.equal(log.entries()[0].details.safe, "visible");
  assert.equal(log.verifyIntegrity(), true);
  assert.equal(log.entries()[1].authorization, "[REDACTED]");
  assert.equal(log.lastHash.length, 64);
});

test("redaction does not mutate caller data and handles cycles", () => {
  const value = { token: "secret", nested: { value: "keep" } };
  value.self = value;
  const copy = redactSecrets(value);
  assert.equal(copy.token, "[REDACTED]");
  assert.equal(copy.nested.value, "keep");
  assert.equal(copy.self, "[UNSERIALIZABLE]");
  assert.equal(value.token, "secret");
});
