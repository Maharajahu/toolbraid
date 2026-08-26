# Start Here: ToolBraid Challenge Release

## 1. Open the live product

https://toolbraid-dumitrescu91dan-7167.vercel.app/

## 2. Run the judge flow

1. Select **Discover and build plan**.
2. Observe six discovered tools and one quarantined hostile tool.
3. Select **Execute safe steps**.
4. Inspect the seven-node graph and the £184.90 recommendation.
5. Select **Test agent self-approval guard**. Execution must remain blocked.
6. Select **Approve exactly these actions**.
7. Select **Execute approved holds**.
8. Confirm two synthetic holds appear and the plan completes.
9. Try the execution action again through `window.ToolBraidApp.runApprovedActions('webmcp-agent')`; the result must be `approval_replay_blocked`.

## 3. Inspect WebMCP

In a native WebMCP browser, ToolBraid registers provider tools and four orchestration tools. It intentionally registers no approval tool. The agent may plan and execute read-only work, but only the human UI can create the approval record.

## 4. Run locally

```bash
npm run validate:ci
npm run build
npm run e2e:standalone
npm run check:release
npm run e2e:release
```

## 5. Evidence

- `docs/e2e-modular-build-validation.json`
- `docs/e2e-release-validation.json`
- `docs/e2e-deployment-bootstrap-validation.json`
- `docs/release-contract.log`
- `docs/video-file-validation.json`
- `docs/final-validation-report.md`
