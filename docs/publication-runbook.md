# ToolBraid Publication Runbook

**Purpose:** convert the validated local package into the three public URLs required for submission.

## 1. Publish the repository

Create a new **public** GitHub repository named `toolbraid`. Leave it empty: do not add a README, license, or `.gitignore`, because the local repository already contains all three.

From the ToolBraid project directory:

```bash
git remote add origin https://github.com/<YOUR-USER>/toolbraid.git
git push -u origin main
```

Expected commit subject at handoff:

```text
Build ToolBraid WebMCP challenge MVP
```

Confirm the current immutable commit ID locally with `git rev-parse HEAD` before pushing.

After the push, verify that the repository root visibly contains:

- `README.md`
- `LICENSE`
- `index.html`
- `js/core/webmcp-runtime.js`
- `release/ToolBraid-WebMCP-Challenge-Demo.mp4`
- `.github/workflows/pages.yml`

## 2. Deploy the live application

### Recommended path: GitHub Pages

The repository already contains a Pages workflow.

1. Open **Repository Settings → Pages**.
2. Set the source to **GitHub Actions**.
3. Open the **Actions** tab and confirm `Validate and deploy ToolBraid` succeeds.
4. Copy the HTTPS Pages URL from the deployment environment.

The workflow runs the project integrity check and unit tests before deployment.

### Vercel alternative

Import the public repository as a static project:

```text
Framework preset: Other
Root directory:   repository root
Build command:    none
Output directory: .
```

No environment variables or API keys are required.

## 3. Native WebMCP smoke test

Open the deployed URL in the final WebMCP-enabled browser.

Verify:

1. the runtime pill reports native WebMCP rather than the test runtime;
2. four provider contexts and six provider tools appear;
3. one adversarial tool is quarantined;
4. `Build capability plan` produces seven nodes;
5. `Run safe steps` stops at two approval gates;
6. an agent-side approved-execution call cannot create approval;
7. human approval enables only the two selected reversible actions;
8. both temporary holds complete and the audit tab records them.

Do not record the final challenge video until this smoke test passes in the browser used for recording.

## 4. Upload the video to YouTube

Upload:

```text
release/ToolBraid-WebMCP-Challenge-Demo.mp4
```

Recommended metadata:

```text
Title:
ToolBraid: One Accountable Action Layer for WebMCP

Description:
ToolBraid dynamically discovers heterogeneous WebMCP tools, normalizes their names and schemas into canonical capabilities, builds an explainable cross-site execution graph, quarantines hostile metadata, and requires human approval before external state changes.

Built for the OpenAI WebMCP Challenge.

Repository: <PUBLIC_REPOSITORY_URL>
Live demo: <PUBLIC_DEMO_URL>
```

Upload the supplied thumbnail:

```text
docs/screenshots/toolbraid-video-thumbnail.png
```

The MP4 already contains burned English captions. The standalone SRT remains available at:

```text
release/ToolBraid-WebMCP-Challenge-Demo.srt
```

Set visibility to **Public**, then replay the uploaded copy and verify audio, captions, 156.9-second duration, and 720p processing before copying the URL.

## 5. Assemble the Devpost submission

Use [`submission-description.md`](submission-description.md) for the written fields and add:

```text
Live URL:       <PUBLIC_DEMO_URL>
Repository:     <PUBLIC_REPOSITORY_URL>
YouTube video:  <PUBLIC_YOUTUBE_URL>
```

Final checks:

- the live URL opens without authentication;
- the repository is public and carries the MIT license;
- the YouTube video is public, has audio, and remains under three minutes;
- WebMCP is visibly central to the demonstrated workflow;
- synthetic providers and temporary holds are described accurately;
- entrant eligibility and official rules are reviewed before submission.

## Deadline control

The verified submission deadline is:

```text
3 September 2026, 17:00 PDT
4 September 2026, 01:00 BST
```

Treat **23:30 BST on 3 September** as the internal cutoff. This preserves 90 minutes for URL verification, YouTube processing, and Devpost upload failures, because authentication systems have an uncanny instinct for deadlines.

The current OpenAI challenge page and Netlify's official partner announcement both show 17:00 PT. An earlier Devpost snapshot showed 13:00 PDT, so recheck the live Devpost form before pressing Submit and follow the most restrictive controlling deadline if the pages diverge again.
