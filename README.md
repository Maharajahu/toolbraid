# ToolBraid

**A semantic action layer that turns fragmented WebMCP capabilities into one explainable, human-controlled execution plan.**

ToolBraid is an OpenAI WebMCP Challenge project. It accepts a user goal, discovers provider tools, maps incompatible names and schemas into canonical capabilities, builds a dependency graph, runs read-only work, and stops before any state-changing action until the human approves the exact provider, option and price.

**Live application:** https://toolbraid-dumitrescu91dan-7167.vercel.app/

## Why it exists

WebMCP makes individual websites callable by agents, but each provider still exposes different names, schemas, risk semantics and result shapes. ToolBraid supplies the missing orchestration layer:

```text
user intent
   ↓
dynamic tool discovery
   ↓
semantic capability normalization
   ↓
explainable execution DAG
   ↓
read-only execution
   ↓
human-bound approval
   ↓
reversible state changes
```

The challenge scenario combines transport, accommodation and walking-distance providers. The product discovers six tools across four provider documents, quarantines one malicious tool description, normalizes the remaining tools into five canonical capabilities, builds a seven-node plan, executes five safe nodes, and requires human approval before creating two synthetic reversible holds.

## Memorable demo result

- Route: Coventry → London, £39.90
- Stay: Point A Liverpool Street, £145.00
- Total: £184.90
- Budget: £250.00
- Remaining: £65.10
- Walking access: 13 minutes
- State changes: two synthetic 15-minute holds, only after approval

No real purchase, payment or external booking occurs.

## Security model

Tool metadata and results are treated as untrusted input.

- Hostile tool descriptions are quarantined before planning.
- Input and canonical output schemas are validated.
- Automatic fallback is restricted to read-only operations.
- Mutating actions never fail over automatically.
- Approval is created only by the human UI.
- Approval is fingerprint-bound to the plan, provider, option, price and action set.
- Approval is atomically consumed before mutation.
- Replays and post-approval mutations are blocked.
- The production deployment sends `Permissions-Policy: tools=(self)`.

See [`docs/threat-model.md`](docs/threat-model.md) and [`docs/JUDGING.md`](docs/JUDGING.md).

## Repository map

```text
.
├── index.html                    # Modular development application
├── css/styles.css
├── js/
│   ├── app.js                    # Product orchestration and UI
│   └── core/                     # Discovery, normalization, planning, execution, approval
├── providers/                    # Four independently registered provider documents
├── release/index.html            # Single-file production release
├── dist/index.html               # Generated modular standalone artifact
├── deploy/                       # Compressed Vercel transport artifact
├── tests/                        # Unit and security-contract tests
├── scripts/                      # Build, validation and E2E tooling
└── docs/                         # Architecture, evidence and submission material
```

## Local development

Requirements:

- Node.js 20+
- Python 3.11+
- Playwright Python package
- Chromium

```bash
npm run validate:ci
npm run serve
```

Open `http://127.0.0.1:4173`.

## Build and validation

```bash
npm run validate:ci
npm run build
npm run e2e:standalone
npm run check:release
npm run e2e:release
npm run build:deploy
E2E_REPORT=docs/e2e-deployment-bootstrap-validation.json \
  python3 scripts/e2e-standalone.py deploy/index.html
```

The browser test executes the full flow at desktop and mobile viewports, including discovery, quarantine, planning, safe execution, blocked self-approval, human approval, two holds and replay rejection.

## WebMCP integration

When the browser exposes `document.modelContext.registerTool()` or `navigator.modelContext.registerTool()`, ToolBraid registers provider and orchestration tools natively. The deterministic compatibility runtime supports repeatable testing in browsers where the experimental API is unavailable.

The public orchestration surface deliberately contains no approval tool:

- `toolbraid_plan`
- `toolbraid_execute_safe`
- `toolbraid_status`
- `toolbraid_execute_approved`

Human approval remains a UI-only authority.

## Production

The Vercel project is configured by `vercel.json`. The root route serves the audited `release/index.html`, with security headers and no framework build dependency.

## Documentation

- [Start here](START-HERE.md)
- [Judge guide](docs/JUDGING.md)
- [Architecture](docs/architecture.md)
- [Product specification](docs/product-spec.md)
- [Threat model](docs/threat-model.md)
- [Testing](docs/testing.md)
- [Build provenance](docs/build-provenance.md)
- [Submission copy](docs/submission-description.md)
- [Final validation report](docs/final-validation-report.md)

## Limitations

The included providers are deterministic challenge fixtures, not commercial booking partners. ToolBraid proves the orchestration, safety and WebMCP interaction model without creating real financial transactions. Native WebMCP execution must be judged in a browser build that exposes the experimental API; the compatibility path is included for reliable inspection and automated testing.

## License

MIT. See [`LICENSE`](LICENSE).
