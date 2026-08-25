# ToolBraid Final Validation Report

**Validation date:** 25 August 2026
**Build:** 0.1.0
**Decision:** **TECHNICAL MVP PASS · EXTERNAL SUBMISSION ITEMS PENDING**

ToolBraid is functionally complete as a reproducible WebMCP Challenge MVP. The source tree, semantic engine, security controls, orchestration UI, provider fixtures, tests, challenge documentation, recording script, and deployment workflow are present and validated.

The project is **not yet a complete Devpost submission** because three activities require external publication channels: creating a public repository, deploying a public URL, and uploading the already-rendered demo to public YouTube.

## Executive scorecard

| Area | Status | Evidence |
|---|---|---|
| Product implementation | **PASS** | Runnable browser application in repository root |
| Native WebMCP source path | **PASS** | Explicit `document.modelContext.registerTool()` registration |
| Dynamic provider discovery | **PASS** | Four independent iframe providers discovered at runtime |
| Semantic capability normalization | **PASS** | Five heterogeneous tools mapped from names, descriptions, and schemas |
| Hostile metadata quarantine | **PASS** | Adversarial provider excluded before planning |
| Cross-site dependency planning | **PASS** | Seven-node DAG across transport, accommodation, and location providers |
| Safe-step execution | **PASS** | Five non-mutating nodes execute before approval |
| Agent self-approval prevention | **PASS** | Approved-execution call fails closed before human UI approval |
| Human approval boundary | **PASS** | Two exact plan nodes approved through visible UI only |
| Reversible external actions | **PASS** | Two synthetic temporary holds created after approval |
| Desktop browser flow | **PASS** | Chromium E2E and screenshot evidence |
| Mobile responsive flow | **PASS** | 390 px viewport, no horizontal overflow, approval control visible |
| Unit and contract tests | **PASS** | 11 passed, 0 failed |
| Browser E2E | **PASS** | Complete mission validated with zero browser errors |
| Documentation and submission copy | **PASS** | README plus product, architecture, security, demo, video, and Devpost documents |
| Open-source license | **PASS** | MIT license at repository root |
| Public repository | **PENDING** | External repository creation/publication required |
| Public live URL | **PENDING** | Vercel, GitHub Pages, or equivalent deployment required |
| Public YouTube demo | **RENDERED · PENDING PUBLIC UPLOAD** | Validated 156.9-second captioned MP4, SRT, and thumbnail are present |

## Final automated validation

Commands executed:

```bash
npm run check
npm test
E2E_PYTHON=/opt/pyvenv/bin/python \
E2E_CHROMIUM=/usr/bin/chromium \
npm run test:e2e
```

Results:

```text
Project integrity:  PASS
Required artifacts: 32
JavaScript modules: 22
Unresolved markers: 0
Unit tests:          11 passed, 0 failed
Browser E2E:         PASS
Browser errors:      0
```

Validated runtime:

```text
Node.js:     22.16.0
Chromium:    144.0.7559.96
Playwright:  1.57.0
Viewport 1:  1600 × 1100
Viewport 2:  390 × 844
```

The structured E2E result is stored in [`e2e-validation.json`](e2e-validation.json).

## Browser mission evidence

The final E2E run asserted the complete workflow, not merely page availability.

| Measurement | Result |
|---|---:|
| Provider website contexts | 4 |
| Provider tools discovered | 6 |
| Tools quarantined | 1 |
| Canonical capabilities available | 5 |
| Plan nodes | 7 |
| Safe/composition nodes completed before approval | 5 |
| Human approval gates | 2 |
| Selected mission total | £184.90 |
| Remaining budget | £65.10 |
| Walking time | 13 minutes |

Selected result:

- **Transport:** West Midlands Railway, £39.90, 07:45 to 09:03
- **Accommodation:** Point A Liverpool Street, £145.00
- **Destination access:** 1 km, 13 minutes walking
- **Temporary holds:** `VR-HOLD-VR-0745` and `NS-HOLD-NS-POINT-A`

The approval record was asserted as:

```json
{
  "source": "human",
  "channel": "human-ui",
  "actionIds": ["travel-hold", "stay-hold"]
}
```

Before this record existed, an attempted call to `toolbraid.execute_approved_actions` through the agent-facing surface was verified to leave both holds empty and the phase at `approval_required`.

## Validation loop 1: engineering review

### Findings resolved

