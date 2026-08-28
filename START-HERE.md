# Start Here

For a fast product overview, open the [live demo](https://toolbraid-webmcp.vercel.app), the [Judge Guide](docs/JUDGING.md), or the [full-resolution completed mission](docs/screenshots/toolbraid-recovery-completed.png).

## Open the live release

Open [toolbraid-webmcp.vercel.app](https://toolbraid-webmcp.vercel.app) in Chrome 149+ with WebMCP enabled. No login is required. The badge must read **Native WebMCP** for a native run.

The public profile reads exact real commit SHAs from GitHub and matching Vercel deployment metadata. Each provider page calls its own same-origin server function, which accesses only the allowlisted GitHub, Vercel, or recovery-lab health API target.

## Run locally

```bash
npm run dev
```

Open `http://127.0.0.1:4173`. The badge must read **Verified local harness** in an ordinary browser. This deterministic fixture path is a local fallback only; the public Vercel profile uses the live sandbox integrations.

For the native multi-origin path, use a browser build that implements WebMCP:

```bash
npm run dev:native
```

This starts the orchestrator on port 4173 and six provider documents on ports 4174 through 4179. The badge must read **Native WebMCP**; otherwise the run is not native compliance evidence.

Chrome 149+ native verification can be run reproducibly with:

```bash
npm run test:native
```

The public read-only gate is documented in [Testing](docs/testing.md).

## Walk through the mission

1. Start discovery and inspect six origins, nine tools, one quarantine, and seven capability mappings.
2. Run safe reads. In the local harness, the primary health fixture fails and the graph visibly substitutes the read-only fallback; the public profile reads the live sandbox state.
3. Inspect the evidence, proposed recovery, drafted notice, and exact mutation arguments.
4. Approve the recovery action and status publication separately.
5. Execute the approved mutations.
6. Confirm the exact rollback-target commit SHA, the GitHub comment receipt, and the sealed local SHA-256 integrity chain.
7. Reset to begin a fresh mission.

In the public demo, the two approvals cause real, bounded effects: recovery rolls only the disposable Vercel recovery lab back to its immediately previous production deployment, and publication appends a comment to the allowlisted GitHub issue #1. No customer or business production system is changed.

## Validate the repository

```bash
npm run validate
npm run test:e2e
```

The browser report is written to `docs/e2e-validation.json`; screenshots are stored in `docs/screenshots/`.
