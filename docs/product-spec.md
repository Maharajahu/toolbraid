# Product Specification

## Product promise

ToolBraid converts one cross-site objective into an explainable, provider-neutral WebMCP execution graph with an enforceable human boundary around external effects.

## Primary user

An operator working with a browser agent during a high-consequence multi-system task. The operator wants the agent to collect and correlate evidence, but retain exact authority over production and public communication.

## Required behavior

| ID | Requirement |
|---|---|
| FR-01 | Discover only live tools from configured origins |
| FR-02 | Quarantine hostile metadata before capability mapping |
| FR-03 | Map heterogeneous names and schemas into the recovery ontology with inspectable evidence |
| FR-04 | Fail closed when a required capability is missing or ambiguous |
| FR-05 | Build a dependency-valid nine-node graph |
| FR-06 | Run independent safe reads concurrently and correlate exact GitHub commit SHAs with matching Vercel deployment metadata in the public profile |
| FR-07 | Substitute only eligible read-only alternatives |
| FR-08 | Finalize mutation arguments only from completed evidence |
| FR-09 | Require separate human approvals for the bounded recovery-lab rollback and GitHub issue #1 comment publication |
| FR-10 | Bind approval to plan, live tool identity, schema, arguments, effect, risk, expiry, and nonce |
| FR-11 | Revalidate the live registry immediately before mutation |
| FR-12 | Reject tampering, expiry, replay, unsafe retry, and idempotency conflicts |
| FR-13 | Expose ordered receipts and a verifiable sealed local integrity chain |
| FR-14 | Reset cleanly from success or failure without preserving authority |

In the public Vercel profile, provider pages call same-origin server functions that resolve the public `checkout` alias to allowlisted GitHub, Vercel, and recovery-lab health API targets. The deterministic local fixture catalog remains a development and test fallback only.

## Experience requirements

- the active graph and pulse routes react to execution events;
- provider substitution, quarantine, blocked mutations, approvals, and completion are visually distinct;
- exact evidence and receipts are readable without source inspection;
- desktop and mobile layouts avoid clipping and horizontal overflow;
- reduced-motion preferences disable nonessential motion;
- native and harness runtime modes cannot be confused.

## Out of scope

- arbitrary page automation or scraping;
- customer or business production credentials and infrastructure integration;
- irreversible actions;
- provider-specific branches in the engine;
- universal semantic coverage;
- publication, video, or submission claims before final readiness review.

The locked recovery scenario and security invariants are detailed in [Competition Product Definition](competition/product-definition.md).
