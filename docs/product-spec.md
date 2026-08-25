# ToolBraid Product Specification

**Version:** 0.1.0 challenge MVP
**Product thesis:** WebMCP makes individual websites agent-operable. ToolBraid makes those fragmented capabilities composable and accountable.

## 1. Problem statement

A user objective often spans multiple websites, but each site exposes different tool names, descriptions, parameter schemas, output shapes, authentication context, and risk semantics. A browser agent can discover tools yet still needs to answer five hard questions:

1. Which tools represent the same underlying capability?
2. How should provider-specific schemas be adapted?
3. In what dependency order should calls execute?
4. Which actions are safe to automate?
5. How can the person inspect and approve the plan?

Without a control layer, the agent either relies on brittle UI actuation or improvises across a flat list of tools.

## 2. Product statement

ToolBraid is a browser-native semantic orchestrator that converts a human goal into an explainable, cross-site capability graph.

```text
INTENT
  ↓
DISCOVERED WEBMCP TOOLS
  ↓
SECURITY SCAN + SEMANTIC NORMALIZATION
  ↓
CAPABILITY DAG
  ↓
READ-ONLY EXECUTION
  ↓
HUMAN CHECKPOINT
  ↓
APPROVED REVERSIBLE ACTIONS
  ↓
AUDITABLE RESULT
```

## 3. Target users

### Primary

- people delegating multi-site tasks to browser agents;
- developers exploring agent-native web experiences;
- WebMCP providers that want to remain inside the user-visible workflow.

### Secondary

- enterprise platform teams defining capability governance;
- accessibility workflows where an agent simplifies complex interfaces;
- browser and agent researchers evaluating tool composition.

## 4. Core jobs to be done

- “When my goal spans several websites, create one coherent plan rather than making me coordinate tabs.”
- “Show me why each provider tool was selected.”
- “Do the harmless research automatically, but never change external state without my approval.”
- “Keep the provider interfaces and authenticated browser state in the loop.”
- “Detect hostile or instruction-like tool metadata before it reaches the plan.”

## 5. Functional requirements

| ID | Requirement | MVP implementation |
|---|---|---|
| FR-01 | Discover tools dynamically from the active browser context | `document.modelContext.getTools()` through runtime adapter |
| FR-02 | Exclude ToolBraid's own tools from provider discovery | Namespace filter |
| FR-03 | Parse object or serialized JSON input schemas | `parseSchema()` |
| FR-04 | Map unfamiliar names/descriptions/schemas to canonical capabilities | Weighted explainable normalizer |
| FR-05 | Reject low-confidence mappings | Confidence threshold |
| FR-06 | Quarantine instruction-like metadata | Security pattern scanner |
| FR-07 | Classify risk | Annotation, semantic verbs, capability action |
| FR-08 | Build dependency-aware plan | Seven-node DAG for trip mission |
| FR-09 | Adapt canonical intent into provider-specific input fields | Alias-based schema adapter |
| FR-10 | Canonicalize incompatible provider outputs | Alias-based output adapter |
| FR-11 | Execute independent read-only calls concurrently | DAG executor with `Promise.all` |
| FR-12 | Compose and rank cross-provider options | Local candidate weave and budget/access scorer |
| FR-13 | Stop before all external state changes | Approval-gated nodes |
| FR-14 | Prevent an agent from self-authorizing | Approval record is generated only by UI action |
| FR-15 | Expose orchestrator operations through WebMCP | Four `toolbraid.*` tools |
| FR-16 | Maintain visible execution evidence | Mappings, audit, state inspector |
| FR-17 | Fail closed when a required capability is unavailable | `CAPABILITY_GAP` |
| FR-18 | Remain runnable without experimental browser support | Standards-aligned local test runtime |

## 6. Non-functional requirements

