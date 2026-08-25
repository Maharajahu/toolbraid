# Devpost Submission Copy

## Project name

ToolBraid

## Tagline

Braid independent WebMCP capabilities into one explainable, human-approved plan.

## One-line summary

ToolBraid dynamically discovers heterogeneous WebMCP tools, normalizes their names and schemas into common capabilities, builds a cross-site execution graph, and requires human approval before external state changes.

## Inspiration

WebMCP solves a foundational problem: a website can expose reliable, structured actions to an agent without forcing the agent to guess through screenshots and click paths.

But one website is rarely the whole task. Planning a trip, arranging an event, resolving an operational incident, or purchasing equipment can span several services. Each site may expose technically valid WebMCP tools while using completely different names, schemas, result shapes, and risk annotations. A flat tool list leaves the agent to improvise the integration and leaves the person without one place to understand or control the outcome.

ToolBraid explores the layer above individual WebMCP tools: a browser-native semantic and policy control plane.

## What it does

A person gives ToolBraid a goal and constraints. ToolBraid then:

1. discovers WebMCP tools from independent website contexts;
2. treats all provider metadata as untrusted;
3. quarantines instruction-like or exfiltration-oriented tool descriptions;
4. maps unfamiliar names, descriptions, and JSON schemas into canonical capabilities;
5. explains each mapping with confidence and evidence;
6. builds a dependency-aware execution graph;
7. runs read-only searches and local composition automatically;
8. adapts inputs and outputs without provider-name branches;
9. pauses before every external state change;
10. executes only actions represented by a human-created approval record;
11. keeps the provider UIs and full audit trail visible.

The demo coordinates transport, accommodation, and walking-access providers. It selects a feasible combination under a £250 budget, then waits for the user before creating two temporary holds. A fourth adversarial provider tries to poison the agent through tool metadata and is quarantined before planning.

## How we built it

ToolBraid is a dependency-free static web application.

- `document.modelContext.registerTool()` publishes provider and orchestrator tools.
- `getTools()` discovers provider capabilities from the browser context.
- A deterministic semantic normalizer scores tool names, titles, descriptions, and JSON-schema properties against a small canonical ontology.
- A security scanner identifies instruction-like metadata before mapping.
- Schema adapters translate canonical mission concepts into provider-specific fields and normalize outputs back into common records.
- A DAG planner expresses parallel searches, dependencies, local composition, and approval-gated mutations.
- The executor runs only nodes whose dependencies and policy conditions are satisfied.
- The approval record can be generated only by the visible human UI, never by an agent tool call.
- A local standards-aligned runtime keeps the project testable while WebMCP remains experimental; native WebMCP is used automatically when available.

The project includes 11 unit and contract tests plus a browser E2E test covering the complete mission.

## Why WebMCP is essential

Without WebMCP, ToolBraid would need brittle DOM automation, private backend integrations, or credentials copied outside the provider interfaces. WebMCP lets each provider retain its UI, state, and client-side business logic while exposing a deterministic action contract to the orchestrator.

The human and agent remain in the same browser experience. The agent can act through structured tools, the websites visibly update, and the user keeps transaction authority.

## What people and agents can do together

The agent handles discovery, schema adaptation, parallel research, comparison, and dependency execution. The person defines the objective, reviews the evidence, and owns every decision that changes external state.

That collaboration was difficult to make reliable with ordinary browser automation because there was no stable capability contract and no unified approval surface across sites.

## Challenges

The hardest design problem was avoiding fake universality. Semantic tool routing, browser bridges, and registries already exist. We narrowed the contribution to a testable control-plane prototype and made every inference visible.

Another challenge was treating tool metadata as hostile input. A tool description is useful semantic evidence, but it can also contain instructions intended to manipulate the agent. ToolBraid therefore scans and quarantines metadata before the planner sees it.

Finally, approval needed to be a real execution precondition. Showing a confirmation dialog after a write would be theatre. ToolBraid's approved-execution tool fails closed unless the visible UI has already created an approval record for the exact plan nodes.

## Accomplishments

- Runtime discovery across four independent WebMCP website fixtures
- Five canonical capabilities from incompatible contracts
- Explainable semantic mapping and confidence evidence
- Adversarial tool-metadata quarantine
- Seven-node cross-site dependency graph
- Concurrent safe execution
- Schema-driven input and output adaptation
- Human-owned, per-action approval gates
- Visible provider state and audit trace
- 11 passing unit and contract tests
- Passing full-browser E2E mission

## What we learned

WebMCP solves transport and browser actuation, but capability semantics and governance remain application-level problems. A useful orchestration layer needs more than an LLM prompt. It needs explicit capability contracts, dependency state, risk policy, provenance, and an approval model that the agent cannot rewrite.

We also learned that the right long-term shape is probably not one giant universal ontology. Domain capability packs can remain small, inspectable, and policy-aware while sharing a common orchestration protocol.

## What's next

- ranked alternative providers and automatic read-only failover;
- strict JSON Schema validation;
- signed, origin-bound provider identity;
- plan hashes and single-use approval tokens;
- compensation and verification nodes;
- pluggable local embeddings or model-assisted normalization;
- domain packs beyond travel;
- persistent, tamper-evident audit export.

## Built with

WebMCP, JavaScript ES modules, HTML, CSS, Node.js test runner, Playwright, and GitHub Actions.
