# Contributing

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
npm run test:e2e
```

New capabilities require an ontology entry, provider-independent schema aliases, canonical output validation, graph dependencies, risk policy, and positive plus adversarial tests. Native providers must register from their own document with an explicit `exposedTo` origin allowlist.

Security reports follow [SECURITY.md](SECURITY.md).
