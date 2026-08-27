# Security policy

ToolBraid handles workflow intent, approvals, and potentially sensitive
provider data. This repository is a bounded, non-production MVP/reference
implementation. Its code and tests define contracts that fail closed;
they do not turn the checkout into an authenticated service or a complete
security boundary. A deployment must separately provide and evidence
authentication, TLS, durable state, secret storage, browser isolation, egress
control, resource governance, and monitoring before it accepts real traffic.

## Security boundaries

- Public callers may use exactly these six MCP tools: `capabilities.search`,
  `capabilities.describe`, `plan.propose`, `workflow.execute`,
  `workflow.status`, and `workflow.replay_readonly`. No public operation
  grants approval, runs arbitrary JavaScript or shell, accesses cookies,
  browses the filesystem, or bypasses policy.
- Tenant, subject/user, and workflow identity must be explicit. Never infer
  identity from global process state.
- A mutating operation requires a trusted server-side approval bound to tenant,
  subject, workflow, revision, node, origin, adapter, capability ID and
  version, canonical argument hash, expiry, and a single-use nonce.
- Provider metadata, page content, observations, and outputs are untrusted
  input. Audit records are append-only at the interface and redact secret-like
  keys.

### Capability authority and adapter routing

Capabilities are semantic records explicitly supplied by the host/catalog.
Provider or page manifests are observations only: they cannot choose
mutability, approval requirements, origins, schemas, or the execution scope of
the catalog. The default non-fixture composition does not promote provider
descriptors into capabilities. Fixture mode is deterministic test material,
not a discovery mechanism for production.

The adapter contract has one fixed trust/fallback order:

`structured-api -> webmcp -> dom-accessibility -> vision`

The server selects from adapters already bound to the approved capability and
origin. A caller cannot widen the allowlist or downgrade to a less-trusted
adapter by putting a selector in a plan. Vision is an explicit, high-risk
fallback, not an implicit escape hatch. An adapter fallback changes the
implementation route only; it never changes the approved capability.

### Resource bounds and cancellation

The MVP has finite process-level admission limits, not a tenant billing or
fair-use service. Current defaults include:

- plans: 128 nodes, 32 dependencies per node, 1,024 aggregate dependencies,
  512 KiB input, depth 32, and 20,000 JSON values;
- adapter data: 128 capabilities per adapter, bounded descriptor/output walks,
  512 KiB aggregate adapter data, depth 16, 512 nodes, 4,096-character
  strings, 128-item arrays, and 256 object keys;
- workflows: 10,000 records/256 MiB globally, 2,000 records/64 MiB per tenant,
  500 records/16 MiB per identity, and 4 MiB per record;
- gateway calls: 64 active calls globally and 32 per protocol session;
- stdio: 1 MiB frames, 16 active normal tasks, 256 queued tasks, 8 MiB queued
  bytes, plus a small reserved cancellation lane (one active and 64 queued
  notifications by default).

These limits can be configured by a host where the API allows it and are
admission safeguards, not proof against denial of service. There is no
production rate limiter, tenant fair-use quota, external scheduler, or
autoscaling policy in this checkout.

Cancellation is cooperative. A request cancellation reaches read-only
adapter paths as an `AbortSignal`; a handler must observe it. Mutating paths do
not receive a cancellation signal and mutation plans cannot use a misleading
in-process timeout, because timing out a promise does not undo a committed
provider side effect. The gateway suppresses a canceled response, but it
cannot forcibly terminate an uncooperative handler or prove that an external
side effect was rolled back. There is no public cancellation tool in the six
tool surface.

These are repository-level requirements. They do not prove that an external
gateway authenticates users, that a state store is durable, that a browser
profile is isolated, or that outbound origins are enforced. See
[`docs/OPERATIONS.md`](docs/OPERATIONS.md) before exposing the process to
traffic.

## Explicit non-production gaps

The checkout does not include or configure:

- external authentication/identity verification or a production authorization
  edge;
- a durable database, durable workflow/approval/audit store, backup/restore,
  retention service, or highly available nonce authority;
- a KMS, secret manager, credential vault, or secret rotation service;
- an isolated browser worker/profile boundary, GPU worker, or process sandbox;
- enforced network egress allowlists, DNS rebinding protection, or provider
  credential isolation;
- production rate limiting, tenant quotas/fair-use controls, or a forced
  cancellation/kill boundary.

The Dockerfile uses a non-root user, but its `node:20-alpine` base is tag
based, not digest pinned. A container image is therefore a release blocker
until the deployment pins an immutable digest and records an image scan.
Docker availability is not evidence that those controls exist.

## Reporting a vulnerability

Please avoid public disclosure of an unpatched issue. Use the repository's
private vulnerability-reporting channel when one is enabled; otherwise contact
the maintainers through the private channel used for this repository and mark
the report **Security**. Include the affected commit/version, a minimal
reproduction, impact, and any proposed mitigation. Do not include real
credentials, cookies, customer data, or unredacted provider output.

There is no implied response-time or coordinated-disclosure SLA in this
repository. Maintainers should acknowledge receipt, assess exploitability and
scope, prepare a regression test, and document remediation or a compensating
control before publishing details.

## Security review expectations

Every capability or adapter change should update the threat-control matrix,
cover malformed and adversarial provider data, and demonstrate that approval,
argument hashing, identity isolation, and read-only replay behavior still hold.
Changes that add dependencies, network listeners, browser credentials, or
persistent storage require a deployment review in addition to unit tests.
