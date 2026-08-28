# Testing Strategy

## One-command engineering validation

```bash
npm run validate
```

This command runs:

1. repository integrity, broken-link, forbidden legacy, unresolved-marker, and JavaScript syntax checks;
2. all `tests/v2/*.test.mjs` unit and integration tests;
3. static-server dependency and security-header smoke checks;
4. the generated standalone verification-harness build.

## Test coverage

- native-style registration, explicit `exposedTo`, origin filtering, opaque tool execution, cancellation, and tool-change events;
- hostile metadata quarantine before capability scoring;
- seven recovery capabilities across nine heterogeneous tools;
- schema fingerprints, aliases, confidence evidence, and canonical outputs;
- nine-node DAG dependencies and two-stage mutation finalization;
- parallel safe reads and read-only primary-to-fallback substitution;
- no mutation fallback;
- exact approval field binding, tamper/expiry detection, atomic approval-set claim, and replay rejection;
- cryptographically unique mission idempotency keys and reuse protection;
- registry invalidation around async refresh and immediately before dispatch;
- ordered recovery-then-publication execution and sealed partial-failure receipts;
- local SHA-256 integrity-chain creation, verification, and sealing;
- mission-state success, failure, reset, and approval transitions;
- multi-origin routing, headers, method rejection, and path traversal defense;
- semantic icon and constellation invariants.

## Browser E2E

```bash
npm run test:e2e
```

Playwright drives the actual mission-control interface in desktop and mobile viewports. It verifies:

- six origins, nine discovered tools, one quarantine, seven mappings, and nine graph nodes;
- the primary health read fails and the fallback completes;
- seven safe-stage results and finalized exact mutation arguments;
- synthetic DOM approval is rejected;
- two separate trusted human approval dialogs expose the real tool, origin, arguments, and effect;
- the full approval set is claimed before dispatch, then `release-1841` completes before `notice-r9` starts;
- keyboard navigation, dialog focus traps/return, tab roving, and graph roving work;
- the 320 px graph scrolls without label collisions or global page overflow, and key targets are at least 24 px;
- the audit has 54 entries, verifies as a local SHA-256 integrity chain, and is sealed;
- no material console or page errors.

The report is stored at `docs/e2e-validation.json`; current screenshots are in `docs/screenshots/`.

## Native compliance gate

Headless Chromium exercises the explicitly labelled local verification harness. Native WebMCP compliance uses installed Chrome 149+ with its testing feature enabled and the seven-origin server:

```bash
npm run test:native
```

The run must use the real `document.modelContext` surface and the UI badge must read **Native WebMCP**. Harness results must never be relabelled as native evidence. A passing run writes `docs/native-e2e-validation.json`.

Latest local full-mission native result: **PASS** in Chrome 151 with six provider origins, nine discovered tools, one quarantined tool, one expected read-provider failure followed by fallback, `release-1841`, `notice-r9`, and a verified 54-entry local integrity chain. The run also fails on any unexpected console, page, or CSP error.

## Public deployment native read-only gate

The same validator can target the public release while stopping before either deterministic fixture mutation:

```powershell
$env:TOOLBRAID_NATIVE_BASE_URL = 'https://toolbraid-webmcp.vercel.app'
$env:TOOLBRAID_NATIVE_READ_ONLY = '1'
npm run test:native
```

This gate must stop in `review` with `mutationExecution: false`. It verifies six provider origins, nine live tools, one quarantine, read-only fallback, seven safe-stage results, and audit-chain integrity. A passing run writes [native-public-readonly-validation.json](native-public-readonly-validation.json).

## Generated artifact

`npm run build` creates `dist/index.html`, a self-contained ordinary-browser verification harness. Provider documents are intentionally not embedded because native execution depends on their distinct origins.
