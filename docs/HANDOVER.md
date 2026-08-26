# ToolBraid handover

This is the concise operator/developer handover for the current MVP checkout.
It records commands and protocol details verified against the repository. The
implementation is dependency-free ESM JavaScript and requires Node.js 20 or
newer.

## Install and verify

From the repository root:

```sh
npm install
npm test
npm run check
npm run smoke
```

`npm test` runs the full Node test discovery (`node --test`). `npm run check`
first syntax-checks `src/server.js` and then runs the same test command.
`npm run smoke` runs `scripts/smoke.mjs` against a fresh deterministic fixture
runtime. A successful smoke run prints JSON with `ok: true`, the status
sequence `proposed -> awaiting_approval -> completed`, and a read-only replay
count.

The package has no runtime dependencies. `npm install` is still the normal
checkout setup command; the container deliberately copies source without
installing packages.

## Run over HTTP

The CLI starts an HTTP server when `TOOLBRAID_TRANSPORT` is unset:

```sh
PORT=3000 node src/server.js
```

It binds to `127.0.0.1` by default. `PORT` may be set through the environment;
the default is an ephemeral port, reported on stderr. Use the fixture for a
deterministic local workflow:

```sh
TOOLBRAID_FIXTURE=1 PORT=3000 node src/server.js
```

The implemented routes are:

| Route | Behavior |
| --- | --- |
| `GET /healthz` or `GET /health` | `{ "ok": true, "service": "toolbraid" }` |
| `GET /` | Service name, JSON-RPC protocol label, and six public tool names. |
| `POST /mcp` | One JSON-RPC 2.0 request, with current MCP metadata. |

`POST /mcp` requires `Content-Type: application/json`. If an `Origin` header
is present, it must be an exact canonical origin configured through the
embedding API (`allowedHttpOrigins` or `http.allowedOrigins`); omitted Origin
is accepted for non-browser clients. The body limit is 1 MiB. The endpoint
returns JSON, including for JSON-RPC errors; notifications receive HTTP 202
with an empty body.

### Current MCP request metadata (2026-07-28)

Modern requests carry this metadata in `params._meta` on every request:

```json
{
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientCapabilities": {},
  "io.modelcontextprotocol/clientInfo": {
    "name": "example-client",
    "version": "1.0.0"
  }
}
```

`clientInfo` is optional; when present, both fields are required. The
following request lists the six tools. The HTTP transport mirrors the
protocol version and method in headers; for `tools/call`, it also mirrors the
tool name as `Mcp-Name`.

```sh
curl --fail-with-body -sS http://127.0.0.1:3000/mcp \
  -X POST \
  -H 'Accept: application/json, text/event-stream' \
  -H 'Content-Type: application/json' \
  -H 'MCP-Protocol-Version: 2026-07-28' \
  -H 'Mcp-Method: tools/list' \
  --data '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{},"io.modelcontextprotocol/clientInfo":{"name":"example-client","version":"1.0.0"}}}}'
```

The response is a JSON-RPC result whose `result.tools` array contains exactly
the six names in the table above. A `tools/call` request follows the same
shape, for example its transport headers include:

```text
MCP-Protocol-Version: 2026-07-28
Mcp-Method: tools/call
Mcp-Name: capabilities.search
```

The request body then uses `method: "tools/call"` and
`params.name: "capabilities.search"`. Header/body mismatches fail closed.

## Run over stdio

Start the newline-delimited transport with:

```sh
TOOLBRAID_TRANSPORT=stdio TOOLBRAID_FIXTURE=1 node src/server.js
```

For a one-shot `tools/list` request, the following sends one frame and then
EOFs stdin:

```sh
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{}}}}' \
  | TOOLBRAID_TRANSPORT=stdio TOOLBRAID_FIXTURE=1 node src/server.js
```

Stdio uses one JSON-RPC object per line. Stdout is reserved for serialized
JSON-RPC messages, blank/malformed/oversized frames produce protocol errors,
and notifications do not receive responses. The gateway also retains legacy
`initialize`/`notifications/initialized` compatibility for the older
connection-scoped protocol revisions; modern clients should use the
per-request metadata above.

## Fixture smoke path

```sh
npm run smoke
```

The smoke script uses the explicit fixture identity and walks this path:

1. Search for `cart` capabilities.
2. Propose a workflow containing a read-only catalog search and a mutating
   `cart.add` node.
