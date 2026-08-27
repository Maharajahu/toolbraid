# Native WebMCP Contract

**Pinned specification:** WebMCP Draft Community Group Report, 26 August 2026
**Canonical source:** https://webmachinelearning.github.io/webmcp/

This document is the implementation contract for the competition branch. The
native browser path is authoritative; the local runtime may mirror it for tests
but may not define a different public behavior.

## Provider registration

Each provider registers tools from its own document and exposes them only to the
orchestrator origin.

```js
const lifecycle = new AbortController();

await document.modelContext.registerTool({
  name: "probe_service",
  title: "Probe service health",
  description: "Read the current health and error window for a service.",
  inputSchema: {
    type: "object",
    properties: {
      service: { type: "string" }
    },
    required: ["service"]
  },
  annotations: {
    readOnlyHint: true,
    untrustedContentHint: true
  },
  async execute(input, { signal }) {
    signal.throwIfAborted();
    return readServiceHealth(input.service);
  }
}, {
  exposedTo: [ORCHESTRATOR_ORIGIN],
  signal: lifecycle.signal
});
```

The literal form above remains in the public repository because it is both the
reference implementation and an explicit competition requirement.

## Orchestrator discovery

The orchestrator queries only the configured provider origins. An empty
`fromOrigins` list is not a cross-origin discovery request; under the current
spec it includes only same-origin documents.

```js
const registeredTools = await document.modelContext.getTools({
  fromOrigins: allowedProviderOrigins
});
```

Every returned `RegisteredTool` is retained as a live opaque reference. The
identity used by ToolBraid is at minimum:

```text
origin + name + normalized input schema + registration generation
```

The native dictionary supplies `name`, `title`, `description`, `inputSchema`,
`window`, `origin`, and `annotations`.

## Orchestrator execution

Execution uses the exact live `RegisteredTool` object returned by `getTools()`.
There is no production fallback that resolves a mutating tool by name alone.

```js
const serializedResult = await document.modelContext.executeTool(
  registeredTool,
  approvedArguments,
  { signal }
);

const result = JSON.parse(serializedResult);
```

The adapter may accept object results only in the explicitly identified local
test runtime. Native mode follows the specification's serialized string result.

The 26 August draft accepts an object for `inputObject`. Chrome 151's current
experimental implementation still expects a JSON string. ToolBraid therefore
uses a tightly bounded compatibility path: it attempts the standards object
first, and retries with `JSON.stringify(approvedArguments)` only when Chrome
returns the exact pre-dispatch error `UnknownError: Failed to parse input
arguments`. No provider error, timeout, cancellation, or other execution failure
is retried. Both paths execute the exact opaque `RegisteredTool` object.

## Allowlist and origin policy

- provider origins are explicit configuration, not discovered from metadata;
- providers expose tools only to the orchestrator origin;
- the orchestrator passes only approved origins to `fromOrigins`;
- an origin absent from configuration cannot contribute tools;
- a returned tool whose reported origin differs from configuration is rejected;
- the plan, approval, execution, and audit all preserve the reported origin.

## Approval binding

An approval envelope covers:

```text
version
planId
planRevision
nodeId
toolOrigin
toolName
toolSchemaFingerprint
canonicalCapability
normalizedArguments
effectSummary
risk
nonce
issuedAt
```

The canonical serialization is hashed with SHA-256. Immediately before the
mutation sequence, ToolBraid refreshes the live registry and rejects execution
unless both tools' origin, name, and schema fingerprint still match their
envelopes. The complete approval set is validated and claimed atomically before
the first external effect. If any envelope is invalid, no nonce is consumed; a
claimed nonce cannot be replayed.

## Test-runtime parity

The local runtime must reproduce the native observable contract:

- `registerTool()` is asynchronous;
- duplicate names within one document are rejected;
- `exposedTo` and `fromOrigins` are enforced;
- `getTools()` returns opaque registered-tool references with `origin`;
- `executeTool()` requires the reference rather than a string name;
- tool results use native serialized-result behavior at the adapter boundary;
- abort signals unregister tools and cancel executions;
- tool changes invalidate cached mappings and approvals.

Any local-only compatibility behavior must be visibly labeled in diagnostics
and must never be used as evidence of native WebMCP compliance.
