# ToolBraid

**A browser-native semantic and policy control plane for safe, explainable, human-approved WebMCP execution across sites.**

ToolBraid turns one human objective spanning several websites into a visible, explainable execution graph. It discovers live WebMCP tools, quarantines hostile metadata, maps incompatible contracts into canonical capabilities, executes safe reads, and stops before each external mutation until the human approves the exact origin, tool, arguments, and effect.

The current proof mission is production recovery:

> Restore checkout after the latest deployment. Find the safest recovery path and prepare a customer update, but do not change production or publish anything without my approval.

The judge deployment targets a disposable recovery lab: GitHub commit/incident data and Vercel deployment state are read live, while the two approved mutations perform a real rollback of that sandbox and append a real GitHub issue comment. Local development keeps deterministic fixtures so the engine and safety boundary remain reproducible without credentials. No customer or business production system is in scope.

[![ToolBraid completed production-recovery mission with six provider origins, verified mutations, and a sealed audit trail](docs/screenshots/toolbraid-recovery-completed.png)](docs/screenshots/toolbraid-recovery-completed.png)

*The implemented product after a deterministic recovery mission. Open the image for the full-resolution evidence view.*

**Judge path:** [Judge Guide](docs/JUDGING.md) · [Start Here](START-HERE.md) · [Live mutation receipt](docs/live-mutation-validation.json) · [Architecture](docs/architecture.md) · [Threat Model](docs/threat-model.md) · [Testing](docs/testing.md)

