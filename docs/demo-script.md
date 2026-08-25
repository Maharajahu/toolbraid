# ToolBraid Live Demo Script

**Target duration:** 2 minutes 35 seconds
**Scenario:** Coventry to London, hotel near 1 Principal Place, total under £250, approval before holds.

## Pre-flight

1. Deploy the exact tested commit.
2. Open it in ChatGPT's in-app browser or Chrome with WebMCP testing enabled.
3. Use a 1600 × 1000 or 1440 × 900 viewport.
4. Reset the mission.
5. Confirm the header shows four provider sites and six discovered tools.
6. Confirm the mapping inspector shows one quarantined tool.
7. Record at 1080p or higher with clear audio.
8. Keep pointer movement deliberate and avoid opening developer tools in the main recording.

## Timed flow

### 0:00–0:14 — Problem

Show the empty ToolBraid UI and provider websites.

Narration:

> WebMCP lets each website expose reliable tools, but a real goal still spans providers with different names, schemas, and risk levels. ToolBraid turns those fragments into one accountable plan.

### 0:14–0:30 — Human intent

Point to the mission text, destination, and £250 budget.

Narration:

> I give ToolBraid a goal, not a click path: travel from Coventry to London, find a nearby hotel, stay under £250, and ask before changing anything.

### 0:30–0:48 — Runtime discovery

Point to the provider network and mappings inspector.

Narration:

> Four independent websites register six WebMCP tools. Their contracts are deliberately incompatible: seek passages, scan spaces, measure access, freeze quote, and hold space.

Show the Mirage quarantine card.

> A sixth tool contains instruction-like metadata asking the agent to bypass approval. ToolBraid treats provider metadata as untrusted and quarantines it before planning.

### 0:48–1:08 — Build plan

Click **Build capability plan**.

Narration:

> ToolBraid combines tool name, description, JSON schema, and risk evidence to map the safe tools into five canonical capabilities. It then builds a seven-node dependency graph across three provider sites.

Point at the parallel search nodes and approval-gated hold nodes.

### 1:08–1:34 — Execute safe work

Click **Run safe steps**.

Narration:

> Read-only searches run automatically. ToolBraid adapts the mission to each provider's schema, canonicalizes the results, composes transport and accommodation, measures walking access, and ranks only feasible combinations.

Point to the recommendation.

> The selected mission is £184.90, leaving £65.10 in the budget, with a thirteen-minute walk.

### 1:34–1:56 — Human checkpoint

The approval modal appears.

Narration:

> Execution stops here. The agent cannot approve its own state changes. The top-level UI shows the exact provider tools, selected options, prices, and risk. These are temporary holds, not purchases.

Keep both boxes selected. Click **Approve selected actions**.

### 1:56–2:15 — Execute approved actions

Click **Execute 2 approved actions**.

Narration:

> Only the two actions represented by the human approval record can now execute. Both provider interfaces update in the same browser context, and no payment or final booking occurs.

### 2:15–2:31 — Evidence

Point to **Audit** and **Mappings**.

Narration:

> Every mapping, adapted input, dependency, approval, and result remains visible. ToolBraid is not another directory or browser automation wrapper. It is a semantic and policy control plane over WebMCP.

### 2:31–2:38 — Close

Return the pointer to the completed graph.

Narration:

> One human goal. Multiple websites. One accountable action layer.

## Demonstration invariants

The recording must visibly establish:

- real provider WebMCP tools;
- dynamic discovery count;
- different names and schemas;
- quarantine before planning;
- multi-site DAG;
- read-only execution before approval;
- exact approval gate;
- provider UI state updates;
- no-purchase claim;
- audit evidence.

## Recovery plan

The provider websites are deterministic and bundled with the app, so refreshing restores the demo. If an experimental browser implementation changes, use the tested local runtime for the recording and clearly label it as the standards-aligned test runtime. Before final submission, also perform a native-browser verification in the exact judge-compatible environment.
