import { isPlainObject, isJsonValue } from './protocol.js';

/**
 * A small, dependency-free JSON Schema validator.
 *
 * MCP tool schemas are JSON Schema documents.  The gateway only needs the
 * validation vocabulary used by its six public tools, but this implementation
 * intentionally supports the common composition and scalar keywords so a
 * handler can add constraints without bringing a runtime dependency into the
 * server.
 */

const TYPE_NAMES = new Set([
  'null',
  'boolean',
  'object',
  'array',
  'number',
  'integer',
  'string',
]);

function displayPath(path, key) {
  if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)) return `${path}.${key}`;
  return `${path}[${JSON.stringify(key)}]`;
}

function typeMatches(value, type) {
  switch (type) {
    case 'null':
      return value === null;
    case 'boolean':
      return typeof value === 'boolean';
    case 'object':
      return isPlainObject(value);
    case 'array':
      return Array.isArray(value);
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return typeof value === 'number' && Number.isSafeInteger(value);
    case 'string':
      return typeof value === 'string';
    default:
      return true;
  }
}

function sameJson(a, b) {
  if (Object.is(a, b)) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a)) {
    return (
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((item, index) => sameJson(item, b[index]))
    );
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const ak = Object.keys(a);
    const bk = Object.keys(b);
    return (
      ak.length === bk.length &&
      ak.every((key) => Object.prototype.hasOwnProperty.call(b, key) && sameJson(a[key], b[key]))
    );
  }
  return false;
}

function addError(errors, path, keyword, message, expected, actual) {
  errors.push({
    path,
    keyword,
    message,
    ...(expected === undefined ? {} : { expected }),
    ...(actual === undefined ? {} : { actual }),
  });
}