3. Execute until it returns `awaiting_approval` and `APPROVAL_REQUIRED`.
4. Inject the returned approval through the internal host hook, then execute
   to `completed`.
5. Replay only the recorded read-only node(s).

The approval injection hook is not an MCP tool and is not reachable through
client arguments. Fixture state is local to that runtime instance.

## Security model

The server-side control plane owns the following boundaries:

- The public surface is allow-listed to the six tools above. Semantic
  capabilities are not raw click, shell, arbitrary JavaScript, cookie, or
  filesystem primitives.
- Tenant, subject, origin, workflow, and revision are explicit data. Workflow
  access checks identity and origin consistency; configured process identity
  is not a substitute for caller identity.
- Plans normalize mutability and reject unsafe/ambiguous capability contracts.
  Execution evaluates policy and binds each mutating decision to tenant,
  subject, workflow, revision, node, origin, adapter, capability/version,
  canonical argument hash, expiry, and a single-use nonce.
- Approval records are trusted only when injected through the server-side
  approval boundary. Client-supplied approval-shaped fields are rejected.
  A consumed approval cannot be used for a second mutation.
- Provider metadata, page content, observations, and adapter output are
  untrusted data. Results are JSON-safe and thrown handler details are
  sanitized; audit records redact secret-like keys.
- Read-only replay independently checks the stored plan, current capability
  metadata, and recorded output flags. It never invokes a mutation node.
- Adapter selection is semantic and ordered from structured API to WebMCP,
  DOM/accessibility, and vision fallback. Fallback does not widen the
  approved capability.
- HTTP has request-size, content-type, method/path, origin, and mirrored
  metadata-header checks. Each HTTP request gets an isolated protocol session;
  there is no authenticated MCP session-id mechanism in this endpoint.

These are repository controls, not proof that a deployment authenticates
callers or isolates browser credentials. See [`SECURITY.md`](../SECURITY.md),
[`docs/ARCHITECTURE.md`](ARCHITECTURE.md), and [`docs/OPERATIONS.md`](OPERATIONS.md).

## MVP and non-production limitations

The default composition root is intentionally small and in-process:

- Workflows, trusted approvals, and audit records are held in memory. They are
  lost on restart and do not provide a durable, highly available, race-safe
  authority. Host-provided service implementations can be injected through
  the composition API, but the CLI does not configure one.
- There is no external authentication or identity provider. Explicit IDs are
  validated for shape and consistency, not authenticated. There is no
  external authorization gateway, KMS, secret manager, or credential vault in
  this checkout.
- There is no durable database, backup/restore path, retention service, or
  production audit sink. The built-in audit interface is an in-memory list.
- There is no rate limiting, tenant quota, or production request scheduler.
  HTTP has a 1 MiB body limit and stdio has a bounded line frame, but these
  are protocol safeguards, not abuse protection.
- There is no browser worker, browser profile manager, GPU worker, video
  ingestion pipeline, or chat backend. Adapter contracts and deterministic
  fixtures do not launch or manage those services.
- The default listener is loopback HTTP without TLS. Put an authenticated,
  TLS-terminating edge and deployment controls in front of it before accepting
  traffic.

Do not call this checkout production-ready based on a passing test suite.

## Next steps: GPU and video chat

Keep the six-tool control-plane contract and add media execution behind the
semantic adapter/broker boundary:

1. Define bounded video/audio and chat capability contracts, schemas, media
   retention/redaction rules, and provenance fields. Bind approvals to the
   relevant media/prompt hash and model/version, not to free-form worker input.
2. Add an isolated browser/media worker service with explicit GPU scheduling,
   time/memory/frame limits, egress policy, cancellation, and tenant/profile
   isolation. Return bounded typed results or job identifiers to the control
   plane; never expose worker shell or arbitrary code execution.
3. Add an authenticated, rate-limited streaming/chat ingress (and choose the
   required WebRTC/WebSocket or equivalent transport) without weakening the
   JSON-RPC tool boundary.
4. Move workflows, approvals, and audit to durable stores; add KMS-backed
   secret handling, rotation, retention, backup/restore, and recovery tests.
5. Add adversarial tests for prompt/page injection, hostile media metadata,
   model/tool confusion, cancellation, replay, and cross-tenant/profile
   isolation before enabling mutating media actions.
