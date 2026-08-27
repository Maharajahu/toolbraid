import {
  isJsonSafe,
  isPlainObject,
  validateSchema,
  validateSchemaDefinition,
} from '../adapters/contracts.js';
import { CoreError } from './errors.js';

/*
 * Core's capability catalog is a trusted execution boundary.  Keep the
 * schema vocabulary dependency-free, but do not make the planner/broker know
 * about the adapter implementation.  The adapter contract validator is
 * deliberately imported directly (it has no dependency on core), and these
 * helpers convert its diagnostics into bounded CoreErrors.
 *
 * JSON Schema permits boolean schemas.  The adapter contract historically
 * accepted object schemas only, so handle the two boolean forms here while
 * retaining the bounded object validator for all other schemas.
 */

const BOOLEAN_SCHEMA_ERROR = Object.freeze({
  path: '$',
  keyword: 'schema',
  message: 'Schema rejected the value.',
});

function schemaDefinition({ schema, name }) {
  if (schema === true || schema === false) return { valid: true, errors: [] };
  return validateSchemaDefinition({ schema, name });
}

function schemaValue({ value, schema }) {
  if (schema === true) {
    return isJsonSafe({ value })
      ? { valid: true, errors: [] }
      : { valid: false, errors: [{ ...BOOLEAN_SCHEMA_ERROR, keyword: 'json', message: 'Value must be JSON-safe.' }] };
  }
  if (schema === false) return { valid: false, errors: [{ ...BOOLEAN_SCHEMA_ERROR, keyword: 'falseSchema', message: 'Value is not allowed.' }] };
  return validateSchema({ value, schema });
}

function boundedErrors(errors) {
  return Array.isArray(errors)
    ? errors.filter((entry) => entry && typeof entry === 'object').slice(0, 16)
    : [];
}

/**
 * Validate a capability's schema pair before a descriptor can authorize a
 * node.  A malformed schema is never treated as an unconstrained schema.
 */
export function assertCapabilitySchemas({ capability, label = 'capability' } = {}) {
  if (!capability || typeof capability !== 'object' || Array.isArray(capability)) {
    throw new CoreError('INVALID_CAPABILITY', `${label} descriptor is invalid`);
  }
  const inputSchema = capability.inputSchema === undefined ? {} : capability.inputSchema;
  const outputSchema = capability.outputSchema === undefined ? {} : capability.outputSchema;
  let input;
  let output;
  try {
    input = schemaDefinition({ schema: inputSchema, name: `${label}.inputSchema` });
    output = schemaDefinition({ schema: outputSchema, name: `${label}.outputSchema` });
  } catch (error) {
    throw new CoreError('INVALID_CAPABILITY_SCHEMA', `${label} schema could not be validated`, {
      retryable: false,
      cause: error,
    });
  }
  if (!input.valid || !output.valid) {
    throw new CoreError('INVALID_CAPABILITY_SCHEMA', `${label} has an invalid JSON Schema`, {
      retryable: false,
      details: {
        ...(input.valid ? {} : { input: boundedErrors(input.errors) }),
        ...(output.valid ? {} : { output: boundedErrors(output.errors) }),
      },
    });
  }
  return { inputSchema, outputSchema };
}

/**
 * Validate an execution value against a capability schema.  Callers choose
 * the error code/context because an input mismatch invalidates a plan while
 * an output mismatch after a mutation invocation requires reconciliation.
 */
export function assertSchemaValue({
  value,
  schema,
  code = 'INVALID_PLAN',
  message = 'Value does not match the declared JSON Schema',
  reason = 'SCHEMA_VALUE_INVALID',
  label = 'value',
} = {}) {
  let result;
  try {
    result = schemaValue({ value, schema: schema === undefined ? {} : schema });
  } catch (error) {
    throw new CoreError(code, `${label} could not be validated`, {
      retryable: false,
      details: { reason },
      cause: error,
    });
  }
  if (!result.valid) {
    throw new CoreError(code, message, {
      retryable: false,
      details: { reason, errors: boundedErrors(result.errors) },
    });
  }
  return true;
}

export function schemaCheck({ value, schema } = {}) {
  try {
    return schemaValue({ value, schema: schema === undefined ? {} : schema });
  } catch {
    return {
      valid: false,
      errors: [{ path: '$', keyword: 'schema', message: 'Schema validation failed closed.' }],
    };
  }
}

export function isSchemaObject(value) {
  return value === true || value === false || isPlainObject({ value });
}
