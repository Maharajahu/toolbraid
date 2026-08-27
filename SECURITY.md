# Security Policy

ToolBraid is a competition prototype with deterministic providers. Do not connect it to real production infrastructure, public communications, credentials, payments, identity operations, or irreversible actions.

The primary invariant is that neither an agent nor a provider can create, widen, refresh, or replay a valid human approval.

Please report vulnerabilities privately to the repository owner. Include the affected commit, reproduction steps, expected and actual behavior, the relevant origin/tool/schema, and whether the issue involves discovery, quarantine, mapping, approval, execution, registry invalidation, or audit integrity. Do not test against systems or accounts you do not own.

See [docs/threat-model.md](docs/threat-model.md) for implemented controls and residual risks.
