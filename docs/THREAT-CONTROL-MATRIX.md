# Threat-control matrix

This is a concise control map for review and release evidence. “Contract”
means the repository requires the behavior; “operator” means the deployment
must provide it. A contract is not proof that a hosted environment has been
configured correctly.

| Threat | Impact | Control | Owner / evidence |
| --- | --- | --- | --- |
| Confused deputy or tenant crossover | Action or data reaches the wrong tenant/user | Require explicit tenant, subject, and workflow identity; bind identity into policy and approval checks | Runtime contract; cross-tenant negative tests; edge auth (**operator**) |
| Stolen, stale, or replayed approval | Unauthorized mutation | Trusted server-side approval bound to revision, node, origin, adapter, canonical argument hash, expiry, and single-use nonce | Security/runtime tests; atomic approval store (**operator**) |
| Argument substitution after approval | Approved intent differs from executed intent | Canonicalize and hash arguments, compare at execution, fail closed on mismatch | Hash and execution tests |
| Malicious provider/page output | Prompt injection, unsafe routing, or data exfiltration | Treat metadata, page content, observations, and outputs as untrusted typed data; never execute instructions from them | Adapter validation/adversarial tests |
| Capability escalation | Arbitrary click, shell, JavaScript, cookie, or filesystem access | Expose semantic capabilities only; keep raw primitives private; enforce policy at the broker | Public-tool allowlist and source review |
| Secret leakage | Credential or session compromise | Redact secret-like keys in audit; do not return cookies/tokens or log raw provider content; scope and rotate secrets | Redaction tests; secret-manager/config review (**operator**) |
| Mutation through replay | Duplicate external side effect | Replay allowlist contains read-only nodes only; replay never grants approval | Replay tests |
| Process or adapter denial of service | Unavailable service or exhausted resources | Request limits, timeouts, rate limits, quotas, bounded concurrency, and origin egress policy | Edge/runtime configuration (**operator**) |
| Supply-chain or image compromise | Code execution or data exposure | Dependency-free runtime, review lock/config changes, non-root minimal image, digest pinning and image scanning | CI, Dockerfile, scan record (**operator**) |
| Audit tampering or unsafe retention | Loss of forensics or privacy exposure | Append-only event interface, access control, retention/deletion policy, encrypted durable storage | Audit implementation; storage and backup controls (**operator**) |

Residual risk remains where an operator has not supplied identity, transport,
durable state, secret management, resource controls, or observability. The
browser/demo adapter does not reduce those risks and must not be used as a
security boundary.
