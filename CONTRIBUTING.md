# Contributing

ToolBraid is an experimental WebMCP challenge project. Contributions should preserve three principles:

1. provider metadata is untrusted data, never instructions;
2. state-changing actions fail closed without human approval;
3. semantic decisions remain inspectable and tested.

## Development

```bash
npm run dev
npm test
```

Before proposing a change, add tests for every new capability, schema alias, risk rule, or execution transition.

## Capability additions

A new domain capability should include:

- a canonical ID and action type;
- semantic keywords and schema cues;
- required concepts;
- input and output aliases;
- planner dependencies;
- risk expectations;
- positive and negative normalization tests;
- at least one provider fixture with non-canonical naming.

## Security changes

Do not add a provider or dependency that requires collecting credentials, bypassing a site's access controls, or automating an irreversible action. Security reports should follow `SECURITY.md`.
