# WebMCP Challenge Requirements Status

Verified again on **2 September 2026** against the [official rules](https://webmcp.devpost.com/rules), [challenge page](https://openai.com/webmcp-challenge/), and [Chrome WebMCP guidance](https://developer.chrome.com/docs/ai/webmcp). The submission deadline is **3 September 2026 at 1:00 pm Pacific Time**. The optional Devpost plugin is a helper, not the source of truth.

## Engineering gates — passed

- browser application built around native WebMCP discovery and execution;
- literal `document.modelContext.registerTool({ ... })` implementations in six independent provider documents;
- Chrome 151 native run using `document.modelContext.getTools()` and `executeTool()` across seven local origins;
- native Chrome 151 read-only validation and a fail-closed full browser-sandbox capture against the anonymous public seven-origin Vercel deployment;
- nine heterogeneous tools normalized into seven canonical capabilities;
- hostile metadata quarantined before scoring;
- read-only failover with no mutation failover;
- exact, separate human approvals, atomically claimed before any mutation;
- unique idempotency keys, replay defense, live-registry revalidation, partial-failure receipts, and a sealed local integrity chain;
- deterministic unit, integration, multi-origin, desktop, mobile, keyboard, dialog, CSP, and native-browser validation;
- local Apache-2.0 license and reproducible setup documentation;
- dated Git history beginning during the submission period (`b615fa7`, 25 August 2026).

Native evidence is recorded in [native-e2e-validation.json](native-e2e-validation.json), and the public read-only gate is recorded in [native-public-readonly-validation.json](native-public-readonly-validation.json). Harness evidence and screenshots are recorded in [e2e-validation.json](e2e-validation.json).

## Mandatory release/submission gates

| Official requirement | Current state |
|---|---|
| Working live URL accessible in ChatGPT's in-app browser or Chrome 149+ with WebMCP enabled | Complete — [toolbraid-webmcp.vercel.app](https://toolbraid-webmcp.vercel.app) is live across seven anonymous HTTPS origins; native Chrome 151 read-only validation passed |
| Public source repository with all source/assets/instructions | Complete — [Maharajahu/toolbraid](https://github.com/Maharajahu/toolbraid) is public, the default branch is `main`, and the full-history secret scan is clean |
| Open-source license detectable on the repository page and visible in About | Complete — the repository has the standard root Apache-2.0 `LICENSE`, package metadata declares `Apache-2.0`, the license is linked in the README header, and GitHub detects it as Apache-2.0 |
| English description covering WebMCP fit, UX improvement, human-agent collaboration, and implementation | Complete in the submitted Devpost entry, README, Judge Guide, and product definition |
| Public YouTube demonstration under three minutes, with audio | Complete — the validated 2:40 4K60 English master with continuous voice-over is public at [youtu.be/IDaho_wf0Ak](https://youtu.be/IDaho_wf0Ak) |
| English video/text/testing instructions | Repository, video materials, and live-URL testing instructions are complete |
| No unlicensed trademarks, copyrighted music, or third-party media in the demonstration | Complete — the master uses first-party ToolBraid UI/assets, the owner's authorized voice cloned locally with IndexTTS 2.5, and an original deterministic ambient bed. The pinned bilibili Model Use License Agreement is retained verbatim, and the public YouTube description includes the required disclaimer plus the retained-license link. YouTube's completed checks found no issues |
| Free judge access through the end of judging | Live deployment is anonymously accessible; availability through the end of judging remains an operational monitoring gate |
| Completed Devpost fields and submitted entry | Complete — ToolBraid remains `SUBMITTED`, with the exact live URL, public repository, and final 4K60 video URL saved in the entry |

The rules also require the project to work as depicted, be original/owned by the entrant, and be new during the submission period or meaningfully extended with dated evidence. They permit individual entrants and require age of majority and residency in a supported territory.

## Judging alignment

The four equally weighted official criteria are WebMCP Leverage, Execution, Potential Impact, and Creativity & Ambition. ToolBraid's evidence for each criterion is maintained in [JUDGING.md](JUDGING.md).

## Readiness verdict

The engineering product, public repository, public 4K60 demonstration, submitted Devpost entry, and seven-origin deployment are complete and judge-tested in native Chrome. All mandatory release gates are complete; availability through judging remains an operational monitoring responsibility.
