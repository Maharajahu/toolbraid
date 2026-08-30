# ToolBraid Threat Model

## Security objective

Neither an agent nor a provider may cause an external mutation that the human did not knowingly approve in its exact current form.

All provider metadata, schemas, annotations, outputs, and messages are untrusted. Browser origin is part of identity, but origin alone is not sufficient authorization.

[![ToolBraid authority model showing trusted human approval, exact execution binding, fail-closed invalidation, and the verified mutation commit path](diagrams/toolbraid-human-authority.svg)](diagrams/toolbraid-human-authority.svg)

## Assets and boundaries

- provider account and application state;
- the human's objective and evidence;
- live tool identity and schema;
- plan revision and exact mutation arguments;
- approval authority and one-time nonces;
- receipts and audit-chain integrity.

Trusted authority is limited to a genuine top-level human UI activation. Agent calls, provider content, synthetic DOM events, and local-runtime fixtures are not approval authority.

## Threats and implemented controls

| Threat | Implemented control |
|---|---|
| Metadata prompt injection | scan before scoring; severe patterns quarantine the tool; quarantined candidates cannot map or enter the graph |
| Misleading risk annotations | capability policy can increase restrictions and does not trust provider hints alone |
| Schema/identity swap | SHA-256 schema fingerprint plus exact origin/name/generation; live registry refresh before mutation |
| Confused deputy | exact plan revision, node, capability, arguments, and effect are fingerprint-bound |
| Agent self-approval | no approval creator in the public automation surface; only trusted DOM activation is accepted |
| Synthetic UI activation | `event.isTrusted` guard; Playwright verifies synthetic `.click()` cannot approve |
| Partial approval ambiguity | separate visible envelopes are verified and claimed as one all-or-none set before execution |
| Approval tampering or expiry | canonical serialization, SHA-256 fingerprint, strict field set, TTL validation |
| Replay or duplicate mutation | browser nonce atomically claimed before await; the live sandbox revalidates Vercel state and uses a hashed GitHub marker to make completed retries observable and replay-safe |
| Unsafe automatic failover | alternatives are allowed only for read-only nodes; mutations fail closed |
| Registry change after planning | generation is rechecked around each async refresh, metadata is rescanned, and validity is asserted immediately before each mutation |
| Malformed provider output | capability-specific canonicalizers accept only expected structured fields |
| Cross-origin data leakage | explicit origin allowlist, scoped arguments, provider CSP, frame sandbox, `exposedTo` policy |
| Audit rewriting | local previous-hash chain and final seal expose edits inside the retained session record; no authenticity claim |
| Hanging execution | abort signals propagate through client and providers |
| Ambient local access to the Codex bridge | no TCP listener; Native Messaging allowlists one stable extension origin; the named pipe requires a 256-bit token stored in an ACL-restricted per-user directory |
| Stale MCP tool replay | every proxy is held extension-side and exact-bound to tab, session, origin, page fingerprint, descriptor fingerprint, and tool name; lifecycle changes clear the handle set |
| Agent mutation authority through MCP | the MCP contract exposes status, listing, safe reads, and action preparation only; approval creation and dispatch are absent and remain trusted side-panel gestures |

## Adversarial provider

The Mirage provider registers instruction-like metadata that asks the orchestrator to bypass approval and disclose data. Expected behavior:

1. discovery records the live tool and origin;
2. the risk scanner records the reason codes;
3. the tool is quarantined before semantic scoring;
4. no mapping or graph node can select it;
5. the UI and audit show the quarantine.

## Mutation policy

| Class | Policy |
|---|---|
| Read-only evidence | may execute after planning; mapped read fallback allowed |
| Reversible preparation | may prepare a quote/draft but cannot produce the external effect |
| External mutation | exact human approval required; no automatic retry or provider substitution |
| Irreversible/high-impact | out of scope and denied |

## Live sandbox boundary and privacy

The local profile uses synthetic incident and deployment data. The judge profile adds narrowly scoped Vercel Functions that call GitHub and Vercel with server-side credentials. Those credentials never enter provider HTML, browser tool arguments, responses, logs, or Git; the browser can request only the public alias `checkout`, which resolves server-side to one repository, one issue, one Vercel project, and one health URL.

`x-toolbraid-intent: approved` is a same-origin request signal, not user authentication and not an anti-forgery security boundary. The public mutation endpoints therefore target only a disposable lab with no customer data or business dependency. Signed short-lived recovery quotes, exact project/alias checks, version revalidation, bounded bodies, and post-rollback polling constrain impact. GitHub comment markers and Vercel state checks make completed retries replay-safe, but without a durable transactional lock they do not claim cross-instance exactly-once execution.

## Residual risk

This is not a production security boundary. Pattern-based metadata scanning cannot detect every semantic attack; the in-memory approval/audit stores do not survive page loss and their unkeyed hash chain proves local integrity rather than authorship; provider origins are allowlisted but are not signed organizations; and live authority is intentionally limited to the disposable GitHub/Vercel lab. Production use would require operator authentication, durable transactional idempotency and approval storage, signed provider identity, an externally anchored or server-signed audit head, rate limits, redaction, CSP/Trusted Types hardening, compensation strategy, and an external security review.
