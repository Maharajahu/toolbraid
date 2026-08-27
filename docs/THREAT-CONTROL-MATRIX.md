# Threat-control matrix

This is a concise control map for review and release evidence. “Contract”
means the repository requires the behavior; “operator” means the deployment
must provide it; “gap” means this MVP does not implement it. A contract is not
proof that a hosted environment has been configured correctly.

| Threat | Impact | Control | Owner / evidence |
| --- | --- | --- | --- |
| Confused deputy or tenant crossover | Action or data reaches the wrong tenant/user | Require explicit tenant, subject, and workflow identity; bind identity into policy and approval checks | Runtime contract; cross-tenant negative tests; external identity/authentication is a deployment gap (**operator**) |
| Stolen, stale, or replayed approval | Unauthorized mutation | Trusted server-side approval bound to revision, node, origin, adapter, capability ID/version, canonical argument hash, expiry, and single-use nonce | Security/runtime tests; atomic durable approval store is an operator requirement; default store is in-memory |
| Argument substitution after approval | Approved intent differs from executed intent | Canonicalize and hash arguments, compare at execution, fail closed on mismatch | Hash and execution tests |
| Malicious provider/page output | Prompt injection, unsafe routing, or data exfiltration | Treat metadata, page content, observations, and outputs as untrusted typed data; require explicit host/catalog capability records; do not promote provider descriptors; bound and sanitize adapter data | Adapter validation/adversarial tests; prompt-injection handling beyond typed boundaries remains a gap |
| Adapter downgrade or capability escalation | Lower-trust route or arbitrary click, shell, JavaScript, cookie, or filesystem access | Fixed `structured-api -> webmcp -> dom-accessibility -> vision` order; server-owned adapter bindings; raw primitives are not public; vision needs policy opt-in | Registry/planner tests and public-tool allowlist; browser worker enforcement is a gap |
| Secret leakage | Credential or session compromise | Redact secret-like keys in audit; do not return cookies/tokens or log raw provider content; scope and rotate secrets | Redaction tests; KMS/secret-manager/credential-vault integration is an operator gap |
| Mutation through replay | Duplicate external side effect | Replay allowlist contains read-only nodes only; replay never grants approval | Replay tests |
| Process or adapter denial of service | Unavailable service or exhausted resources | Bounded plan/adapter/workflow data, 64 global/32 session gateway calls, bounded stdio queues, and cooperative read cancellation | Repository admission tests; production rate limiting, tenant quotas, forced cancellation, worker isolation, and egress enforcement are gaps (**operator**) |
| Mutation timeout or cancellation ambiguity | External side effect commits after client timeout/cancel and is retried | Mutation paths withhold cancellation and reject non-cancelling in-process timeouts; reconcile rather than blindly retry | Execution tests; an isolated kill/reconciliation-capable worker is still required (**operator**) |
| Browser/profile crossover or unsafe egress | Credentials or actions reach the wrong profile/origin | Explicit origin binding and adapter checks | Browser worker/profile isolation, network egress allowlist, DNS/IP pinning, and credential vault are not implemented (**operator**) |
| Supply-chain or image compromise | Code execution or data exposure | Dependency-free runtime, source review, non-root image baseline | Dockerfile is not digest-pinned; container promotion is blocked until an immutable base digest and scan evidence exist (**operator**) |
| Audit tampering or unsafe retention | Loss of forensics or privacy exposure | Append-only event interface and redaction | Durable encrypted audit storage, access control, retention/deletion, and backup controls are operator gaps (**operator**) |

Residual risk remains where an operator has not supplied identity, transport,
durable state, secret management, resource controls, browser/profile
isolation, egress enforcement, or observability. The browser/demo adapter does
not reduce those risks and must not be used as a security boundary. This matrix
describes an MVP control plane, not production readiness.
