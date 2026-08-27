import { cloneJson } from './protocol.js';
import {
  MAX_NODE_DEPENDENCIES,
  MAX_PLAN_NODES,
} from '../core/planner.js';

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
const ID_PATTERN = '^[A-Za-z0-9][A-Za-z0-9._:@/+\\-]{0,199}$';
const NODE_ID_PATTERN = '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$';
const CAPABILITY_VERSION_PATTERN = '^[A-Za-z0-9][A-Za-z0-9._+\\-]{0,63}$';
const NON_BLANK_TEXT_PATTERN = '^(?!.*[\\u0000-\\u001F\\u007F])\\S(?:.*\\S)?$';
const TRIMMED_TEXT_PATTERN = '^(?!\\s)[\\s\\S]*\\S$';
const CURSOR_PATTERN = '^[0-9]{1,15}$';
const MAX_REVISION = 2_147_483_647;

function boundedString(maxLength, pattern = NON_BLANK_TEXT_PATTERN) {
  return { type: 'string', minLength: 1, maxLength, pattern };
}

const identityProperties = Object.freeze({
  tenantId: {
    ...boundedString(200, ID_PATTERN),
    description: 'Explicit tenant/workspace identity. Never inferred from process state.',
  },
  subjectId: {
    ...boundedString(200, ID_PATTERN),
    description: 'Explicit user or subject identity.',
  },
  subject: {
    ...boundedString(200, ID_PATTERN),
    description: 'Explicit user or subject identity (runtime alias for subjectId).',
  },
  userId: {
    ...boundedString(200, ID_PATTERN),
    description: 'Explicit user identity (subjectId is preferred).',
  },
  identity: {
    type: 'object',
    description: 'Explicit identity object when a caller uses a nested contract.',
    properties: {
      tenantId: boundedString(200, ID_PATTERN),
      subjectId: boundedString(200, ID_PATTERN),
      userId: boundedString(200, ID_PATTERN),
      subject: boundedString(200, ID_PATTERN),
    },
    maxProperties: 4,
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
  origin: boundedString(2048),
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

const dependencyListSchema = {
  type: 'array',
  maxItems: MAX_NODE_DEPENDENCIES,
  uniqueItems: true,
  items: boundedString(128, NODE_ID_PATTERN),
};

const planNodeSchema = {
  type: 'object',
  maxProperties: 24,
  properties: {
    id: boundedString(128, NODE_ID_PATTERN),
    nodeId: boundedString(128, NODE_ID_PATTERN),
    capabilityId: boundedString(128, NODE_ID_PATTERN),
    capability: boundedString(128, NODE_ID_PATTERN),
    operation: boundedString(128, NODE_ID_PATTERN),
    capabilityVersion: boundedString(64, CAPABILITY_VERSION_PATTERN),
    version: boundedString(64, CAPABILITY_VERSION_PATTERN),
    adapter: boundedString(128, NODE_ID_PATTERN),
    adapterId: boundedString(128, NODE_ID_PATTERN),
    origin: boundedString(2048),
    args: { type: 'object' },
    arguments: { type: 'object' },
    dependsOn: dependencyListSchema,
    dependencies: dependencyListSchema,
    after: dependencyListSchema,
    readOnly: { type: 'boolean' },
    mutates: { type: 'boolean' },
    timeoutMs: { type: 'integer', minimum: 1, maximum: 86_400_000 },
  },
  additionalProperties: true,
};

const planNodesSchema = {
  type: 'array',
  minItems: 1,
  maxItems: MAX_PLAN_NODES,
  items: planNodeSchema,
};

const nestedPlanRequestSchema = {
  type: 'object',
  maxProperties: 32,
  properties: {
    nodes: planNodesSchema,
    steps: planNodesSchema,
  },
  additionalProperties: true,
};

const definitions = [
  {
    name: 'capabilities.search',
    title: 'Search capabilities',
    description:
      'Search semantic capabilities available to an explicit tenant and subject. This only discovers capabilities; it does not execute an action.',
    inputSchema: objectSchema(
      {
        query: { type: 'string', minLength: 1 },
        kind: boundedString(500, TRIMMED_TEXT_PATTERN),
        adapter: boundedString(500, TRIMMED_TEXT_PATTERN),
        tags: { type: 'array', items: boundedString(200, TRIMMED_TEXT_PATTERN) },
        readOnly: { type: 'boolean' },
        limit: { type: 'integer', minimum: 1, maximum: 100 },
        cursor: { type: 'string', minLength: 1, maxLength: 15, pattern: CURSOR_PATTERN },
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
        capabilityId: boundedString(128, NODE_ID_PATTERN),
        id: boundedString(128, NODE_ID_PATTERN),
        name: boundedString(128, NODE_ID_PATTERN),
        version: boundedString(64, CAPABILITY_VERSION_PATTERN),
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
        request: nestedPlanRequestSchema,
        goal: boundedString(2000, TRIMMED_TEXT_PATTERN),
        nodes: planNodesSchema,
        steps: planNodesSchema,
        action: boundedString(128, NODE_ID_PATTERN),
        capabilityId: boundedString(128, NODE_ID_PATTERN),
        operation: boundedString(128, NODE_ID_PATTERN),
        productId: boundedString(200, ID_PATTERN),
        quantity: { type: 'integer', minimum: 1 },
        args: { type: 'object' },
        workflowId: boundedString(200, ID_PATTERN),
        revision: { type: 'integer', minimum: 1, maximum: MAX_REVISION },
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
        workflowId: boundedString(200, ID_PATTERN),
        id: boundedString(200, ID_PATTERN),
        revision: { type: 'integer', minimum: 1, maximum: MAX_REVISION },
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
        workflowId: boundedString(200, ID_PATTERN),
        id: boundedString(200, ID_PATTERN),
        revision: { type: 'integer', minimum: 1, maximum: MAX_REVISION },
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
        workflowId: boundedString(200, ID_PATTERN),
        id: boundedString(200, ID_PATTERN),
        revision: { type: 'integer', minimum: 1, maximum: MAX_REVISION },
        nodeIds: {
          type: 'array',
          minItems: 1,
          maxItems: 100,
          uniqueItems: true,
          items: boundedString(128, NODE_ID_PATTERN),
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
  const schema = byName.get(name)?.inputSchema;
  return schema ? deepFreeze(cloneJson(schema)) : undefined;
}

function deepFreeze(value, seen = new Set()) {
  if (value === null || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}