**Live demo:** [toolbraid-webmcp.vercel.app](https://toolbraid-webmcp.vercel.app)

## Why this matters

Most browser agents must infer what a website can do from page text, DOM structure, screenshots, and screen coordinates. That approach is fragile: a small interface change can break the workflow, and the agent may not know the exact arguments or side effects of the action it is attempting.

WebMCP lets participating websites expose named, schema-described actions with structured inputs and results. Instead of guessing where to click, an agent can request the exact operation the site supports.

ToolBraid is the orchestration and safety layer above those tools. It discovers capabilities across origins, normalizes incompatible provider contracts, quarantines untrusted metadata, executes safe reads, and requires a separate human approval for every external mutation. WebMCP makes website actions machine-readable; ToolBraid makes multi-site execution reliable, explainable, and accountable without allowing the agent to approve its own actions.

## ToolBraid Universal

The Universal extension extends that control plane to ordinary websites that have not implemented WebMCP. It observes the current page, builds a bounded DOM/ARIA snapshot, and registers a transparent local WebMCP surface inside the browser. Every generated tool is labelled `generated-by-toolbraid`; it is never presented as a native capability supplied by the website.

The generated surface includes a bounded read tool plus target-specific tools for the exact live links, controls, and forms that ToolBraid can identify unambiguously. Known GitHub, Vercel, and X page shapes can be recognized by versioned, fail-closed adapters. All generic interactions require an exact approval in extension-owned UI before the isolated runtime can change the page. Approval is bound to the tab, session, origin, page and target fingerprints, normalized arguments, predicted effect, expiry, and a one-time nonce.

Optional visual and audio analysis can enrich page evidence through an OpenAI-compatible endpoint configured by the user. The endpoint receives no authority: media stays behind short-lived extension-owned handles, credentials never enter the page context, and model output cannot approve or execute an action. Without a configured provider, Universal remains fully usable with deterministic DOM/ARIA and media metadata.

A generic receipt proves that the exact browser action was dispatched. It does not claim that a remote service completed the operation. Only a verified adapter with an observed postcondition may make that stronger claim.

Build the load-unpacked extension with:

```bash
node scripts/build-universal-extension.mjs
```

Then load `dist/toolbraid-universal-extension/` from `chrome://extensions` with Developer mode enabled. The production manifest requests no permanent website access; the user activates ToolBraid for the current tab, while an optional multimodal endpoint requires a separate exact-origin permission.

Run the deterministic Universal gates and the separate real MV3/WebMCP browser gate with:

```bash
npm run validate:universal
npm run test:universal:e2e
```

The gate launches Chromium with the native `document.modelContext` surface, loads a temporary copy of the production bundle, and proves real read, exact approval, value change, form POST, redacted receipt, audit persistence, SPA invalidation, and adversarial rejection paths. Its fixture-origin and debugger grants exist only in that disposable test copy; the production manifest is asserted to contain neither permanent host access nor debugger authority.

Universal E2E requires a Node Playwright module plus Chrome/Chromium. A non-standard installation can be supplied through `E2E_PLAYWRIGHT_MODULE` and `E2E_CHROME_PATH`; Python is needed only by the existing recovery-browser E2E commands.

The complete design and authority boundary are documented in [Universal Architecture](docs/universal-architecture.md).

## How ToolBraid works

[![ToolBraid execution story from one human objective through WebMCP discovery, semantic normalization, a nine-node plan, two exact approvals, ordered effects, and a sealed audit chain](docs/diagrams/toolbraid-how-it-works.svg)](docs/diagrams/toolbraid-how-it-works.svg)

## What the product proves

- six independently served provider origins;
- nine heterogeneous provider tools discovered at runtime;
- seven canonical capabilities and a nine-node dependency graph;
- hostile metadata quarantined before capability scoring;
- automatic fallback only for a failed read-only health provider;
- two-stage planning: evidence first, exact mutation arguments second;
- separate human approvals for recovery and customer communication;
- approval binding to plan revision, origin, tool, schema, arguments, effect, and one-time nonce;
- replay-safe completed mutations, browser nonce rejection, server-side target allowlists, signed short-lived recovery quotes, and registry-change invalidation;
- an append-only local SHA-256 integrity chain with a final seal.

## Runtime topology

[![ToolBraid cross-origin architecture showing the mission-control origin, six isolated WebMCP provider origins, read-only fallback, mutation domains, and a quarantined hostile fixture](docs/diagrams/toolbraid-cross-origin-architecture.svg)](docs/diagrams/toolbraid-cross-origin-architecture.svg)

In a supported browser, each provider calls `document.modelContext.registerTool(...)` from its own document. ToolBraid discovers the returned live registrations with an explicit origin allowlist and executes those opaque tool references.

Ordinary browsers can run the visibly labelled local verification harness. It mirrors the observable contract for deterministic development and E2E testing, but it is not presented as native-WebMCP compliance evidence.

## Run locally

Requirements: Node.js 20+. Browser E2E additionally needs Playwright and Chrome/Chromium; Python is used by the existing recovery-browser E2E commands, while Universal E2E uses the Node Playwright module.

```bash
# Ordinary-browser verification harness
npm run dev

# Native multi-origin topology (ports 4173-4179)
npm run dev:native
```

Open `http://127.0.0.1:4173`.

## Live deployment

The judge-facing mission-control application is live at:

```text
https://toolbraid-webmcp.vercel.app
```

It loads six independently deployed provider origins:

```text
https://toolbraid-signals-webmcp.vercel.app
https://toolbraid-pulse-webmcp.vercel.app
https://toolbraid-source-webmcp.vercel.app
https://toolbraid-deploy-webmcp.vercel.app
https://toolbraid-status-webmcp.vercel.app
https://toolbraid-mirage-webmcp.vercel.app
```

The live release uses seven separate Vercel projects. Only mission control is judge-facing; the provider URLs remain isolated documents loaded through the explicit WebMCP allowlist. Provider server functions hold the GitHub/Vercel credentials and expose only the exact `checkout` sandbox alias to the browser. The exact project map, environment contract, and reproducible release command are checked in under [Deployment](docs/deployment.md).

## Optional custom-domain artifact

The repository also retains a future branded-domain profile:

```text
https://app.toolbraid.dev
https://signals.toolbraid.dev
https://pulse.toolbraid.dev
https://source.toolbraid.dev
https://deploy.toolbraid.dev
https://status.toolbraid.dev
https://mirage.toolbraid.dev
```

`vercel.json` describes that optional single-project custom-domain topology. It routes the hosts to separate allowlisted static roots and applies the same origin-specific CSP and Permissions Policy used by the native local server. Build and verify the artifact with:

```bash
npm run build:vercel
npm run validate:vercel
```

The output is written to `dist/vercel-multi-origin/`. This build command does not deploy the seven active `.vercel.app` projects.

## Validate

```bash
npm run validate
npm run test:e2e
npm run test:native
```

`npm run validate` checks repository integrity, JavaScript syntax, all engine/provider/state tests, the static dependency graph, security headers, and the generated standalone harness. `npm run test:e2e` drives the real recovery mission at desktop and mobile sizes. `npm run test:native` uses installed Chrome with the experimental WebMCP surface enabled and proves that the same mission executes through the real `document.modelContext` API.

Latest checked E2E outcome:

```text
6 origins · 9 tools · 1 quarantined · 9 plan nodes
recovery release-1841 · notice notice-r9 · 54 audit entries
```

## Repository map

```text
src/engine/                 provider-neutral discovery, policy, graph, execution, approvals, audit
src/packs/recovery/         recovery ontology, adapters, and two-stage plan
src/providers/recovery/     provider catalog and deterministic local fixtures
providers/recovery/         six native provider documents plus same-origin live clients
server/live-services/       allowlisted GitHub, Vercel, health, signing, and HTTP services
api/                        scoped Vercel Function entrypoints for live providers
sandbox/recovery-lab/       disposable stable/degraded target for real rollback evidence
src/app/                    mission controller, state projection, constellation UI
src/universal/              bounded page snapshots, generated tools, policy, and execution contracts
src/site-adapters/          versioned fail-closed adapters for supported live page shapes
src/multimodal/             volatile media capture, evidence normalization, and provider contracts
src/runtime/                Universal session and dispatch lifecycle
src/persistence/            bounded approvals, receipts, and audit persistence
extension/                  MV3 worker, isolated runtime, MAIN-world registrar, and trusted side panel
tests/v2/                   unit, integration, security, and multi-origin contract tests
tests/universal/            Universal unit, protocol, security, adapter, and build tests
scripts/                    servers, checks, standalone/Vercel builds, capture, and browser E2E
video-production/           reproducible English voice-over, mastering, captions, and 1080p compositor ([runbook](video-production/README.md))
docs/                       architecture, threat model, test evidence, and challenge notes
```

## Human authority boundary

[![ToolBraid human-authority model showing the agent surface, trusted human approval creation, exact execution bindings, fail-closed invalidation, atomic nonce claim, ordered mutations, and audit sealing](docs/diagrams/toolbraid-human-authority.svg)](docs/diagrams/toolbraid-human-authority.svg)

Agent-callable actions may start discovery, execute safe reads, inspect state, or attempt execution of already approved nodes. They cannot create approval.

Approval creation is accepted only from a trusted human DOM activation. A synthetic `.click()` is rejected. Immediately before mutation, ToolBraid refreshes and rescans both live tools, verifies and atomically claims the full approval set, then executes recovery before publication. The local SHA-256 chain detects changes to the retained session record but is not a signed external audit log.

## Current scope

The engineering build is a native-validated release candidate. The public seven-origin profile can run entirely against the disposable GitHub/Vercel recovery lab; the local profile remains deterministic for repeatable tests. Public repository visibility, the public YouTube upload, and the final Devpost entry remain release gates tracked in [Challenge Requirements](docs/challenge-requirements.md).

See [Start Here](START-HERE.md), [Architecture](docs/architecture.md), [Threat Model](docs/threat-model.md), and [Testing](docs/testing.md).

## License

MIT. See [LICENSE](LICENSE).
