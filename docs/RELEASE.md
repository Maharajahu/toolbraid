# Release checklist

ToolBraid releases are source-and-evidence changes. This repository currently
ships only a non-production MVP/reference artifact. A source checkpoint is not
a production admission decision. A release record is not complete until the
branch has a committed, remotely visible SHA and all applicable validation
gates pass.

## Required gates

From the repository root, run with Node.js 20+:

```sh
npm test
npm run check
node --test test/release/*.test.js
npm run smoke
```

Review failures as defects. The release suite validates syntax and selected
security/delivery invariants; it does not replace a threat review, dependency
or image scan, authorization review, or deployment smoke test.

## Review checklist

- Confirm exactly these six public MCP tools are exposed: `capabilities.search`,
  `capabilities.describe`, `plan.propose`, `workflow.execute`,
  `workflow.status`, and `workflow.replay_readonly`.
- Confirm every mutating path requires a trusted, bound, expiring, single-use
  approval and that replay remains read-only.
- Confirm identity is explicit and no tenant/user default is process-global.
- Confirm provider/page data is untrusted, provider descriptors are not
  promoted into catalog authority, and audit output is redacted.
- Review the fixed adapter order (`structured-api`, `webmcp`,
  `dom-accessibility`, `vision`), server-owned selection, explicit origin
  binding, and any egress policy supplied by the deployment.
- Review resource bounds and cooperative cancellation. Do not claim that
  canceling a request rolls back a provider mutation.
- Review `SECURITY.md` and the threat-control matrix for new residual risk.
- Treat the current container as blocked for publication: the Dockerfile is
  non-root but its `node:20-alpine` base is not digest pinned. Build and scan
  only after pinning an immutable base digest; never promote the current
  unpinned image.

## MVP admission boundary

The passing repository gates prove source behavior only. They do not provide
external authentication, durable workflow/approval/audit state, KMS or a
credential vault, browser/profile isolation, enforced egress, production rate
limiting/tenant quotas, or a forced worker cancellation boundary. Those are
explicit deployment/next-step gates, not implied by this release checklist.

## Evidence to retain

Record the commit SHA, reviewer, Node versions, CI run URL, exact outputs (or
artifacts) for the four gates above. A container digest/scan result is required
only for a container publication and is currently unavailable until the base
image is pinned. Also record the deployment
configuration revision, and rollback owner. If state or approvals are
persistent in the target environment, include backup/restore evidence.

## Rollback

Stop new ingress, revoke outstanding approvals that could target the affected
revision, preserve audit evidence, and redeploy the last known-good commit and
image digest. After recovery, verify workflow state and nonce consumption before
reopening traffic. Never use replay to reproduce a mutating node.
