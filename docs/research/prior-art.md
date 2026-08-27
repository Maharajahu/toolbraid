# Prior-Art Review and Novelty Boundary

**Research date:** 25 August 2026
**Research question:** Does an existing project already provide a browser-native layer that dynamically discovers WebMCP tools across websites, normalizes incompatible semantics and schemas, creates an explainable dependency plan, quarantines hostile metadata, and reserves all external state changes for a human-controlled approval boundary?

## Executive conclusion

Several adjacent capabilities already exist:

- WebMCP standardizes in-browser tool registration and invocation.
- MCP-B and other bridges connect browser tools to agents.
- developer SDKs make websites easier to instrument.
- registries and semantic-routing research improve discovery.
- multi-server clients can list and call tools.
- agent-first API research proposes better provider-side contracts and governance.

Therefore ToolBraid **does not claim** to invent tool discovery, cross-site tool calling, semantic retrieval, WebMCP transport, or human approval in isolation.

The defensible product contribution is their browser-native combination as one visible control plane:

> runtime semantic normalization of unknown WebMCP names and schemas, capability-DAG construction, pre-plan metadata quarantine, explainable mapping evidence, and a human-owned approval boundary for cross-site state changes.

No reviewed project was found implementing that exact combination as a WebMCP application. This is a bounded prior-art finding, not a patentability opinion or a guarantee that no unpublished implementation exists.

## Comparison matrix

| Project / research | What it already does | Gap relative to ToolBraid |
|---|---|---|
| **W3C WebMCP** | Browser API for pages/forms to expose structured tools; in-page agents can discover and execute them; origin controls and annotations. | It is the substrate, not a semantic cross-site planner or policy UI. |
| **MCP-B / MiguelsPizza WebMCP** | Browser transports, extension, local bridge, authenticated browser-state reuse, dynamic tools. | Primarily transport/client infrastructure. No reviewed implementation of canonical schema normalization plus DAG and metadata quarantine. |
| **webmcp-bridge** | Local MCP client to browser WebMCP through Playwright; native and adapter paths; authenticated sessions. | Bridges one site/session and supports adapters; does not present the reviewed semantic mission-planning control plane. |
| **WebMCP Proxy** | Discovers a remote MCP server's tools and advertises them through WebMCP. | Protocol conversion, not cross-provider semantic composition. |
| **WebMCP Nexus (Alibaba)** | Build-time TypeScript/JSDoc analysis and low-intrusion registration for React apps. | Helps providers publish tools; does not normalize arbitrary external providers for a mission. |
| **WebMCP.sh** | Browser playground, multiple MCP server connections, tool execution, resources, PGlite. | Developer console/manual execution rather than intent-to-DAG orchestration and human transaction control. |
| **MCP-Zero** | Hierarchical semantic retrieval and iterative cross-domain toolchain construction at large tool counts. | General MCP research; not a visible WebMCP browser workflow with provider UI and approval ownership. |
| **NetMCP** | Coarse-to-fine semantic server/tool routing. | Retrieval/routing layer, not schema adaptation, DAG governance, and human checkpoint. |
| **LiveMCPBench** | Evaluates retrieval and multi-tool composition over a large MCP ecosystem. | Benchmark, not a product implementation. It confirms the problem remains difficult. |
| **Agent-First Tool API** | Semantic provider contracts, preview/execute/verify/recover phases, evidence and risk governance. | Requires or advocates better provider-side interfaces; ToolBraid adapts already-fragmented runtime tool contracts in the browser. |
| **ToolRegistry** | Protocol-agnostic registry and MCP enumeration. | Registry/management, not browser-native mission composition. |

## Detailed findings

### 1. WebMCP

WebMCP exposes website functionality through `document.modelContext.registerTool()`. In-page agents can use `getTools()` and `executeTool()`, including tools in descendant contexts when exposure policy permits.

This directly supports ToolBraid's topology. It also constrains the product: WebMCP is primarily designed for visible, local, human-in-the-loop browser workflows, not a headless universal backend.

Sources:

- https://github.com/webmachinelearning/webmcp
- https://webmachinelearning.github.io/webmcp/

### 2. MCP-B and browser bridges

MCP-B established browser transports, extension routing, and authenticated browser-session reuse. `webmcp-bridge` connects local MCP clients to live browser tools, including adapter fallbacks for non-native sites.

This means “connect an agent to browser tools” is not novel. ToolBraid must sit above the bridge layer.

Sources:

- https://github.com/MiguelsPizza/WebMCP
- https://github.com/holon-run/webmcp-bridge

### 3. Provider instrumentation

Alibaba's WebMCP Nexus derives schemas from TypeScript and JSDoc and manages tool lifecycle in React. WebMCP Proxy mirrors remote MCP tools into the browser.

These projects improve the supply of tools. ToolBraid addresses the demand-side problem of coordinating heterogeneous tools after discovery.

Sources:

- https://github.com/alibaba/webmcp-nexus
- https://github.com/alpic-ai/webmcp-proxy

### 4. Multi-server clients and directories

WebMCP.sh can connect to multiple servers and execute tools. Registries and directories enumerate tools. Those are important infrastructure, but a list of tools is not a capability plan.

Source:

- https://github.com/WebMCP-org/webmcp-sh

### 5. Semantic routing and composition research

MCP-Zero and NetMCP demonstrate semantic retrieval and toolchain selection. LiveMCPBench reports tool retrieval and composition as unresolved challenges at scale.

This eliminates any broad claim that ToolBraid invented semantic tool selection. The product differentiates through schema-aware runtime mapping, browser-local execution evidence, malicious-metadata quarantine, and approval ownership.

Sources:

- https://arxiv.org/abs/2506.01056
- https://arxiv.org/html/2510.13467
- https://arxiv.org/html/2508.01780

### 6. Agent-first interfaces

The Agent-First Tool API paradigm argues that MCP standardizes transport but not semantics. It proposes search/resolve/preview/execute/verify/recover phases, normalized evidence, and risk escalation.

ToolBraid agrees with that diagnosis. Its MVP explores a complementary migration path: infer a small canonical contract from existing WebMCP metadata instead of requiring every provider to redesign its interface first.

Source:

- https://arxiv.org/abs/2605.10555

## Novelty claim used in submission

Safe wording:

> ToolBraid explores a browser-native semantic control plane for WebMCP. It dynamically maps heterogeneous tool names and schemas into canonical capabilities, constructs an explainable cross-site dependency graph, quarantines hostile metadata before planning, and requires a human-owned approval record before external state changes.

Wording deliberately avoided:

- “the first universal API for the web”;
- “the first semantic MCP router”;
- “the first cross-site WebMCP agent”;
- “works with every website”;
- “guarantees safe autonomous transactions.”

Those claims are too broad or contradicted by existing infrastructure and research.

## Why the proof mission remains ambitious

The recovery proof mission makes WebMCP central rather than decorative:

- the providers are actual WebMCP applications;
- the orchestrator is itself WebMCP-operable;
- discovery happens at runtime;
- mappings are derived rather than prewired by provider ID;
- the DAG uses outputs across six provider origins;
- the adversarial fixture changes the plan through quarantine;
- human approval is a real execution precondition, not a modal shown after the action.
