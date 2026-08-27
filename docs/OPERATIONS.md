# ToolBraid operator runbook

This runbook covers the repository's local/reference process and the controls
needed before placing it behind any real endpoint. Starting `src/server.js` is
not, by itself, evidence of authentication, TLS, durable state, browser
isolation, egress enforcement, or safe internet exposure. The checkout is a
non-production MVP.

## Prerequisites and verification

Use Node.js 20 or newer, matching the `engines` declaration in
`package.json`. Before running a release candidate, record the commit SHA and
run:

```sh
npm test
npm run check
node --test test/release/*.test.js
npm run smoke
```

The first two commands are the repository's normal gates. The release suite
checks delivery invariants in addition to behavioral tests. Treat any failure
as a release blocker; do not weaken a check to make a pipeline green.

## Local start

For a local process, use:

```sh
NODE_ENV=production node src/server.js
```

Production refuses `fixture=true` and `TOOLBRAID_FIXTURE=1` with
`INSECURE_FIXTURE_FORBIDDEN`; use fixture mode only for local tests and demos.

Only configuration documented by the source and deployment environment should
be supplied. Do not put secrets on command lines or commit `.env` files. Keep a
local instance bound to its intended private transport until an authenticated,
TLS-terminating boundary has been configured. The repository does not promise
that its default process is an internet-facing HTTP service.

## Production admission checklist

Before accepting traffic, an operator should have evidence for each item:

- **Identity:** the edge authenticates callers and passes an explicit tenant,
  subject, and workflow identity; it cannot be omitted or inherited from a
  process-global default.
- **Transport:** TLS, request-size limits, timeouts, rate limits, and an
  egress allowlist are enforced at the edge or runtime. The repository's
  request/concurrency bounds are not a substitute for these controls.
- **Authorization:** mutating calls require a trusted server-side approval
  record bound to all fields in the architecture contract. Approval records
  have expiry and a single-use nonce, and the backing store prevents races.
- **Isolation:** tenants do not share mutable state, credentials, browser
  profiles, or audit access. Run a cross-tenant negative test before admission.
- **Persistence:** workflow state, approvals, and audit events have an
  explicitly selected durable store, retention policy, backup/restore test,
  and access audit. An in-memory process is not a recovery plan.
- **Secrets:** credentials are injected through a secret manager, scoped to the
  adapter/origin that needs them, never returned to clients, and rotated.
- **Runtime:** run the image as a non-root user with a read-only root
  filesystem, dropped Linux capabilities, `no-new-privileges`, resource
  limits, and a restricted network policy. Pin the base image by digest in the
  deployment manifest and scan it before promotion.
- **Observability:** collect redacted, append-only audit events and service
  health/error metrics without logging page content or secret-like values.
- **Recovery:** document how to stop ingress, revoke outstanding approvals,
  preserve evidence, restore state, and verify no mutation was replayed.

The repository itself does not supply external authentication, a durable
database/approval/audit authority, KMS or a credential vault, browser/profile
isolation, enforced egress/DNS policy, production rate limiting, or a forced
worker kill boundary. Record each as a deployment gap until independently
implemented and tested.

If an item is not implemented or evidenced, record it as a deployment gap. Do
not describe the service as production-ready on the basis of tests alone.

## Normal operation

Use `workflow.status` for the state and result view permitted by policy. A
mutating workflow should be treated as `awaiting_approval` until a trusted
approval is present; a client-supplied “approved” flag is not sufficient. Check
the revision and origin when reviewing an approval, and expect a nonce to be
consumed exactly once.

Read-only replay is for recorded read-only nodes only. If a result is needed
for an incident, preserve the original audit event and replay identifier; do
not manually reissue a mutating request as a diagnostic.

There is no public approval-granting or cancellation tool in the six-tool
surface. Use the hosting/process supervisor and the configured approval store's
operator controls for emergency containment, then verify workflow state after
the process is healthy again.

Cancellation is cooperative. Read-only adapter calls may observe an
`AbortSignal`; a handler that ignores it can continue consuming an admitted
slot until it completes. Mutation calls do not receive the signal, and a
client-side cancellation or timeout does not prove that a provider mutation was
rolled back. Do not blindly retry a mutation after an ambiguous timeout; use
workflow status and reconciliation evidence.

The built-in admission safeguards are finite but local: plans are bounded at
128 nodes/32 dependencies per node/1,024 aggregate dependencies/512 KiB;
workflow storage defaults to 10,000 records/256 MiB globally, 2,000 records/64
MiB per tenant, 500 records/16 MiB per identity, and 4 MiB per record; the
gateway allows 64 active calls globally and 32 per session. Stdio allows 16
active tasks with a bounded queue. There is no production rate limiter or
tenant fair-use service.

Capabilities must be explicitly registered by the host/catalog. Provider/page
manifests are observations and are not authority. Adapter routing is fixed in
this order: `structured-api -> webmcp -> dom-accessibility -> vision`;
vision requires explicit policy opt-in.

## Incident procedure

1. Stop new ingress or isolate the affected tenant/origin.
2. Revoke or expire outstanding approvals and disable compromised adapter
   credentials.
3. Preserve redacted audit events, request IDs, image digest, and commit SHA.
4. Determine whether any mutation occurred; compare canonical argument hashes
   and nonce consumption rather than trusting provider text.
5. Restore from a known-good state only after the approval and audit stores are
   consistent. Re-run read-only verification where useful.
6. Record the root cause, affected identities/origins, containment time, and a
   regression test or operational control before re-enabling traffic.

## Release evidence

The release record should include the exact commit SHA, Node versions tested,
the output of `npm test`, `npm run check`, and `node --test test/release/*.test.js`, plus
the container image digest and vulnerability-scan result when a container is
published. The current Dockerfile uses a floating `node:20-alpine` tag, so
container publication is blocked until an immutable digest is pinned and
scanned. Keep this evidence with the deployment change; a green local run
without a persisted commit is not a release.
