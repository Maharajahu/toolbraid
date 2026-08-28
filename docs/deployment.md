# Deployment

## Active public topology

ToolBraid is deployed as seven independent Vercel projects so every WebMCP provider retains a distinct HTTPS origin:

| Role | Production URL |
|---|---|
| Mission control | <https://toolbraid-webmcp.vercel.app> |
| Service signals | <https://toolbraid-signals-webmcp.vercel.app> |
| Pulse fallback | <https://toolbraid-pulse-webmcp.vercel.app> |
| Release source | <https://toolbraid-source-webmcp.vercel.app> |
| Deploy control | <https://toolbraid-deploy-webmcp.vercel.app> |
| Customer status | <https://toolbraid-status-webmcp.vercel.app> |
| Mirage fixture | <https://toolbraid-mirage-webmcp.vercel.app> |

The mission-control project serves `_toolbraid_origins/app`. Each provider project serves only its matching `_toolbraid_origins/<provider>` root. Every response is `Cache-Control: no-store`; the app CSP and `Permissions-Policy` allow only the six exact provider origins, while each provider allows only mission control and exposes its tools only to that origin.

## Reproducible seven-project release

```bash
npm run build:vercel:stable
npm run validate:vercel:stable
```

The tracked manifest [vercel-stable-projects.json](../deployment/vercel-stable-projects.json) pins each production alias to its Vercel project. The build writes seven self-contained deployment roots below `dist/vercel-stable-projects/`; each root contains only its own public files plus its exact CSP and Permissions Policy in a local `vercel.json`.

With the [Vercel CLI](https://vercel.com/docs/cli) authenticated, release all seven roots with:

```powershell
npm run deploy:vercel:stable
```

That script links every generated root to the exact project name in the manifest before running `vercel deploy --prod`. Do not run `vercel --prod` from the repository root for the active `.vercel.app` projects: the root `vercel.json` belongs only to the inactive branded-domain artifact.

## Public verification

```powershell
$env:TOOLBRAID_NATIVE_BASE_URL = 'https://toolbraid-webmcp.vercel.app'
$env:TOOLBRAID_NATIVE_READ_ONLY = '1'
npm run test:native
```

The public automated gate stops at the human review checkpoint and records `mutationExecution: false` in [native-public-readonly-validation.json](native-public-readonly-validation.json).

## Optional branded-domain profile

The root [vercel.json](../vercel.json) and `npm run build:vercel` retain the alternative one-project `*.toolbraid.dev` routing profile for future branded DNS. Those domains and that build are not the active judge deployment.
