# Testing Strategy

ToolBraid is validated at three artifact levels.

## 1. Modular source

`npm run validate:ci` checks required assets, unfinished markers, JavaScript syntax and all unit/security tests.

Coverage includes:

- semantic tool mapping
- hostile metadata quarantine
- risk classification
- DAG construction
- ranked alternatives
- input schema validation
- canonical output validation
- read-only fallback
- no automatic mutation fallback
- plan-bound approval
- option/provider/price binding
- tamper detection
- single-use approval and replay rejection

## 2. Generated standalone artifact

`npm run build` creates `dist/index.html` with all application and provider code embedded. `npm run e2e:standalone` serves that exact file and executes the full mission at 1440×1050 and 390×844.

Assertions include:

- 4 providers
- 6 discovered tools
- 1 quarantined tool
- 7 plan nodes
- 5 safe completed nodes before approval
- £184.90 recommendation
- 13-minute walking result
- agent self-approval blocked
- human approval source
- 64-character SHA-256 plan fingerprint
- two action fingerprints
- two hold IDs
- approval consumption
- replay rejection
- zero material browser errors
- no mobile horizontal overflow

## 3. Production release

`release/index.html` is the audited single-file production build. `npm run check:release` verifies the WebMCP surface, security controls and disclosure text. `npm run e2e:release` runs the same complete browser flow.

## 4. Deployment transport

`npm run build:deploy` compresses the standalone build into a small loader plus eight chunks. The loader is tested as a served artifact, including decompression and document replacement.

## Browser environment

The automated tests use headless Chromium. If native WebMCP is unavailable, ToolBraid uses its compatibility runtime. Native registration remains present and is contract-checked in the production release.
