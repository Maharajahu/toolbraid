# ToolBraid rebuild contract

## Outcome

Deliver a dependency-free Node.js MCP server and secure workflow control plane.
The browser demo is an adapter/showcase, not the trust boundary.

## Public MCP tools

Exactly these six public tools are exposed:

1. `capabilities.search`
2. `capabilities.describe`
3. `plan.propose`
4. `workflow.execute`
5. `workflow.status`
6. `workflow.replay_readonly`

No public tool can grant approval, execute arbitrary JavaScript or shell,
access cookies, browse the filesystem, or bypass policy.

## Shared contracts

- ESM JavaScript on Node.js 20+, no third-party runtime dependencies.
- Every exported operation accepts one object and returns JSON-safe data.
- Errors use `{ code, message, retryable, details? }` and fail closed.
- Tenant/user/workflow identity must be explicit and never inferred globally.
- Mutating execution requires a trusted, server-side approval record.
- Approval binds tenant, subject, workflow, revision, node, origin, adapter,
  capability ID/version, canonical argument hash, expiry and a single-use
  nonce.
- Provider/page metadata and outputs are untrusted data and are never promoted
  into catalog authority by the default non-fixture runtime.
- Audit records are append-only and redact secret-like keys.
- Adapters expose semantic capabilities; raw click/shell primitives are not public.
- Adapter routing is server-owned and fixed:
  `structured-api -> webmcp -> dom-accessibility -> vision`.
- Plans, adapter values, workflow state, gateway calls, and stdio queues are
  bounded; cancellation is cooperative and does not roll back mutations.

## Non-production boundary

The MVP does not include external authentication, durable DB/workflow/approval/
audit storage, KMS or a credential vault, browser/profile isolation, enforced
egress, production rate limiting/tenant fair-use quotas, or a forced worker
cancel boundary. The Dockerfile is non-root but not digest pinned; immutable
image pinning and scan evidence are required before container promotion.

## Module ownership

- `src/mcp/`: protocol transport, validation, six tool schemas and dispatch.
- `src/core/`: catalog, planner, workflow state machine and execution broker.
- `src/security/`: policy, approvals, canonical hashing, audit and redaction.
- `src/adapters/`: structured, WebMCP, DOM/a11y and vision adapter contracts.
- `src/runtime/`: composition root and fixtures.
- `test/`: unit, integration, protocol and adversarial tests.

Do not edit another agent's owned directory unless integration requires it.

## Required workflow lifecycle

`draft -> proposed -> running -> awaiting_approval -> running -> completed`

Terminal alternatives: `failed`, `cancelled`.
Replay may only re-run recorded read-only nodes and must never replay mutations.

## Persistence rule

No milestone is accepted without changed files, passing tests and a remote
commit SHA on `codex/toolbraid-v1`.
