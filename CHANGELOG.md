# Changelog

All notable changes to ToolBraid are recorded here. The project is currently
pre-1.0; entries describe repository changes and do not imply production
availability.

## [Unreleased] — 2026-08-26

- Established the dependency-free Node.js/MCP rebuild contract in
  `docs/WORKPLAN.md`.
- Documented the non-production MVP boundary: six public tools only, explicit
  host/catalog capability authority, fixed adapter routing order, bounded
  admission, and cooperative cancellation.
- Recorded the remaining deployment gaps (external auth, durable state,
  KMS/secret vault, browser/profile isolation, egress enforcement, production
  rate limits, and an immutable container digest) in the security and release
  guidance.
- Added architecture, operator, release, security, and threat-control
  documentation for the contract and its deployment gaps.
- Added CI, release validation, and a non-root container baseline.

## [0.1.0]

- Initial repository scaffold.
