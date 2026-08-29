# ToolBraid Universal (Chrome MV3)

ToolBraid Universal converts the active HTTP(S) page into a bounded, explicit
WebMCP surface inside the user's browser. The generated tools are visibly
labelled `generated-by-toolbraid`; the extension never claims that an ordinary
website implemented WebMCP itself.

## Permissions

The extension is user-activated and requests only:

- `activeTab` to inspect and capture the page the user explicitly activates;
- `scripting` to install the MAIN- and ISOLATED-world bridge on that tab;
- `storage` for extension-owned approvals, redacted receipts, and the integrity chain;
- `sidePanel` for the trusted control and approval surface.

There are no host permissions granted at install time, tab-history permission,
web-request interception, externally connectable entry points, or
page-accessible secrets. If the user enables an OpenAI-compatible analysis
provider, Chrome asks for optional access to that exact endpoint origin only.
The manifest declares a broad optional HTTPS pattern solely so a user may choose
their own provider; that declaration grants no site access by itself. Runtime
permission requests are reduced to the provider URL's exact origin.

## Runtime boundary

```text
extension side panel (trusted human gestures)
        | strict UI message allowlist
MV3 service worker (sessions, policy, approval ledger, audit)
        | tab + frame + origin + session + nonce binding
ISOLATED content runtime (snapshot and exact live execution)
        | same-window, same-origin, nonce-bound protocol
MAIN-world registrar
        | document.modelContext.registerTool()
generated page tools
```

The MAIN-world registrar contains no credentials, approvals, durable state, or
mutation policy. Page callbacks are treated as attacker-controlled input. A
navigation, page drift, target drift, argument drift, expiry, or replay
invalidates execution. Native WebMCP registry drift invalidates approvals;
Universal capability-pack state is rebuilt when the current page is ingested. A
service-worker disconnect invalidates an in-flight action, but the isolated
runtime may establish a fresh binding for a later call.

Generic page interaction is conservative: reads may run automatically, while
field changes, clicks, navigation, and form submission all require a fresh
approval created by a trusted click in the extension side panel. A receipt
proves exact browser dispatch; it is not described as remote success unless a
verified adapter proves its declared postcondition. The service worker wires
the built-in GitHub and Vercel page-snapshot verifiers plus X like/repost
verifiers; generic actions remain postcondition-unverified and X reply is
stage-only.

The shipped MV3 runtime selects three statically trusted, lazily loaded
capability packs — `site.x`, `site.github`, and `site.vercel` — by exact HTTPS
host/path and objective hints. Page snapshots cannot add or replace loaders;
invalid, duplicate, overflow, and policy-failed descriptors are quarantined.
The core combined registry allows up to 128 tools, while the shipped MV3
runtime limits active and registered tools to 32.

## Session recovery

The isolated content runtime keeps a validated MV3 lifecycle Port open and
sends a bounded `PAGE_READY` heartbeat. Closing the side panel does not end the
active tab session. After a service-worker disconnect or restart, the runtime
reconnects, replaces the MAIN-world page binding, and submits a fresh snapshot
before the next invocation. It never retries an in-flight mutation.

Universal supports bounded multi-page missions with up to 16 exact tab/frame
members. Page drift invalidates pending actions and a worker restart requires
rebind; pending actions are not restored. The handoff broker supports login,
2FA, and CAPTCHA steps with a five-minute default and fifteen-minute maximum
TTL, exact-origin side-panel-created surfaces, and separate trusted
open/complete proof. Credentials are not stored.

For CAPTCHA, one trusted user gesture may dispatch exactly one checkbox click
only when the active handoff surface contains one unchecked, visible, top-frame
checkbox with explicit CAPTCHA markers. ToolBraid does not traverse CAPTCHA
iframes or solve challenge flows. Missing or ambiguous markers, iframe widgets,
site rejection, and any remaining challenge keep the handoff with the user.

Activation and page injection are bound to top-level frame 0; child iframe
documents are not traversed. Rendered capture supports bounded visible video
keyframes, optional rendered audio, and loaded captions. It fails closed for
encrypted media (`mediaKeys`), invisible targets, invalid bounds, binding drift,
page drift, or target drift.

## Multimodal evidence

Activation captures a bounded visible-tab screenshot and eligible same-origin
caption tracks. Explicit reanalysis can capture bounded keyframe images from a
visibly rendered top-frame video, optional rendered audio, and loaded captions.
Raw video streams and URLs are not sent to the provider. The real Chrome gate
exercises keyframe, audio, caption, and narrowly scoped CAPTCHA paths against
local fixtures without claiming arbitrary authenticated-SaaS completion. Media
bytes live only in extension-owned volatile handles with size, count, timeout,
and TTL limits and are zeroed on release.
Multimodal output is untrusted evidence: it may enrich a snapshot but can never
approve or execute an action. Metadata-only evidence is the default. The side
panel can connect an optional OpenAI-compatible vision/ASR endpoint; its API key
is kept in extension session storage rather than durable page-accessible state.

## Build and load

```bash
node scripts/build-universal-extension.mjs
```

Then open `chrome://extensions`, enable Developer mode, choose **Load unpacked**,
and select `dist/toolbraid-universal-extension`. Open an HTTP(S) page and click
the ToolBraid extension action. Chrome opens the side panel and activates a
session for that tab.

The build copies only the files reachable from the extension manifest and
verifies that every local import is included. `protocol-runtime.js` mirrors the
wire validation in `protocol.js` for classic injected-script worlds; changes to
either protocol must keep both implementations behaviorally identical.

## Real browser gate

```bash
node scripts/e2e-universal-extension.mjs --json
```

This launches the built MV3 extension against local HTTP fixtures and Chrome's
native WebMCP surface. The disposable E2E bundle receives only a fixture-origin
host grant and temporary `debugger` permission so the test can perform genuine
trusted clicks in the authentic side panel. The script first asserts that the
source manifest contains neither `host_permissions` nor `debugger`; those test
grants never ship in the production bundle, and the disposable copy is removed
after the run. The gate exercises bounded rendered-video keyframes, optional
rendered audio, loaded captions, and exactly one visible top-frame CAPTCHA
checkbox click on local fixtures. A separate `--live-read-only` mode has passed
real GitHub repository and issue reads without external dispatch; no live-site
mutation or arbitrary authenticated-SaaS completion is claimed.
