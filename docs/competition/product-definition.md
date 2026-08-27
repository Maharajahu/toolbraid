# ToolBraid Competition Product Definition

**Status:** implemented product direction; final readiness not yet declared
**Product:** browser-native semantic and policy control plane for WebMCP
**Submission deadline:** 3 September 2026, 21:00 BST

## Product promise

ToolBraid turns a human objective that spans several websites into one visible,
explainable, and human-authorized execution graph.

It does not replace websites and it does not automate arbitrary pages. It works
with capabilities that participating websites deliberately expose through
WebMCP, preserving each site's authenticated browser context and visible UI.

[![ToolBraid product flow from objective through discovery, normalization, planning, approvals, ordered effects, and sealed evidence](../diagrams/toolbraid-how-it-works.svg)](../diagrams/toolbraid-how-it-works.svg)

```text
human objective
  -> discover WebMCP tools across origins
  -> quarantine unsafe metadata
  -> normalize tools into canonical capabilities
  -> adapt incompatible schemas
  -> build an explainable dependency graph
  -> execute safe reads
  -> present an exact approval packet
  -> execute only the approved mutations
  -> produce a replay-resistant audit trail
```

## Primary proof mission: production recovery

The competition experience uses a high-consequence mission where human
authority is essential:

> Restore checkout after the latest deployment. Find the safest recovery path
> and prepare a customer update, but do not change production or publish
> anything without my approval.

Independent WebMCP providers expose deliberately heterogeneous contracts:

| Provider role | Example tools | Purpose |
|---|---|---|
| Service health | `probe_service`, `read_incident_window` | Establish current impact and timing. |
| Source/release history | `trace_changes`, `inspect_release_candidate` | Correlate the incident with recent changes. |
| Deployment control | `list_rollouts`, `stage_recovery`, `apply_recovery` | Find and execute a reversible recovery action. |
| Customer communication | `read_active_notice`, `publish_update` | Prepare and publish an accurate status update. |
| Adversarial provider | misleading or instruction-like metadata | Prove pre-plan quarantine. |

The service-health role has two interchangeable implementations with
different tool names, schemas, and result shapes. The planner must continue to
work when the selected provider changes, without provider-specific branches.

## Canonical capability pack

The first production pack is intentionally bounded:

| Capability | Risk | Canonical purpose |
|---|---|---|
| `service.health.read` | read-only | Read current service health and impact. |
| `release.history.read` | read-only | Read recent releases and change evidence. |
| `deployment.history.read` | read-only | Read recent deployment state. |
| `recovery.option.prepare` | reversible preparation | Prepare a recovery candidate without applying it. |
| `recovery.option.apply` | external mutation | Apply the exact approved recovery action. |
| `status.notice.read` | read-only | Read the current public notice. |
| `status.notice.publish` | external mutation | Publish the exact approved customer update. |

The ontology is a plug-in pack. ToolBraid's engine must not contain provider
names or depend on this domain's vocabulary outside the pack.

## Human-agent collaboration

The agent may:

- interpret the objective and structured constraints;
- discover and map available tools;
- execute read-only evidence collection;
- compose and rank recovery options;
- draft the proposed customer communication;
- explain every choice and dependency.

Only the human may create the approval record for external mutations.

The approval packet must bind all of the following:

- plan identifier and plan revision;
- node identifier;
- provider origin;
- tool identity;
- normalized arguments and their fingerprint;
- expected risk and effect;
- approval timestamp and one-time nonce.

Changing any bound field invalidates the approval. Consumed approvals cannot be
replayed.

## Security invariants

1. Provider metadata and outputs are untrusted data, never instructions.
2. Metadata is scanned before semantic normalization or planning.
3. A quarantined tool cannot enter the candidate set or execution graph.
4. Read-only classification cannot rely only on a provider's self-annotation.
5. Native tool identity includes its owning origin and live registration.
6. Execution fails closed if native identity is ambiguous or no longer live.
7. No agent-callable tool can create, widen, or refresh human approval.
8. An approved mutation may execute once and only with the approved arguments.
9. Every mapping, decision, approval, rejection, and call is visible in audit.

## Judge-visible proof

The product must make these facts observable without reading source code:

- multiple live origins contributed tools;
- unfamiliar provider contracts mapped into canonical capabilities;
- mapping confidence and evidence are inspectable;
- independent reads executed in parallel;
- the graph changed when hostile metadata was quarantined;
- provider substitution succeeded without changing the planner;
- mutations remained blocked before human approval;
- tampering with an approved call was rejected;
- the final audit identifies origin, tool, arguments, result, and approval.

## Acceptance gates

Final competition readiness is not declared until all gates pass:

- native `registerTool -> getTools -> executeTool` path verified in a supported browser;
- providers run on genuinely distinct origins with explicit exposure policy;
- literal `document.modelContext.registerTool({ ... })` example exists in the public repository;
- one clean command validates tests, build, and security invariants;
- clean clone reaches the same verified result;
- public deployment works anonymously and without paid credentials;
- repository is public, licensed, complete, and internally consistent;
- final video is new, public, under three minutes, and shows the real product;
- Devpost description and instructions match the shipped build exactly.

## Explicit non-goals for the competition build

- arbitrary browser automation or scraping;
- universal semantic coverage;
- irreversible production actions;
- credential storage;
- hidden autonomous mutations;
- dependence on the previous travel demonstration;
- features that do not strengthen a judging criterion or required gate.
