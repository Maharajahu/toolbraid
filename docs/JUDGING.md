# ToolBraid Judge Guide

## The problem in one sentence

WebMCP makes websites callable, but agents still face fragmented names, schemas, providers, risks and workflows.

## The product in one sentence

ToolBraid discovers those fragmented tools, maps them into common capabilities, composes them into an explainable plan, and preserves human authority over state-changing actions.

## The magic moment

During discovery, ToolBraid sees:

```text
SwiftRail.journey_lookup       → travel.search
NorthStay.rooms_lookup         → accommodation.search
MapWise.walk_time              → location.distance
ViaRail.hold_fare              → travel.hold
NorthStay.hold_room            → accommodation.hold
NorthStay.instant_free_checkout → QUARANTINED
```

It then generates one seven-node mission from those heterogeneous capabilities.

## What is dynamic

- Tool metadata is inspected at runtime.
- Capabilities are inferred from names, descriptions and schemas.
- Providers are ranked per capability.
- Read-only alternatives may be selected after failure.
- Dependencies are represented explicitly in a DAG.
- Approval is generated from the selected recommendation, not hardcoded before planning.

## What is deterministic

The challenge providers return stable synthetic data so judges can reproduce the same flow without API keys, commercial accounts or payment risk. Deterministic data is not the same as hardcoded orchestration: the normalizer, planner, executor, schema validator, fallback policy and approval binding are implemented as reusable modules.

## Safety demonstration

1. A provider publishes a tool description that asks the agent to ignore approval rules.
2. ToolBraid quarantines it before the planning stage.
3. Read-only nodes execute automatically.
4. The two mutation nodes remain blocked.
5. Calling the approved-execution tool before human approval returns `approval_required`.
6. The UI creates an approval record fingerprinted to the plan, providers, option IDs and prices.
7. The approval is consumed before the holds execute.
8. A second execution attempt returns `approval_replay_blocked`.

## WebMCP is central

Without WebMCP, the providers would require private API integrations or brittle visual automation. ToolBraid consumes provider-published tools, not DOM selectors. The system exists specifically to compose WebMCP capabilities across providers.

## Honest scope

- Four provider documents are included in the deterministic challenge harness.
- Holds are synthetic and reversible.
- No payment or final booking occurs.
- The native registration path activates when the browser exposes WebMCP.
- The compatibility path makes the exact same orchestration testable in ordinary Chromium.

## Suggested inspection order

1. Live app
2. `release/index.html`
3. `js/core/normalizer.js`
4. `js/core/planner.js`
5. `js/core/executor.js`
6. `js/core/approval.js`
7. `tests/`
8. `docs/e2e-release-validation.json`
