# ToolBraid

ToolBraid is a dependency-free Node.js 20+ MCP control plane for
policy-checked semantic web workflows. It searches host-registered semantic
capabilities, proposes versioned workflows, executes approved mutations, and
replays read-only nodes. The browser/page is an adapter boundary, not a trust
boundary.

This checkout is an MVP reference implementation. It is useful for local
development and contract/integration testing; it is explicitly not a
production service and must not be presented as production-ready from a green
test run.
Read [`docs/HANDOVER.md`](docs/HANDOVER.md) for the verified run commands,
wire example, security model, limitations, and follow-up work. The more
detailed contracts are in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) and
[`docs/OPERATIONS.md`](docs/OPERATIONS.md).

## Quick start

Use Node.js 20 or newer (the repository declares `"engines": { "node": ">=20" }`).
There are no runtime dependencies, but install from the checkout in the usual
way:

```sh
npm install
npm test
```

Start the local HTTP listener on an explicit loopback port:

```sh
PORT=3000 node src/server.js
```

For the deterministic local fixture (recommended for the first run):

```sh
TOOLBRAID_FIXTURE=1 PORT=3000 node src/server.js
```

The HTTP endpoint is `POST http://127.0.0.1:3000/mcp`; `/healthz` and
`/health` return a basic health response. The process also accepts newline-
delimited JSON-RPC over stdio:

```sh
TOOLBRAID_TRANSPORT=stdio TOOLBRAID_FIXTURE=1 node src/server.js
```

Send one JSON-RPC object per input line. Responses are written to stdout;
diagnostics, if any, go to stderr.

## Public tools

The public MCP registry contains exactly these six names:

| Tool | Contract |
| --- | --- |
| `capabilities.search` | Discover semantic capabilities; read-only. |
| `capabilities.describe` | Read one capability's schema and safety metadata. |
| `plan.propose` | Store a versioned workflow proposal; it does not invoke an adapter. |
| `workflow.execute` | Run the proposed workflow; every mutating node needs trusted server-side approval. |
| `workflow.status` | Read workflow state and recorded results. |
| `workflow.replay_readonly` | Re-run recorded read-only nodes; mutation nodes are excluded. |

Every public tool requires explicit tenant and subject identity in its
arguments (`tenantId` plus `subjectId`, `subject`, `userId`, or a nested
`identity` object). Identity is never inferred from process-global state.
Approval grant, arbitrary shell/JavaScript, cookie, filesystem, and raw-click
operations are not public tools.

## Trust model and routing

The six-tool surface is the complete public API. Capabilities are explicit
host/catalog records. Page/provider manifests and adapter metadata are
untrusted observations and are not promoted into catalog authority by the
default non-fixture runtime. In particular, a page cannot self-declare that an
operation is read-only or select its own origin, schema, approval policy, or
execution scope.

The server-side adapter order is fixed:

`structured-api -> webmcp -> dom-accessibility -> vision`

Routing only chooses an already-bound implementation for the approved
capability. Vision requires explicit policy opt-in. Plans cannot use routing to
introduce raw click, shell, JavaScript, cookie, or filesystem access.

## Built-in safety bounds

The MVP bounds plans, adapter data, workflows, and in-flight protocol work.
Defaults are 128 plan nodes, 32 dependencies per node, 1,024 aggregate
dependencies, 512 KiB plan input, 10,000 workflow records globally, 2,000 per
tenant, 500 per identity, 64 active gateway calls globally, and 32 per session.
The stdio transport additionally admits 16 active tasks, queues at most 256
normal tasks/8 MiB, and reserves a bounded cancellation lane. These are
process/admission safeguards, not production rate limiting or tenant fair-use
quotas.

Cancellation is cooperative: read-only adapter paths receive an `AbortSignal`
when the transport can deliver one; handlers must observe it. Mutations do not
receive a cancellation signal and cannot use a non-cancelling in-process
timeout. A canceled response may be suppressed without proving an external
side effect was undone.

## Status

The source and tests are authoritative. The current implementation includes
the protocol gateway, strict tool schemas, bounded in-memory
workflow/security services, semantic adapter contracts, deterministic
fixtures, and adversarial tests. It does not include external authentication,
durable state, KMS/secret-vault integration, isolated browser workers,
enforced egress policy, production rate limiting, or forced cancellation.
The Dockerfile is non-root but not digest pinned, so container publication is
blocked until an immutable base digest and scan evidence exist. See the
[handover](docs/HANDOVER.md), [operations runbook](docs/OPERATIONS.md), and
[threat matrix](docs/THREAT-CONTROL-MATRIX.md).
