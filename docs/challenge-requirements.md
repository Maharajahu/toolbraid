# WebMCP Challenge Requirements Status

Verified on **27 August 2026** against the [official rules](https://webmcp.devpost.com/rules), [challenge page](https://openai.com/webmcp-challenge/), and [Chrome WebMCP guidance](https://developer.chrome.com/docs/ai/webmcp). The submission deadline is **3 September 2026 at 1:00 pm Pacific Time**.

## Engineering gates — passed

- browser application built around native WebMCP discovery and execution;
- literal `document.modelContext.registerTool({ ... })` implementations in six independent provider documents;
- Chrome 151 native run using `document.modelContext.getTools()` and `executeTool()` across seven local origins;
- native Chrome 151 read-only validation against the anonymous public seven-origin Vercel deployment;
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
| Public source repository with all source/assets/instructions | Complete private development branch is synchronized; public visibility and default-branch promotion remain pending |
| Open-source license detectable on the repository page and visible in About | GitHub detects the MIT license while private; recheck after public release |
| English description covering WebMCP fit, UX improvement, human-agent collaboration, and implementation | Repository description and judge documentation are complete; final Devpost copy remains pending |
| Public YouTube demonstration under three minutes, with audio | English 1080p local master and captions are complete; public YouTube upload remains pending |
| English video/text/testing instructions | Repository, video materials, and live-URL testing instructions are complete |
| No unlicensed trademarks, copyrighted music, or third-party media in the demonstration | Local master uses first-party ToolBraid UI/assets, the owner's authorized voice cloned locally with MIT-licensed Resemble AI Chatterbox, and an original deterministic ambient bed; exact revisions and attribution are recorded in `THIRD_PARTY_NOTICES.md` |
| Free judge access through the end of judging | Live deployment is anonymously accessible; availability through the end of judging remains an operational monitoring gate |
| Completed Devpost fields and submitted entry | Pending |

The rules also require the project to work as depicted, be original/owned by the entrant, and be new during the submission period or meaningfully extended with dated evidence. They permit individual entrants and require age of majority and residency in a supported territory.

## Judging alignment

The four equally weighted official criteria are WebMCP Leverage, Execution, Potential Impact, and Creativity & Ambition. ToolBraid's evidence for each criterion is maintained in [JUDGING.md](JUDGING.md).

## Readiness verdict

The engineering product and public seven-origin deployment are complete and judge-tested in native Chrome. The competition submission is **not ready to submit** until the repository is made public, the final video is uploaded publicly to YouTube, and the Devpost entry is completed.