- Route extraction was corrected for the natural-language mission format.
- Semantic thresholds were adjusted so unfamiliar but well-described tool names map correctly.
- Risk classification now treats mutating semantics as authoritative even when a provider claims `readOnlyHint`.
- Negated purchase language such as “does not purchase” no longer misclassifies a reversible hold as a payment.
- Approval creation was removed from the public test/agent API and confined to the visible UI event path.
- E2E timing waits for provider registration instead of assuming script availability.
- The browser server uses a random free port to avoid stale-process collisions.
- Mobile layout validation was added at 390 px.

### Engineering conclusion

**PASS.** No unresolved implementation markers, syntax failures, failing tests, browser console errors, or known broken mission paths remain in the validated MVP.

## Validation loop 2: product and challenge review

### WebMCP centrality

**PASS.** WebMCP is the product substrate rather than a decorative registration call:

- provider websites publish their own tools;
- ToolBraid discovers the tools at runtime;
- semantics and schemas drive capability mapping;
- execution updates provider state inside the browser;
- ToolBraid exposes its own orchestration controls as WebMCP tools.

### Value clarity

**PASS.** The interface visibly communicates the product thesis:

```text
Goal → Discover → Quarantine → Normalize → Plan → Execute safe work
     → Human approval → Execute selected state changes → Audit
```

### Differentiation

**PASS, bounded claim.** The project does not claim to invent WebMCP transport, registries, multi-server clients, or semantic tool selection in isolation. The submitted novelty claim is the browser-native combination of runtime schema-aware normalization, an explainable capability DAG, hostile-metadata quarantine, and human-owned execution authority.

### Demo focus

**PASS.** One coherent travel mission demonstrates three useful provider domains and one adversarial provider. The demo avoids a feature catalogue and produces a clear “magic moment”: six unfamiliar tools become a seven-step plan while the hostile tool is excluded and the final two actions stop at a human checkpoint.

## Validation loop 3: submission readiness

### Ready now

- complete source package;
- MIT license;
- polished README;
- product specification;
- architecture document;
- prior-art review and competitor matrix;
- threat model;
- testing guide and machine-readable E2E output;
- desktop and mobile screenshot evidence;
- demo script;
- under-three-minute narration script;
- rendered 156.9-second captioned demo MP4, SRT, thumbnail, and media validation;
- Devpost submission copy;
- GitHub Pages deployment workflow;
- publication runbook with repository, deployment, native smoke-test, YouTube, and Devpost steps.

### External blockers

| Item | Required completion action |
|---|---|
| Public repository | Create a new public repository and push the local `main` branch. |
| Public live URL | Enable GitHub Pages or deploy the static root through Vercel/Netlify. |
| Public YouTube video | Upload the validated captioned MP4 publicly and copy the YouTube URL. |
| Final Devpost submission | Insert the three public URLs and complete the entrant eligibility declaration. |

These items are operational publication tasks, not missing product functionality.

## Native WebMCP verification boundary

The E2E run used ToolBraid's standards-aligned local runtime because the available managed browser was Chromium 144. The native source path is explicit, covered by project integrity checks, and follows the `document.modelContext` interface, but native behavior must still be revalidated in the exact WebMCP-enabled browser used for the final demo.

This limitation is reported rather than disguised as a native-runtime pass.

## Security review conclusion

**PASS for the synthetic challenge MVP.** The implementation:

- treats names, descriptions, schemas, annotations, and results as untrusted;
- quarantines instruction-like and exfiltration-oriented metadata;
- rejects unmapped or low-confidence capabilities;
- infers mutation risk independently of provider claims;
- prevents an agent-facing method from manufacturing approval;
- records the approved action IDs and source;
- performs only synthetic reversible holds;
- stores no credentials, cookies, payment details, or session tokens.

Production hardening still requires signed provider identity, strict multi-origin exposure policy, full JSON Schema validation, output validation, single-use plan-bound approval tokens, transaction verification, compensation logic, and tamper-evident audit persistence.

## Remaining product limitations

- Provider sites are deterministic fixtures, not commercial booking services.
- The capability ontology is deliberately limited to the travel demo.
- Semantic normalization uses inspectable lexical and schema evidence rather than embeddings or an external model.
- Automatic provider substitution is not implemented; failures stop safely.
- Holds are synthetic and reversible, never purchases or confirmed bookings.
- Native WebMCP browser behavior still requires final-browser validation.

## Release decision

**APPROVED for public repository publication, static deployment, native-browser smoke testing, recording, and challenge submission assembly.**

**NOT YET APPROVED as a completed Devpost submission** until the public repository, live URL, and public YouTube URL exist and are inserted into the submission.
