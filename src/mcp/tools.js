import { cloneJson } from './protocol.js';

/** The only tools this server exposes on the public MCP surface. */
export const PUBLIC_TOOL_NAMES = Object.freeze([
  'capabilities.search',
  'capabilities.describe',
  'plan.propose',
  'workflow.execute',
  'workflow.status',
  'workflow.replay_readonly',
]);

const schemaUrl = 'https://json-schema.org/draft/2020-12/schema';

const identityProperties = Object.freeze({
  tenantId: {
    type: 'string',
    minLength: 1,
    description: 'Explicit tenant/workspace identity. Never inferred from process state.',
  },
  subjectId: {
    type: 'string',
    minLength: 1,
    description: 'Explicit user or subject identity.',
  },
  userId: {
    type: 'string',
    minLength: 1,
    description: 'Explicit user identity (subjectId is preferred).',
  },
  identity: {
    type: 'object',
    description: 'Explicit identity object when a caller uses a nested contract.',
    properties: {
      tenantId: { type: 'string', minLength: 1 },
      subjectId: { type: 'string', minLength: 1 },
      userId: { type: 'string', minLength: 1 },
    },
    additionalProperties: false,
  },
});

const commonProperties = Object.freeze({
  ...identityProperties,
  requestId: { type: 'string', minLength: 1 },
  origin: { type: 'string', minLength: 1 },
  metadata: { type: 'object' },
  options: { type: 'object' },
});

function objectSchema(properties, description) {
  return {
    $schema: schemaUrl,
    type: 'object',
    description,
    properties: {
      ...commonProperties,
      ...properties,
    },
    // Unknown fields are retained for forward-compatible workflow contracts;
    // the gateway still validates every declared field and all arguments must
    // be a JSON object.  The core policy layer remains responsible for
    // semantic/authorization checks.
    additionalProperties: true,
  };
}

const definitions = [
  {
    name: 'capabilities.search',
    title: 'Search capabilities',
    description:
      'Search semantic capabilities available to an explicit tenant and subject. This only discovers capabilities; it does not execute an action.',
    inputSchema: objectSchema(
      {
        query: { type: 'string', minLength: 1 },
        kind: { type: 'string', minLength: 1 },
        adapter: { type: 'string', minLength: 1 },
        limit: { type: 'integer', minimum: 1, maximum: 100 },
        cursor: { type: 'string', minLength: 1 },
      },
      'Search semantic capabilities without executing them.',
    ),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  {
    name: 'capabilities.describe',
    title: 'Describe a capability',
    description:
      'Read the schema and safety metadata for one semantic capability in an explicit tenant and subject context.',
    inputSchema: objectSchema(
      {
        capabilityId: { type: 'string', minLength: 1 },
        id: { type: 'string', minLength: 1 },
        name: { type: 'string', minLength: 1 },
      },
      'Describe a semantic capability without invoking it.',
    ),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  {
    name: 'plan.propose',
    title: 'Propose a workflow plan',
    description:
      'Construct a policy-checkable workflow proposal for an explicit tenant and subject. Proposal creation does not execute nodes.',
    inputSchema: objectSchema(
      {
        objective: { type: 'string', minLength: 1 },
        intent: { type: 'string', minLength: 1 },
        workflow: { type: 'object' },
        nodes: { type: 'array', items: { type: 'object' } },
        constraints: { type: 'object' },
        revision: { type: ['string', 'integer'] },
      },
      'Propose a workflow for policy review; no node is executed by this tool.',
    ),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  },
  {
    name: 'workflow.execute',
    title: 'Execute an approved workflow',
    description:
      'Execute a previously proposed workflow only when a trusted, server-side approval record is valid and bound to this request.',
    inputSchema: objectSchema(
      {
        workflowId: { type: 'string', minLength: 1 },
        revision: { type: ['string', 'integer'] },
        approvalId: { type: 'string', minLength: 1 },
        approvalNonce: { type: 'string', minLength: 1 },
        arguments: { type: 'object' },
        input: { type: 'object' },
        dryRun: { type: 'boolean' },
      },
      'Execute only an approved, policy-checked workflow; arbitrary code and shell commands are not accepted.',
    ),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  },
  {
    name: 'workflow.status',
    title: 'Get workflow status',
    description:
      'Read the current state and audit-safe progress of a workflow in an explicit tenant and subject context.',
    inputSchema: objectSchema(
      {
        workflowId: { type: 'string', minLength: 1 },
        runId: { type: 'string', minLength: 1 },
        revision: { type: ['string', 'integer'] },
      },
      'Read workflow state without changing it.',
    ),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  {
    name: 'workflow.replay_readonly',
    title: 'Replay read-only workflow nodes',
    description:
      'Replay only recorded read-only nodes for an explicit workflow context; mutations are never replayed.',
    inputSchema: objectSchema(
      {
        workflowId: { type: 'string', minLength: 1 },
        runId: { type: 'string', minLength: 1 },
        revision: { type: ['string', 'integer'] },
        nodeIds: { type: 'array', items: { type: 'string', minLength: 1 } },
        limit: { type: 'integer', minimum: 1, maximum: 100 },
      },
      'Replay recorded read-only nodes only; mutation nodes are excluded.',
    ),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
];

const byName = new Map(definitions.map((definition) => [definition.name, definition]));

export function getToolDefinition(name) {
  const definition = byName.get(name);
  return definition ? cloneJson(definition) : undefined;
}

export function getToolDefinitions() {
  return definitions.map((definition) => cloneJson(definition));
}

export function hasPublicTool(name) {
  return byName.has(name);
}

export function getToolSchema(name) {
  return byName.get(name)?.inputSchema;
}

