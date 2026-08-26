# Devpost Submission Copy

## Project name

ToolBraid

## Tagline

One intent. Multiple WebMCP providers. One accountable action plan.

## Inspiration

WebMCP solves an important problem: it lets websites expose structured capabilities directly to agents. But provider fragmentation remains. A rail site may publish `journey_lookup`, a hotel site may publish `rooms_lookup`, and another provider may publish `walk_time`. Their names, schemas, result shapes and risk semantics do not match.

We built ToolBraid to answer the next question: what turns those independent website capabilities into one safe, explainable mission?

## What it does

ToolBraid accepts a goal, dynamically inspects WebMCP tool metadata, maps heterogeneous tools into canonical capabilities, ranks compatible providers, builds a dependency graph and executes read-only nodes. It stops before state-changing operations and asks the human to approve the exact providers, option IDs and prices.

The demo mission finds transport from Coventry to London, accommodation near Amazon LHR16 and walking access while keeping the total below £250. ToolBraid discovers six tools across four provider documents, quarantines a malicious tool description, produces a seven-node plan, completes five read-only nodes and proposes a £184.90 bundle. Only after explicit approval does it create two synthetic reversible holds.

## How we used WebMCP

Provider documents register structured tools with names, descriptions and JSON schemas. ToolBraid consumes those published capabilities instead of relying on DOM selectors or private APIs. In browsers exposing the native WebMCP API, the production release registers both provider and orchestration tools through `modelContext.registerTool()`.

ToolBraid exposes four orchestration tools:

- `toolbraid_plan`
- `toolbraid_execute_safe`
- `toolbraid_status`
- `toolbraid_execute_approved`

There is deliberately no agent-callable approval tool. Approval remains a human UI authority.

## Human-agent collaboration

The agent handles discovery, semantic mapping, planning, comparison and read-only execution. The human retains control over mutations. Approval is cryptographically bound to the plan, provider, selected option, action set and price. It is consumed before execution and cannot be replayed.

## Security

Tool metadata and results are untrusted. ToolBraid quarantines hostile instructions, validates input and canonical output schemas, restricts automatic fallback to read-only operations, blocks automatic mutation fallback, and rejects approval tampering or replay.

## How we built it

ToolBraid is framework-free JavaScript, HTML and CSS with a modular architecture for normalization, planning, execution, schema adaptation, risk classification and approval. Tests use Node's built-in test runner plus Playwright-driven Chromium E2E validation at desktop and mobile viewports.

## Challenges

The hardest design problem was preserving agent usefulness without quietly transferring authority. A generic "approve" flag was not enough. We built approval as a single-use record tied to the actual execution graph and recommendation, then verified it immediately before state change.

## Accomplishments

- Runtime discovery and semantic normalization of heterogeneous tools
- Explainable seven-node execution DAG
- Hostile metadata quarantine
- Safe read-only provider fallback
- Human-only, plan-bound and option-bound approvals
- Atomic consumption and replay protection
- Exact-artifact browser testing across desktop and mobile

## What we learned

WebMCP is more than a faster way to click websites. It creates a common substrate for capability composition. The next important layer is not another directory; it is trustworthy intent-to-action orchestration.

## What's next

- Live registry-backed provider discovery
- Learned capability fingerprints
- User provider preferences and reliability scoring
- Multi-origin authenticated provider sessions
- Signed provider attestations
- Richer rollback and compensation graphs
