# Contributing

ToolBraid accepts focused changes that preserve its browser and human-authority
boundaries. Use Node.js 20 or newer. Python is required only for the recovery
browser E2E path.

Changes must preserve these invariants:

1. provider metadata and outputs are untrusted data;
2. quarantined tools never enter the graph;
3. automatic failover is limited to read-only work;
4. external mutations fail closed without exact human approval;
5. approval cannot be created through an agent-accessible surface;
6. every decision and call remains auditable.

## Development

```bash
npm run dev
npm run test
npm run validate
npm run test:universal
```

Before opening a pull request, also run the browser gate relevant to the files
you changed:

```bash
npm run test:e2e
npm run test:universal:e2e
```

Do not commit `.env`, provider credentials, browser profiles, generated builds,
model weights, voice references, or files from `video-production/output/`.
Use `.env.example` only as a schema for local configuration.

Keep pull requests narrow, describe the user-visible effect, and include a
positive test plus the closest fail-closed or adversarial case. Do not weaken
origin, session, fingerprint, approval, replay, or audit bindings to make a test
pass.

New capabilities require an ontology entry, provider-independent schema aliases, canonical output validation, graph dependencies, risk policy, and positive plus adversarial tests. Native providers must register from their own document with an explicit `exposedTo` origin allowlist.

Security reports follow [SECURITY.md](SECURITY.md).
