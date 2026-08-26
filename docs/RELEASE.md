# Release checklist

ToolBraid releases are source-and-evidence changes. A release is not complete
until the branch has a committed, remotely visible SHA and all validation gates
pass.

## Required gates

From the repository root, run with Node.js 20+:

```sh
npm test
npm run check
node --test test/release/*.test.js
```

Review failures as defects. The release suite validates syntax and selected
security/delivery invariants; it does not replace a threat review, dependency
or image scan, authorization review, or deployment smoke test.

## Review checklist

- Confirm only the six public MCP tools are exposed.
- Confirm every mutating path requires a trusted, bound, expiring, single-use
  approval and that replay remains read-only.
- Confirm identity is explicit and no tenant/user default is process-global.
- Confirm provider/page data is untrusted and audit output is redacted.
- Review changes to adapter origins, capabilities, schemas, and egress policy.
- Review `SECURITY.md` and the threat-control matrix for new residual risk.
- Build the container from the checked-out commit, run as non-root, and scan
  the resulting digest. Do not promote an unpinned image.

## Evidence to retain

Record the commit SHA, reviewer, Node versions, CI run URL, exact outputs (or
artifacts) for the three gates above, container digest/scan result, deployment
configuration revision, and rollback owner. If state or approvals are
persistent in the target environment, include backup/restore evidence.

## Rollback

Stop new ingress, revoke outstanding approvals that could target the affected
revision, preserve audit evidence, and redeploy the last known-good commit and
image digest. After recovery, verify workflow state and nonce consumption before
reopening traffic. Never use replay to reproduce a mutating node.
