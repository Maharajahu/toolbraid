# WebMCP Challenge Requirements Status

Verified again on **30 August 2026** against the [official rules](https://webmcp.devpost.com/rules), [challenge page](https://openai.com/webmcp-challenge/), and [Chrome WebMCP guidance](https://developer.chrome.com/docs/ai/webmcp). The submission deadline is **3 September 2026 at 1:00 pm Pacific Time**. The optional Devpost plugin is a helper, not the source of truth.

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
- local MIT license and reproducible setup documentation;
- dated Git history beginning during the submission period (`b615fa7`, 25 August 2026).

Native evidence is recorded in [native-e2e-validation.json](native-e2e-validation.json), and the public read-only gate is recorded in [native-public-readonly-validation.json](native-public-readonly-validation.json). Harness evidence and screenshots are recorded in [e2e-validation.json](e2e-validation.json).

## Mandatory release/submission gates — not yet complete

| Official requirement | Current state |
|---|---|
| Working live URL accessible in ChatGPT's in-app browser or Chrome 149+ with WebMCP enabled | Complete — [toolbraid-webmcp.vercel.app](https://toolbraid-webmcp.vercel.app) is live across seven anonymous HTTPS origins; native Chrome 151 read-only validation passed |
| Public source repository with all source/assets/instructions | Release-prepared and synchronized on default branch `main`; full-history secret scan is clean. The owner intentionally retains private visibility until explicit publication approval, so this gate remains open |
| Open-source license detectable on the repository page and visible in About | MIT `LICENSE` is present and package metadata declares MIT; public GitHub detection and About visibility must be rechecked after publication |
| English description covering WebMCP fit, UX improvement, human-agent collaboration, and implementation | Complete in the README, Judge Guide, and product definition; the final Devpost form remains pending |
| Public YouTube demonstration under three minutes, with audio | English 1080p master is locked at 69.700 seconds / 2,091 frames with continuous voice and burned-in captions; final render validation and public YouTube upload remain pending |
| English video/text/testing instructions | Repository, video materials, and live-URL testing instructions are complete |
| No unlicensed trademarks, copyrighted music, or third-party media in the demonstration | The master uses first-party ToolBraid UI/assets, the owner's authorized voice cloned locally with IndexTTS 2.5, and an original deterministic ambient bed. The pinned bilibili Model Use License Agreement is included verbatim; its distribution obligations and required disclaimer are documented in `THIRD_PARTY_NOTICES.md`. Confirm that the final YouTube distribution package satisfies those obligations before marking this gate complete |
| Free judge access through the end of judging | Live deployment is anonymously accessible; availability through the end of judging remains an operational monitoring gate |
| Completed Devpost fields and submitted entry | Pending |

The rules also require the project to work as depicted, be original/owned by the entrant, and be new during the submission period or meaningfully extended with dated evidence. They permit individual entrants and require age of majority and residency in a supported territory.

## Judging alignment

The four equally weighted official criteria are WebMCP Leverage, Execution, Potential Impact, and Creativity & Ambition. ToolBraid's evidence for each criterion is maintained in [JUDGING.md](JUDGING.md).

## Readiness verdict

The engineering product, repository contents, and public seven-origin deployment are complete and judge-tested in native Chrome. The competition submission is **not ready to submit** until the repository visibility is made public, the final video is uploaded publicly to YouTube, and the Devpost entry is completed.