| Area | Requirement |
|---|---|
| Trust | Every plan node names its capability, provider tool, dependencies, risk, and status. |
| Safety | No state-changing tool executes without an approved node and human approval record. |
| Portability | Static assets, no backend, no API keys, no package install needed to run. |
| Reliability | Deterministic provider fixtures make the demonstration repeatable. |
| Performance | Discovery and planning complete in-browser; independent nodes execute concurrently. |
| Accessibility | Semantic headings, form labels, keyboard-accessible controls, visible status text. |
| Privacy | No credential, cookie, payment, or personal-profile storage. |
| Testability | Pure core modules, Node tests, browser E2E harness, programmatic snapshot API. |

## 7. Canonical capability model

The MVP ontology intentionally stays narrow:

| Capability | Type | Required concepts |
|---|---|---|
| `travel.search` | Read | origin, destination, date |
| `travel.hold` | Reversible | selected travel option ID |
| `accommodation.search` | Read | location, date |
| `accommodation.hold` | Reversible | selected stay ID |
| `location.distance` | Read | candidate locations, destination |

The architecture permits additional domain packs rather than one unbounded universal taxonomy.

## 8. Demo providers

| Website | Tools | Purpose |
|---|---|---|
| VectorRail | `seek_passages`, `freeze_quote` | Transport search and temporary fare hold |
| NestSquare | `scan_spaces`, `hold_space` | Accommodation search and temporary room hold |
| WalkMesh | `measure_access` | Walking access calculation |
| Mirage Deals | `trip_optimizer` | Adversarial metadata fixture that must be quarantined |

These are fully functional synthetic websites. They are independent iframe applications with their own UI, state, schemas, and WebMCP registration.

## 9. Primary user flow

1. User enters goal and constraints.
2. ToolBraid refreshes tool discovery.
3. Security scan runs before semantic normalization.
4. Mapping inspector shows confidence and evidence.
5. Planner verifies all required capabilities.
6. User or agent starts safe execution.
7. Search nodes run concurrently.
8. Local nodes compose candidates and add access evidence.
9. ToolBraid shows the selected mission and remaining budget.
10. Approval modal lists each external state change separately.
11. User approves or declines.
12. Approved holds execute and provider UIs update.
13. Inspector records the result and approval provenance.

## 10. Acceptance criteria

- At least three independent provider websites participate.
- At least five provider capabilities are dynamically mapped.
- At least one unfamiliar tool name maps correctly based on combined evidence.
- At least one malicious metadata fixture is quarantined.
- The plan contains dependencies and at least two parallel branches.
- Read-only work completes without approval.
- State-changing actions remain pending before approval.
- Calling `execute_approved_actions` without a UI approval performs no action.
- Total recommendation respects the stated budget.
- The full flow passes browser E2E validation without console errors.

All criteria currently pass in the deterministic demo.

## 11. Success metrics for a production pilot

- capability mapping precision and recall;
- percentage of plans completed without UI fallback;
- number of human interventions per mission;
- prevented unsafe calls;
- provider substitution success rate;
- schema-adaptation error rate;
- median planning and execution latency;
- user comprehension of approval preview;
- rate of reversals or disputed actions.

## 12. Explicit non-goals

- replacing provider websites or their checkout UI;
- scraping sites that do not expose authorized capabilities;
- executing purchases or irreversible transactions;
- credential vaulting or authentication bypass;
- claiming arbitrary-domain semantic coverage in the MVP;
- running fully autonomously without human visibility;
- simulating real booking inventory.

## 13. Roadmap

### Next

- multiple candidate tools per capability with provider failover;
- JSON Schema validation for inputs and outputs;
- signed provider identity and capability manifests;
- configurable policy packs by user and organization;
- cross-origin deployment with strict `exposedTo`/`fromOrigins` rules;
- pluggable embedding or local-model normalizer;
- plan recovery and compensation actions.

### Later

- community capability packs;
- provenance-weighted provider ranking;
- reusable mission templates;
- capability negotiation between browser agent and orchestrator;
- policy attestations and signed audit export.
