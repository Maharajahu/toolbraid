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
  subject: {
    type: 'string',
    minLength: 1,
    description: 'Explicit user or subject identity (runtime alias for subjectId).',
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
      subject: { type: 'string', minLength: 1 },
    },
    required: ['tenantId'],
    anyOf: [
      { required: ['subjectId'] },
      { required: ['subject'] },
      { required: ['userId'] },
    ],
    additionalProperties: false,
  },
});

const commonProperties = Object.freeze({
  ...identityProperties,
  origin: { type: 'string', minLength: 1 },
});

const explicitIdentity = Object.freeze({
  anyOf: [
    { required: ['tenantId', 'subjectId'] },
    { required: ['tenantId', 'subject'] },
    { required: ['tenantId', 'userId'] },
    { required: ['identity'] },
  ],
});

function objectSchema(properties, description, constraints = []) {
  return {
    $schema: schemaUrl,
    type: 'object',
    description,
    properties: {
      ...commonProperties,
      ...properties,
    },
    allOf: [explicitIdentity, ...constraints],
    additionalProperties: false,
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
        tags: { type: 'array', items: { type: 'string', minLength: 1 } },
        readOnly: { type: 'boolean' },
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
        version: { type: 'string', minLength: 1 },
      },
      'Describe a semantic capability without invoking it.',
      [{ anyOf: [{ required: ['capabilityId'] }, { required: ['id'] }, { required: ['name'] }] }],
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
        request: { type: 'object' },
        goal: { type: 'string', minLength: 1 },
        nodes: { type: 'array', items: { type: 'object' } },
        steps: { type: 'array', items: { type: 'object' } },
        action: { type: 'string', minLength: 1 },
        capabilityId: { type: 'string', minLength: 1 },
        operation: { type: 'string', minLength: 1 },
        productId: { type: 'string', minLength: 1 },
        quantity: { type: 'integer', minimum: 1 },
        args: { type: 'object' },
        workflowId: { type: 'string', minLength: 1 },
        revision: { type: 'integer', minimum: 1 },
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
        id: { type: 'string', minLength: 1 },
        revision: { type: 'integer', minimum: 1 },
      },
      'Execute only an approved, policy-checked workflow; arbitrary code and shell commands are not accepted.',
      [{ anyOf: [{ required: ['workflowId'] }, { required: ['id'] }] }],
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
        id: { type: 'string', minLength: 1 },
        revision: { type: 'integer', minimum: 1 },
      },
      'Read workflow state without changing it.',
      [{ anyOf: [{ required: ['workflowId'] }, { required: ['id'] }] }],
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
        id: { type: 'string', minLength: 1 },
        revision: { type: 'integer', minimum: 1 },
        nodeIds: {
          type: 'array',
          minItems: 1,
          maxItems: 100,
          uniqueItems: true,
          items: { type: 'string', minLength: 1 },
        },
        limit: { type: 'integer', minimum: 1, maximum: 100 },
      },
      'Replay recorded read-only nodes only; mutation nodes are excluded.',
      [{ anyOf: [{ required: ['workflowId'] }, { required: ['id'] }] }],
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
