# Security Policy

## Supported version

Security fixes target the current `main` branch. Older commits and locally
modified extension builds are not supported.

## Security boundary

ToolBraid is an experimental WebMCP control plane, not a general-purpose
credential manager or autonomous production operator. The public judge profile
is restricted to an allowlisted, disposable GitHub/Vercel recovery lab. Do not
connect a modified build to infrastructure, accounts, or data you do not own.

The Universal extension uses per-tab activation, exact page/session bindings,
extension-owned approval state, and a local authenticated MCP bridge. Login,
2FA, and CAPTCHA remain human handoffs; credentials and one-time codes must stay
inside the approved website.

The primary invariant is that neither an agent nor a provider can create, widen, refresh, or replay a valid human approval.

## Reporting

Do not open a public issue for a suspected vulnerability. Use GitHub's
[private vulnerability report](https://github.com/Maharajahu/toolbraid/security/advisories/new)
or contact the repository owner privately through GitHub. Include the affected
commit, reproduction steps, expected and actual behavior, the relevant
origin/tool/schema, and whether the issue involves discovery, quarantine,
mapping, approval, execution, registry invalidation, native messaging, or audit
integrity.

Do not test against systems or accounts you do not own. Never include a real
password, API key, browser profile, session cookie, OTP, or private URL in a
report.

See [docs/threat-model.md](docs/threat-model.md) for implemented controls and residual risks.
