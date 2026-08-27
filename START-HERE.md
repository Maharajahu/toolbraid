# Start Here

## Run the product

```bash
npm run dev
```

Open `http://127.0.0.1:4173`. The badge must read **Verified local harness** in an ordinary browser.

For the native multi-origin path, use a browser build that implements WebMCP:

```bash
npm run dev:native
```

This starts the orchestrator on port 4173 and six provider documents on ports 4174 through 4179. The badge must read **Native WebMCP**; otherwise the run is not native compliance evidence.

Chrome 149+ native verification can be run reproducibly with:

```bash
npm run test:native
```

## Walk through the mission

1. Start discovery and inspect six origins, nine tools, one quarantine, and seven capability mappings.
2. Run safe reads. The primary health provider fails and the graph visibly substitutes the read-only fallback.
3. Inspect the evidence, proposed recovery, drafted notice, and exact mutation arguments.
4. Approve the recovery action and status publication separately.
5. Execute the approved mutations.
6. Confirm `release-1841`, `notice-r9`, and the sealed local SHA-256 integrity chain.
7. Reset to begin a fresh mission.

No real infrastructure or public status page is changed.

## Validate the repository

```bash
npm run validate
npm run test:e2e
```

The browser report is written to `docs/e2e-validation.json`; screenshots are stored in `docs/screenshots/`.
