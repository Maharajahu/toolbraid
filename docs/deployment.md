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

The stable Vercel profile uses server-side integrations on five providers. `signals` and `pulse` probe the allowlisted recovery-lab health URL, `source` reads the allowlisted GitHub repository, `deploy` reads deployments and applies a signed approved rollback, and `status` reads/appends to one allowlisted GitHub issue. `mirage` stays an intentionally hostile local fixture for quarantine evidence. Browser requests carry only the public alias `checkout`; repository, project, issue, health URL, and credentials are resolved exclusively from server environment variables.

## Live-service environment

Use [.env.example](../.env.example) as the variable contract. Store real values in Vercel project settings, never in Git or browser code.

| Project | Required variables |
|---|---|
| `toolbraid-signals-webmcp`, `toolbraid-pulse-webmcp` | `TOOLBRAID_VERCEL_HEALTH_URL` |
| `toolbraid-source-webmcp` | `TOOLBRAID_GITHUB_TOKEN`, `TOOLBRAID_GITHUB_REPOSITORY`, `TOOLBRAID_GITHUB_REF`, `TOOLBRAID_GITHUB_INCIDENT_ISSUE` |
| `toolbraid-deploy-webmcp` | `TOOLBRAID_VERCEL_TOKEN`, `TOOLBRAID_VERCEL_PROJECT_ID`, optional `TOOLBRAID_VERCEL_TEAM_ID`, `TOOLBRAID_RECOVERY_SIGNING_SECRET` |
| `toolbraid-status-webmcp` | `TOOLBRAID_GITHUB_TOKEN`, `TOOLBRAID_GITHUB_REPOSITORY`, `TOOLBRAID_GITHUB_REF`, `TOOLBRAID_GITHUB_INCIDENT_ISSUE` |

Use a fine-grained GitHub token restricted to the single repository with Contents read and Issues read/write. Set `TOOLBRAID_GITHUB_REF` to the exact 40-character degraded-release commit SHA attached to the active recovery-lab deployment. Restrict the Vercel token to the account that owns only the disposable `toolbraid-recovery-lab` target. The recovery lab must have the stable deployment immediately before the intentionally degraded deployment; see [its runbook](../sandbox/recovery-lab/README.md).

## Reproducible seven-project release

```bash
npm run build:vercel:stable
npm run validate:vercel:stable
```

The tracked manifest [vercel-stable-projects.json](../deployment/vercel-stable-projects.json) pins each production alias to its Vercel project. The build writes seven self-contained deployment roots below `dist/vercel-stable-projects/`; each root contains only its own public files plus its exact CSP and Permissions Policy in a local `vercel.json`.

With the [Vercel CLI](https://vercel.com/docs/cli) authenticated, release all seven roots with:

```powershell
$env:TOOLBRAID_VERCEL_SCOPE = '<exact-user-or-team-slug>'
npm run deploy:vercel:stable
```

That script links every generated root to the exact project name in the manifest, deploys all providers before mission control, then runs the native public read-only gate. Do not run `vercel --prod` from the repository root for the active `.vercel.app` projects: the root `vercel.json` belongs only to the inactive branded-domain artifact.

## Public verification

```powershell
$env:TOOLBRAID_NATIVE_BASE_URL = 'https://toolbraid-webmcp.vercel.app'
$env:TOOLBRAID_NATIVE_READ_ONLY = '1'
npm run test:native
```

The public automated gate stops at the human review checkpoint and records `mutationExecution: false` in [native-public-readonly-validation.json](native-public-readonly-validation.json).

## Optional branded-domain profile

The root [vercel.json](../vercel.json) and `npm run build:vercel` retain the alternative one-project `*.toolbraid.dev` routing profile for future branded DNS. Those domains and that build are not the active judge deployment.
