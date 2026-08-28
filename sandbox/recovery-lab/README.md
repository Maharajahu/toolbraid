# ToolBraid Recovery Lab

A disposable Vercel target for demonstrating a **real incident and a real rollback** without touching customer systems.

The two directories are complete deployments of the same project. The demonstration uses two consecutive real commits so GitHub and Vercel return the same immutable release identities:

| Version | `/api/health` | Checkout | Purpose |
| --- | --- | --- | --- |
| `stable/` | HTTP `200`, `status: healthy` | 99.98% success | Known-good rollback target |
| `degraded/` | HTTP `503`, `status: degraded` | 37.6% failure | Intentional incident deployment |

Both versions have a self-contained status UI, a Vercel Node.js function, CORS-enabled JSON responses, and no dependencies or secrets.

## Deploy both versions to one Vercel project

Run these commands from `sandbox/recovery-lab` in PowerShell. The first two commands link **both directories to the exact same Vercel project**.

```powershell
npx vercel@latest link --cwd .\stable --project toolbraid-recovery-lab --yes
npx vercel@latest link --cwd .\degraded --project toolbraid-recovery-lab --yes
```

### 1. Commit and deploy the stable baseline first

Commit the stable lab before adding the degraded directory. Record its full SHA and push the branch so GitHub can return it:

```powershell
$stableSha = git rev-parse HEAD
git push origin competition-final
```

```powershell
npx vercel@latest deploy --cwd .\stable --prod --yes `
  --meta "githubCommitSha=$stableSha" `
  --meta "githubCommitRef=competition-final"
```

Save the immutable deployment URL printed by Vercel as `STABLE_DEPLOYMENT_URL`. Verify it before introducing the incident:

```powershell
Invoke-RestMethod "https://<production-domain>/api/health"
```

Expected result: HTTP `200`, version `2026.08.28-stable`, checkout state `operational`.

### 2. Commit and deploy the intentionally degraded release

Add the degraded directory in the next commit, push it, and use that different full SHA as deployment metadata:

```powershell
$degradedSha = git rev-parse HEAD
git push origin competition-final
```

```powershell
npx vercel@latest deploy --cwd .\degraded --prod --yes `
  --meta "githubCommitSha=$degradedSha" `
  --meta "githubCommitRef=competition-final"
```

The same production domain now serves the bad release. Verify while preserving the HTTP 503 response body:

```powershell
$result = Invoke-WebRequest "https://<production-domain>/api/health" -SkipHttpErrorCheck
$result.StatusCode
$result.Content
```

Expected result: HTTP `503`, version `2026.08.28-bad`, checkout failure rate `37.6`, and `rollbackRecommended: true`.

Configure ToolBraid's `TOOLBRAID_GITHUB_REF` with `$degradedSha`. The source provider then reads the exact degraded commit and its parent, while the Vercel provider reports those same SHAs from deployment metadata. ToolBraid deliberately fails closed if they do not match.

### 3. Execute and prove the real rollback

ToolBraid can request this operation through its approved Vercel action. The direct Vercel equivalent is:

```powershell
npx vercel@latest rollback <STABLE_DEPLOYMENT_URL> --cwd .\stable
```

Re-run the health request against the unchanged production domain. It must return HTTP `200` and version `2026.08.28-stable`. The alias change and the health transition are the observable proof that a real rollback occurred. Because the degraded deployment is created immediately after the stable one, this rollback targets the previous production deployment and also works within the Vercel Hobby rollback limit.

## Safety boundary

This project is intentionally disposable. It contains no user data, payment system, external credentials, or production dependencies. The degraded deployment changes only this sandbox's public status and health response. A rollback is safe to repeat during judging and video recording.
