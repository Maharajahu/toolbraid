# ToolBraid Final Validation Report

**Release date:** 26 August 2026  
**Overall engineering status:** PASS  
**Public production URL:** https://toolbraid-dumitrescu91dan-7167.vercel.app/

## Release scope

ToolBraid is a WebMCP semantic orchestration demonstration. It discovers six provider tools from four provider identities, maps incompatible names to canonical capabilities, quarantines hostile tool metadata, builds a seven-node dependency graph, executes read-only work, and requires a human-created approval before two synthetic reversible holds.

The demonstration does not purchase, book, transfer money, or use real provider accounts. Mutation results are synthetic and intentionally reversible.

## Automated validation

| Validation layer | Result |
|---|---:|
| Project structure and JavaScript syntax | PASS |
| Unit and security tests | 21/21 PASS |
| Modular build, desktop E2E | PASS |
| Modular build, mobile E2E | PASS |
| Single-file release, desktop E2E | PASS |
| Single-file release, mobile E2E | PASS |
| Vercel bootstrap artifact, desktop E2E | PASS |
| Vercel bootstrap artifact, mobile E2E | PASS |
| Clean extraction from source ZIP | PASS |
| Git bundle verification | PASS |
| Submission ZIP integrity | PASS |
| SHA-256 manifests | PASS |
| Demo video technical validation | PASS |

## End-to-end assertions

The browser validation verifies all of the following:

- four provider identities are present;
- six tools are discovered;
- one hostile tool is quarantined;
- a seven-node plan is created;
- five read-only nodes complete before approval;
- the selected bundle totals £184.90 against a £250 budget;
- the selected hotel is 13 minutes on foot from the destination;
- an agent cannot create or substitute human approval;
- approval is SHA-256-bound to the plan, providers, option IDs and prices;
- approval is consumed before mutation;
- two synthetic hold IDs are created only after approval;
- a second execution attempt is blocked as an approval replay;
- no material browser console errors occur;
- the 390 × 844 mobile layout has no horizontal overflow.

## WebMCP interface

The release registers provider-facing tools and these orchestration tools when a supported `document.modelContext` or `navigator.modelContext` runtime is available:

- `toolbraid_plan`
- `toolbraid_execute_safe`
- `toolbraid_status`
- `toolbraid_execute_approved`

There is deliberately no tool that grants approval. Approval can only originate from the human interface.

## Security controls

- Tool metadata is treated as untrusted input.
- Hostile instruction patterns are quarantined.
- Input and canonical output schemas are validated.
- Automatic provider fallback is limited to read-only operations.
- Mutating operations do not silently switch providers.
- Human approval is bound to the exact execution proposal.
- Approval is single-use and replay-protected.
- Changes after approval invalidate the execution.

## Deployment evidence

The production alias is `https://toolbraid-dumitrescu91dan-7167.vercel.app/`. The final single-file artifact in `release/index.html` is the same release content submitted to Vercel and validated locally with desktop and mobile E2E tests.

## Remaining account-controlled publication gates

These are not product-development failures. They require the owner's public platform identity:

1. Create or select a public GitHub repository and push the verified Git bundle/source.
2. Upload the validated MP4 publicly to YouTube.
3. Enter the live URL, repository URL and YouTube URL in Devpost, then submit.

Until those account-controlled actions are completed, the product is release-ready but the challenge entry is not formally submitted.
