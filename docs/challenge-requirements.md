# OpenAI WebMCP Challenge Requirements

Verified on **25 August 2026** against the official OpenAI challenge page and Devpost overview/rules.

## Dates

| Item | Official time | UK time |
|---|---:|---:|
| Submissions open | 25 Aug 2026, 12:00 PT | 25 Aug 2026, 20:00 BST |
| Submission deadline | 3 Sep 2026, 17:00 PDT | **4 Sep 2026, 01:00 BST** |
| Winners announced | 23 Sep 2026, subject to change | 23 Sep 2026 |

Sources:

- https://openai.com/webmcp-challenge/
- https://webmcp.devpost.com/
- https://webmcp.devpost.com/rules
- https://www.netlify.com/blog/compete-openai-webmcp-challenge/

> **Schedule reconciliation:** earlier Devpost snapshots displayed a 13:00 PDT submission time. The current OpenAI challenge page and Netlify's official partner announcement both display **3 September 2026 at 17:00 PT**. ToolBraid therefore uses 17:00 PT as the current public schedule. Recheck the live Devpost form immediately before final submission because its rules remain controlling.

## What must be built

A WebMCP-powered web application exploring a future where people and agents interact, collaborate, and create together.

## Submission checklist

| Requirement | ToolBraid status | Evidence / action |
|---|---|---|
| Working live URL accessible in ChatGPT browser or compatible Chrome | **PENDING DEPLOYMENT** | Static app and GitHub Pages workflow are ready. A public repository/host must be connected. |
| Text description explaining WebMCP fit | PASS | `docs/submission-description.md` |
| Explain how UX is better | PASS | Product spec and submission copy |
| Explain what humans and agents can do together | PASS | Human approval workflow and demo script |
| Brief implementation explanation | PASS | README and architecture document |
| Public YouTube video under 3 minutes, with audio | **RENDERED · PENDING PUBLIC UPLOAD** | Captioned 156.9-second MP4, SRT, thumbnail, and validation report are complete. |
| Public code repository | **PENDING PUBLICATION** | Repository is packaged and locally committed. |
| All source code, assets, and functional instructions | PASS | Repository and README |
| Open-source license visible at repository root | PASS | MIT `LICENSE` |
| Real WebMCP registration in source | PASS | `document.modelContext.registerTool(...)` in `js/core/webmcp-runtime.js` |

## Judging criteria alignment

### 1. WebMCP Leverage

ToolBraid uses WebMCP for both sides of the interaction:

- independent provider websites expose tools;
- the orchestrator discovers and executes those tools from the browser context;
- ToolBraid itself exposes planning, safe execution, approved execution, and inspection as WebMCP tools;
- provider UI and state remain visible while agent actions occur.

### 2. Execution

The product is a complete runnable static application with a polished mission-control UI, deterministic providers, unit tests, E2E tests, security controls, documentation, and deployment workflow.

### 3. Potential Impact

As WebMCP adoption grows, agents will face capability fragmentation across websites. ToolBraid demonstrates a browser-native control plane that lets people delegate multi-site objectives without surrendering visibility or transaction control.

### 4. Creativity & Ambition

The core contribution is not another tool registry or website adapter. It is runtime semantic composition with explainable mapping, dependency planning, metadata quarantine, and human-owned approval.

## Eligibility note

The Devpost page requires participants to be above the legal age of majority in their country of residence and lists excluded countries/territories. The United Kingdom is not shown in the exclusion list displayed on the overview page. The entrant remains responsible for reviewing and accepting the complete official rules before submission.
