# ToolBraid Universal Architecture

## Product boundary

ToolBraid Universal is a browser extension and provider-neutral runtime that adds a transparent, generated WebMCP surface to ordinary websites inside the user's browser. It does not claim that the website itself implemented WebMCP. Every generated registration carries `generated-by-toolbraid` provenance and an explicit confidence and policy tier.

The existing recovery application remains a first-party native-WebMCP proof pack. Universal support is additive and cannot weaken its origin, approval, replay, or audit invariants.

## Non-negotiable invariants

1. Native site-provided WebMCP tools always remain distinguishable from ToolBraid-generated tools.
2. Page content, accessible names, metadata, media, and model output are untrusted data.
3. Reading may execute automatically within granted browser permissions.
4. Every interaction on an unverified page requires a human-owned approval. This includes filling a field because page JavaScript may autosave or submit reactively.
5. Approval binds the exact tab, top-level origin, page fingerprint, target fingerprint, action, normalized arguments, effect, expiry, and one-time nonce.
6. Navigation, DOM drift, target drift, argument drift, or a changed native WebMCP registry invalidates approval. Universal capability-pack state is re-resolved when the current page is ingested.
7. The page cannot create approval. Approval originates only in extension-owned UI.
8. Mutation execution is performed by the isolated extension world after revalidation, never by page-controlled code.
9. Unknown effects fail closed as mutations. Ambiguous targets are never clicked automatically.
10. Multimodal inference cannot directly execute an action; it may only enrich evidence used to prepare one.
11. A browser receipt proves exact dispatch. External success is reported only when a verified adapter also proves its declared postcondition.

## Runtime topology

```text
extension-owned side panel / approval surface
                    |
                    v
        MV3 service worker and session store
          |              |               |
          |              |               +--> multimodal adapters
          |              +--> policy, approval, audit
          +--> isolated content runtime
                       |
                       +--> DOM/ARIA snapshot + action executor
                       |
                       +--> guarded MAIN-world WebMCP registrar
                                  |
                                  +--> document.modelContext.registerTool()
```

The MAIN-world registrar is intentionally small. It advertises descriptors and forwards calls across a per-document channel. It does not hold approval authority, credentials, durable state, or mutation policy. The isolated content runtime and service worker treat every MAIN-world request as attacker-controlled.

The service worker owns a statically trusted, lazily loaded capability-pack registry. It also coordinates bounded multi-page mission membership and the browser-independent human-handoff state machine; page or binding drift invalidates pending work and a restart requires rebind.

## Compatibility tiers

| Tier | Source | Default authority |
|---|---|---|
| Native | Website registers WebMCP itself | Existing ToolBraid policy applies |
| Verified adapter | Versioned ToolBraid adapter for an exact known host and page shape | Reviewed reads and narrowly scoped actions |
| Generated read | Deterministically synthesized from the current page | Read-only |
| Generated interaction | Fill/select/click/navigation/submit with an untrusted effect | Exact human approval required |
| Ambiguous or high-impact | Weak target identity, unknown effect, credential/access/payment/destructive semantics | Blocked until a verified adapter exists |

## Universal page model

A `PageSnapshot` is a serializable, bounded observation containing:

- session, tab, frame, URL, origin, title, language, timestamps, and navigation generation;
- page and DOM fingerprints;
- main text, headings, landmarks, structured data, links, and selection;
- forms and accessible controls with stable element references;
- media assets and optional multimodal enrichments;
- provenance, truncation, confidence, and untrusted-content markers.

An element reference is not a raw selector. It combines frame identity, semantic role, accessible name, form ownership, selected stable attributes, relative structure, and a target fingerprint. Resolution must produce exactly one matching live element at execution time.

## Generated tool surface

The generic surface is deterministic and target-specific rather than a set of broad aggregate commands:

- one read-only page tool containing bounded metadata, headings, and main text;
- one approval-gated descriptor for each unique live form, non-form control, and link;
- a strict JSON schema derived from the exact target's current fields;
- provenance containing the generator version, origin, page fingerprint, element reference, and target fingerprint.

Built-in capability packs may add narrow names only when the exact supported page shape is present. X exposes `read_x_post`, approval-gated `like_x_post`, reversible `prepare_x_reply` when a matching reply editor is present, and approval-gated `repost_x_post` when a matching positive confirmation item is live. GitHub exposes repository star/unstar, issue or pull-request comment, and close/reopen actions. Vercel exposes deployment redeploy/cancel actions. These are browser UI dispatches, not direct provider API calls. GitHub and Vercel descriptors carry page-snapshot postconditions whose verifiers are wired in the MV3 service worker; generic and X actions remain dispatch-unverified. X scoping is strongest for status-permalink reads and likes; reply/repost matching remains heuristic, and known opposite or already-completed controls are suppressed. Adapter targets suppress equivalent generic targets. The core combined live registry is capped at 128 tools and the shipped MV3 runtime at 32; overflow, duplicates, invalid descriptors, and policy failures are quarantined rather than registered.

## Action lifecycle

