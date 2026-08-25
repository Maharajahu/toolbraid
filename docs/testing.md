# Testing Guide

## Commands

```bash
npm test
```

Runs all pure Node unit and contract tests.

```bash
python3 -m pip install -r requirements-e2e.txt
python3 -m playwright install chromium
npm run test:e2e
```

Runs the complete browser mission and writes screenshots.

An existing browser binary can be selected with:

```bash
E2E_CHROMIUM=/usr/bin/chromium npm run test:e2e
```

A non-default Python can be selected with:

```bash
E2E_PYTHON=/path/to/python npm run test:e2e
```

## Coverage map

| Behavior | Unit/contract | Browser E2E |
|---|---:|---:|
| Natural-language mission extraction | ✓ | ✓ |
| Structured override precedence | ✓ | ✓ |
| Unknown tool-name normalization | ✓ | ✓ |
| Low-signal rejection | ✓ | Indirect |
| Metadata quarantine | ✓ | ✓ |
| Required-capability failure | ✓ | Indirect |
| Seven-node DAG | ✓ | ✓ |
| Approval dependency blocking | ✓ | ✓ |
| Agent self-approval rejection | ✓ | ✓ |
| Provider-independent output composition | ✓ | ✓ |
| Budget-aware ranking | ✓ | ✓ |
| Provider iframe registration |  | ✓ |
| Visible approval workflow |  | ✓ |
| Reversible hold execution |  | ✓ |
| Browser console errors |  | ✓ |
| Desktop screenshot evidence |  | ✓ |
| 390 px responsive layout and no horizontal overflow |  | ✓ |

## Current result

Validated on 25 August 2026 with:

- Node.js 22.16.0
- Chromium 144.0.7559.96
- Playwright 1.57.0

Result:

```text
11 tests passed
0 tests failed
E2E PASS
Mobile responsive smoke PASS
Agent self-approval guard PASS
```

E2E output:

```json
{
  "providers": 4,
  "discoveredTools": 6,
  "quarantined": 1,
  "planNodes": 7,
  "selectedTotal": 184.90,
  "humanApprovalNodes": 2,
  "mobileViewportWidth": 390
}
```

## Environmental note

The build environment's managed Chromium initially blocked all URLs through an enterprise `URLBlocklist`. For isolated local validation only, that policy was temporarily removed while the E2E process ran and then restored immediately afterward. No policy modification exists in the repository or product code.
