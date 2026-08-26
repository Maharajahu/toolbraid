# Build Provenance

ToolBraid has one source repository and three inspectable release forms.

| Layer | Path | Purpose |
|---|---|---|
| Modular source | `index.html`, `js/`, `providers/` | Readable architecture and development |
| Standalone build | `dist/index.html` | Exact self-contained modular artifact |
| Production release | `release/index.html` | Audited single-file Vercel release |
| Deployment transport | `deploy/` | Compressed transport for constrained deployment connectors |

## Reproduction

```bash
npm run validate:ci
npm run build
npm run check:release
npm run build:deploy
```

## Verification

```bash
E2E_REPORT=docs/e2e-modular-build-validation.json \
  python3 scripts/e2e-standalone.py dist/index.html

E2E_REPORT=docs/e2e-release-validation.json \
  python3 scripts/e2e-standalone.py release/index.html

E2E_REPORT=docs/e2e-deployment-bootstrap-validation.json \
  python3 scripts/e2e-standalone.py deploy/index.html
```

Final ZIP, Git bundle and video hashes are recorded in `ToolBraid-Final-SHA256.txt` in the submission package.