```text
observe current snapshot
  -> resolve one exact target
  -> classify read / approval-gated interaction / blocked
  -> prepare normalized action and predicted effect
  -> show extension-owned approval UI when required
  -> bind approval to current fingerprints and arguments
  -> refresh page snapshot and bound target
  -> atomically claim nonce
  -> execute in isolated content runtime
  -> append a redacted dispatch receipt and audit entry
  -> verify a declared postcondition when a verified adapter provides one
```

Generic input is never written before approval. The action executor refreshes the snapshot, resolves exactly one live element, checks semantic binding and fingerprints, atomically claims the one-time approval nonce, and only then applies the approved value, click, or form submission.

A generic receipt deliberately says that an action was dispatched; it does not claim that a remote service accepted or completed the operation. Generic and X actions remain postcondition-unverified. Built-in GitHub and Vercel mutations carry declared page-snapshot contracts, and the MV3 service worker wires their verifiers. A verified result means the declared browser-observable transition was seen; for Vercel redeploy, that can mean a new same-commit deployment in an accepted state, not necessarily a completed deployment.

Dispatch is recorded as a two-step extension-owned transition: `dispatching` before the isolated-world call and `dispatched` after the browser accepts that call. Either state deliberately leaves the external outcome unknown unless a verified adapter subsequently observes its declared postcondition. A service-worker restart cannot turn an interrupted dispatch into a success claim or replay the approval nonce.

## Navigation and SPA lifecycle

Authority is bound to a concrete top-level origin, document identity, page-instance nonce, snapshot fingerprint, and navigation generation. A cross-origin loading event invalidates the session immediately. Same-origin URL changes are not treated as proof of a new document because Chrome also emits them for `history.pushState`; instead, a new document replaces authority only when the injected page runtime announces a new document/page-instance identity. DOM or history changes within an SPA produce a new acknowledged snapshot generation, replace generated registrations, clear stale pending actions and multimodal evidence, and make captured `RegisteredTool` objects from the prior fingerprint unusable.

Snapshot delivery is acknowledged rather than fire-and-forget. If the service worker rejects or misses an ingest, the isolated content runtime retries the same fingerprint until it receives `{ ok: true }`; it never marks an unacknowledged snapshot as current.

The isolated content runtime also holds a validated lifecycle Port and sends a bounded `PAGE_READY` heartbeat. Closing the side panel does not revoke the active tab session. If the MV3 worker disconnects or restarts, the content runtime reconnects, replaces the MAIN-world binding, and submits a fresh snapshot before servicing a subsequent call. A mutation interrupted during that transition fails once and is never replayed automatically.

## Multimodal pipeline

Multimodal analysis is evidence production, not authority:

```text
visible-tab screenshot + bounded DOM media inventory
  -> policy and size limits
  -> privacy/redaction hooks
  -> image OCR and visual description adapter
  -> audio transcription adapter
  -> optional injected video composite adapter
  -> normalized evidence with provider/model provenance
  -> attach to PageSnapshot
```

The browser capture layer stores bytes in extension-owned volatile handles with size, count, timeout, origin, and TTL limits. It captures the visible tab and may read same-origin caption tracks; explicit reanalysis can capture rendered audio. The shipped MV3 provider analyzes image and captured-audio bytes, while video remains metadata/caption-only and is not decoded or uploaded. Raw bytes are zeroed when released. Adapters may be local or remote, but credentials remain outside page and MAIN-world contexts. Cache identity includes asset fingerprint, context/transformation settings, and adapter identity/version; the shipped key does not include the configured model name. Failed modalities degrade independently and remain visible in the result. Capture and DOM/action traversal are bound to top-level frame 0; child iframe documents are not traversed, and rendered audio capture rejects encrypted media (`mediaKeys`) with `DRM_MEDIA_UNSUPPORTED`.

## Persistence

Extension storage keeps bounded session metadata, approvals, receipts, adapter versions, and the audit chain. Raw page text, media, and capture handles are not durably retained by this implementation; any future durable raw retention would require an explicit user setting and redaction.

## Compatibility and release gates

The recovery validation suite must remain green at every integration point. Universal releases additionally require:

- unit tests for snapshot bounds, fingerprints, target uniqueness, tool schemas, risk upgrades, drift invalidation, and multimodal degradation;
- extension protocol tests for navigation, replay, forged messages, disconnected frames, and service-worker restart;
- browser tests for static pages, SPA navigation, open Shadow DOM, approved value changes, approved submission observed by the fixture server, built-in GitHub/Vercel postcondition verification, and an explicit `postcondition-unverified` receipt for unverified generic or X dispatch;
- adversarial tests for prompt injection in content, accessible names, schemas, OCR, transcripts, and model output;
- a live-site matrix with explicit results rather than a universal-coverage claim. Current checks include passed read-only real GitHub repository and issue reads plus real Chrome rendered-audio/caption capture; no live-site mutation is claimed.

The executable browser gate is `node scripts/e2e-universal-extension.mjs --json`. It loads the real MV3 service worker, production MAIN/ISOLATED scripts, authentic side panel, and native Chrome WebMCP surface. A disposable copy of the built extension receives a local fixture-origin grant and temporary `debugger` permission only so automation can issue genuine trusted side-panel clicks. Before launch, the gate asserts that the production manifest contains neither permanent `host_permissions` nor `debugger`; the temporary authority is never written back to the source or production build and the copy is deleted after the run.
