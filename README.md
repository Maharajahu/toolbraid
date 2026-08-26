# ToolBraid

ToolBraid is a dependency-free Node.js 20+ MCP control plane for
policy-checked semantic web workflows. It discovers capabilities, proposes
versioned workflows, executes approved mutations, and replays read-only nodes.
The browser/page is an adapter boundary, not a trust boundary.

This checkout is an MVP reference implementation. It is useful for local
development and contract/integration testing; it is not a production service.
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

## Status

The source and tests are authoritative. The current implementation includes
the protocol gateway, strict tool schemas, in-memory workflow/security
services, semantic adapter contracts, deterministic fixtures, and adversarial
tests. Authentication, durable state, secret management, browser workers, and
production traffic controls remain deployment/next-step work; see the
[handover](docs/HANDOVER.md).