function validateNode(value, schema, path, errors, options) {
  if (schema === true || schema === undefined) return;
  if (schema === false) {
    addError(errors, path, 'falseSchema', 'value is not allowed');
    return;
  }
  if (!isPlainObject(schema)) {
    addError(errors, path, 'schema', 'schema must be an object or boolean');
    return;
  }

  if (schema.$ref !== undefined) {
    // Local references are deliberately not resolved: accepting an unresolved
    // reference would make validation fail open.  Callers can pre-expand
    // schemas or use oneOf/allOf instead.
    addError(errors, path, '$ref', 'unresolved $ref is not supported');
    return;
  }

  if (schema.const !== undefined && !sameJson(value, schema.const)) {
    addError(errors, path, 'const', 'value must equal const', schema.const, value);
  }

  if (Array.isArray(schema.enum)) {
    if (!schema.enum.some((candidate) => sameJson(value, candidate))) {
      addError(errors, path, 'enum', 'value is not one of the allowed values', schema.enum, value);
    }
  }

  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    const validTypeDeclaration = types.every((type) => TYPE_NAMES.has(type));
    if (!validTypeDeclaration) {
      addError(errors, path, 'type', 'schema contains an unknown type', types);
    } else if (!types.some((type) => typeMatches(value, type))) {
      addError(errors, path, 'type', `must be ${types.join(' or ')}`, types, typeof value);
      // Other keywords are not meaningful when the base type is wrong.
      return;
    }
  }

  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      addError(errors, path, 'minLength', `must have at least ${schema.minLength} characters`, schema.minLength, value.length);
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      addError(errors, path, 'maxLength', `must have at most ${schema.maxLength} characters`, schema.maxLength, value.length);
    }
    if (schema.pattern !== undefined) {
      try {
        if (!(new RegExp(schema.pattern)).test(value)) {
          addError(errors, path, 'pattern', 'must match the required pattern', schema.pattern, value);
        }
      } catch {
        addError(errors, path, 'pattern', 'schema contains an invalid pattern', schema.pattern);
      }
    }
    if (schema.format === 'uri' || schema.format === 'uri-reference') {
      try {
        // uri-reference permits relative references; URL accepts both absolute
        // and relative values when a base is supplied.
        if (schema.format === 'uri') new URL(value);
        else new URL(value, 'http://mcp.invalid');
      } catch {
        addError(errors, path, 'format', `must be a valid ${schema.format}`, schema.format, value);
      }
    }
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    if (schema.minimum !== undefined && value < schema.minimum) {
      addError(errors, path, 'minimum', `must be >= ${schema.minimum}`, schema.minimum, value);
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      addError(errors, path, 'maximum', `must be <= ${schema.maximum}`, schema.maximum, value);
    }
    if (schema.exclusiveMinimum !== undefined) {
      const minimum = typeof schema.exclusiveMinimum === 'number' ? schema.exclusiveMinimum : schema.minimum;
      if (minimum !== undefined && value <= minimum) {
        addError(errors, path, 'exclusiveMinimum', `must be > ${minimum}`, minimum, value);
      }
    }
    if (schema.exclusiveMaximum !== undefined) {
      const maximum = typeof schema.exclusiveMaximum === 'number' ? schema.exclusiveMaximum : schema.maximum;
      if (maximum !== undefined && value >= maximum) {
        addError(errors, path, 'exclusiveMaximum', `must be < ${maximum}`, maximum, value);
      }
    }
    if (schema.multipleOf !== undefined && schema.multipleOf > 0) {
      const quotient = value / schema.multipleOf;
      if (Math.abs(quotient - Math.round(quotient)) > Number.EPSILON * Math.max(1, Math.abs(quotient))) {
        addError(errors, path, 'multipleOf', `must be a multiple of ${schema.multipleOf}`, schema.multipleOf, value);
      }
    }
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      addError(errors, path, 'minItems', `must contain at least ${schema.minItems} items`, schema.minItems, value.length);
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      addError(errors, path, 'maxItems', `must contain at most ${schema.maxItems} items`, schema.maxItems, value.length);
    }
    if (schema.uniqueItems) {
      for (let i = 0; i < value.length; i += 1) {
        if (value.slice(0, i).some((item) => sameJson(item, value[i]))) {
          addError(errors, path, 'uniqueItems', 'items must be unique');
          break;
        }
      }
    }
    if (schema.items !== undefined) {
      if (Array.isArray(schema.items)) {
        for (let index = 0; index < value.length; index += 1) {
          const itemSchema = schema.items[index] ?? schema.additionalItems;
          if (itemSchema !== undefined && itemSchema !== true) {
            validateNode(value[index], itemSchema, `${path}[${index}]`, errors, options);
          }
        }
      } else {
        for (let index = 0; index < value.length; index += 1) {
          validateNode(value[index], schema.items, `${path}[${index}]`, errors, options);
        }
      }
    }
    if (Array.isArray(schema.prefixItems)) {
      for (let index = 0; index < Math.min(value.length, schema.prefixItems.length); index += 1) {
        validateNode(value[index], schema.prefixItems[index], `${path}[${index}]`, errors, options);
      }
    }
  }

  if (isPlainObject(value)) {
    if (Array.isArray(schema.required)) {
      for (const key of schema.required) {
        if (typeof key !== 'string' || !Object.prototype.hasOwnProperty.call(value, key)) {
          addError(errors, path, 'required', `must contain required property ${JSON.stringify(key)}`, key);
        }
      }
    }

    const properties = isPlainObject(schema.properties) ? schema.properties : {};
    for (const key of Object.keys(properties)) {
      if (Object.prototype.hasOwnProperty.call(value, key)) {
        validateNode(value[key], properties[key], displayPath(path, key), errors, options);
      }
    }

    const patternProperties = isPlainObject(schema.patternProperties)
      ? schema.patternProperties
      : {};
    for (const key of Object.keys(value)) {
      const known = Object.prototype.hasOwnProperty.call(properties, key);
      let patternMatched = false;
      for (const pattern of Object.keys(patternProperties)) {
        try {
          if (new RegExp(pattern).test(key)) {
            patternMatched = true;
            validateNode(value[key], patternProperties[pattern], displayPath(path, key), errors, options);
          }
        } catch {
          addError(errors, path, 'patternProperties', 'schema contains an invalid pattern', pattern);
        }
      }
      if (!known && !patternMatched && schema.additionalProperties === false) {
        addError(errors, displayPath(path, key), 'additionalProperties', 'additional property is not allowed');
      } else if (!known && !patternMatched && schema.additionalProperties && schema.additionalProperties !== true) {
        validateNode(value[key], schema.additionalProperties, displayPath(path, key), errors, options);
      }
    }

    if (schema.minProperties !== undefined && Object.keys(value).length < schema.minProperties) {
      addError(errors, path, 'minProperties', `must contain at least ${schema.minProperties} properties`, schema.minProperties, Object.keys(value).length);
    }
    if (schema.maxProperties !== undefined && Object.keys(value).length > schema.maxProperties) {
      addError(errors, path, 'maxProperties', `must contain at most ${schema.maxProperties} properties`, schema.maxProperties, Object.keys(value).length);
    }
  }

  if (Array.isArray(schema.allOf)) {
    for (const subSchema of schema.allOf) validateNode(value, subSchema, path, errors, options);
  }
  if (Array.isArray(schema.anyOf) && schema.anyOf.length > 0) {
    const branchErrors = schema.anyOf.map((subSchema) => {
      const nested = [];
      validateNode(value, subSchema, path, nested, options);
      return nested;
    });
    if (branchErrors.every((nested) => nested.length > 0)) {
      addError(errors, path, 'anyOf', 'must match at least one schema');
      if (options.includeBranchErrors) {
        errors.push(...branchErrors.flat());
      }
    }
  }
  if (Array.isArray(schema.oneOf) && schema.oneOf.length > 0) {
    const branchErrors = schema.oneOf.map((subSchema) => {
      const nested = [];
      validateNode(value, subSchema, path, nested, options);
      return nested;
    });
    const matches = branchErrors.filter((nested) => nested.length === 0).length;
    if (matches !== 1) {
      addError(errors, path, 'oneOf', `must match exactly one schema (matched ${matches})`);
    }
  }
  if (schema.not !== undefined) {
    const nested = [];
    validateNode(value, schema.not, path, nested, options);
    if (nested.length === 0) addError(errors, path, 'not', 'must not match the nested schema');
  }
}

export function validateJsonSchema(value, schema, options = {}) {
  const errors = [];
  if (!isJsonValue(value)) {
    addError(errors, '$', 'json', 'value must be JSON-safe');
  } else {
    validateNode(value, schema, '$', errors, options);
  }
  return {
    valid: errors.length === 0,
    errors,
  };
}

export function firstValidationMessage(result) {
  if (!result || result.valid || !Array.isArray(result.errors) || result.errors.length === 0) {
    return null;
  }
  const [error] = result.errors;
  return `${error.path}: ${error.message}`;
}

