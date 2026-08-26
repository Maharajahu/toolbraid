import test from 'node:test';
import assert from 'node:assert/strict';

import { validateJsonSchema } from '../../src/mcp/index.js';

test('dependency-free JSON Schema validator handles object, scalar and composition rules', () => {
  const schema = {
    type: 'object',
    properties: {
      name: { type: 'string', minLength: 2 },
      count: { type: 'integer', minimum: 1 },
      mode: { enum: ['read', 'write'] },
    },
    required: ['name', 'count'],
    additionalProperties: false,
  };
  assert.equal(validateJsonSchema({ name: 'ok', count: 1, mode: 'read' }, schema).valid, true);
  const invalid = validateJsonSchema({ name: 'x', count: 1, extra: true }, schema);
  assert.equal(invalid.valid, false);
  assert.equal(invalid.errors.some((error) => error.keyword === 'minLength'), true);
  assert.equal(invalid.errors.some((error) => error.keyword === 'additionalProperties'), true);

  const union = validateJsonSchema('x', { oneOf: [{ type: 'string' }, { type: 'number' }] });
  assert.equal(union.valid, true);
  const any = validateJsonSchema(false, { anyOf: [{ type: 'string' }, { const: true }] });
  assert.equal(any.valid, false);
});

