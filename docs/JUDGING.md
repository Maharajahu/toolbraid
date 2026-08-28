# Judge Guide

**Live demo:** [toolbraid-webmcp.vercel.app](https://toolbraid-webmcp.vercel.app)

## The proof mission

Restore checkout after the latest deployment and prepare a customer update, while keeping both production and public communication under separate human authority.

[![Completed ToolBraid production-recovery mission with six provider origins, two verified mutations, receipts, and a sealed audit trail](screenshots/toolbraid-recovery-completed.png)](screenshots/toolbraid-recovery-completed.png)

## System at a glance

[![ToolBraid turns one human objective into safe WebMCP evidence, a nine-node plan, two exact approvals, ordered effects, and sealed local audit evidence](diagrams/toolbraid-how-it-works.svg)](diagrams/toolbraid-how-it-works.svg)

## What to observe

1. **WebMCP leverage:** six provider documents contribute nine live tools from explicit origins. ToolBraid retains and executes the opaque registered objects rather than calling provider functions directly.
2. **Semantic interoperability:** unfamiliar names and schemas become seven canonical capabilities, with confidence and evidence visible in the inspector.
3. **Execution:** four live evidence reads run concurrently. The same planner supports a heterogeneous read-only fallback, proven by the deterministic local failure test without manufacturing an outage in the public lab.
4. **Safety:** hostile metadata is quarantined before scoring. Mutation arguments remain deferred until safe evidence is complete.
5. **Human collaboration:** production recovery and status publication each show exact origin, tool, schema-bound arguments, and effect in separate approval dialogs.
6. **Integrity:** synthetic approval attempts fail, registry changes invalidate the plan, both browser nonces are claimed atomically, recovery completes before publication, live services enforce exact sandbox targets and replay-safe state checks, and the local integrity chain is sealed.

## Expected completed state

```text
providers:       6 origins
tools:           9 discovered
quarantine:      1
capabilities:    7
graph:           9 nodes
recovery result: release-1841
notice result:   notice-r9
audit:           sha256-chain-v1, 54 entries
```

In the judge deployment, GitHub and Vercel reads are live. The recovery action rolls the disposable Vercel recovery lab back to its immediately previous production deployment, and the communication action appends a real comment to one dedicated GitHub incident issue. Local runs use deterministic fixtures. The proof never targets a customer or business production system.

Native and harness runs are visibly labelled. Only a run whose badge reads **Native WebMCP** is native API evidence.

The public release passed native Chrome 151 read-only validation across all six provider origins; see [native-public-readonly-validation.json](native-public-readonly-validation.json). The automated public gate stops at review because trusted human activation is part of the mutation-authority proof.

## Why the boundary is credible

[![ToolBraid human-authority boundary and fail-closed execution policy](diagrams/toolbraid-human-authority.svg)](diagrams/toolbraid-human-authority.svg)

The runtime topology, origin allowlist, fallback path, mutation domains, and quarantined provider are shown in the [cross-origin architecture](diagrams/toolbraid-cross-origin-architecture.svg).

## Official criteria coverage

- **WebMCP Leverage:** multi-origin registration, explicit exposure/discovery, opaque handle execution, cancellation, tool-change invalidation, and native Chrome evidence.
- **Execution:** a coherent objective-to-evidence-to-approval-to-receipt product flow with desktop, mobile, keyboard, CSP, failure, and partial-outcome validation.
- **Potential Impact:** one control plane reduces the risk and cognitive load of coordinating consequential work across incompatible sites while preserving human authority.
- **Creativity & Ambition:** semantic capability normalization turns the open web's heterogeneous tools into a visible cross-site execution graph without replacing provider-owned contracts.

The official criteria are equally weighted. Claims above describe implemented evidence, not a predicted judge score.
