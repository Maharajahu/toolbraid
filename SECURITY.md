# Security policy

ToolBraid handles workflow intent, approvals, and potentially sensitive
provider data. The repository contract is designed to fail closed, but a
checkout is not a complete production security boundary: authentication, TLS,
durable state, secret storage, resource controls, and monitoring must be
provided and evidenced by the deployment.

## Security boundaries

- Public callers may use only the six documented MCP tools. No public operation
  grants approval, runs arbitrary JavaScript or shell, accesses cookies,
  browses the filesystem, or bypasses policy.
- Tenant, subject/user, and workflow identity must be explicit. Never infer
  identity from global process state.
- A mutating operation requires a trusted server-side approval bound to tenant,
  subject, workflow, revision, node, origin, adapter, canonical argument hash,
  expiry, and a single-use nonce.
- Provider metadata, page content, observations, and outputs are untrusted
  input. Audit records are append-only at the interface and redact secret-like
  keys.

These are repository-level requirements. They do not prove that an external
gateway authenticates users, that a state store is durable, or that a browser
profile is isolated. See [`docs/OPERATIONS.md`](docs/OPERATIONS.md) before
exposing the process to traffic.

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
