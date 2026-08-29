import {
  UniversalDataError,
  cloneJson,
  freezeDeep,
  sha256Hex,
  stableStringify,
} from './canonical.js';
import {
  createPageSnapshot,
  elementFingerprint,
  findSnapshotElement,
  fingerprintPageSnapshot,
  isPageSnapshot,
} from './snapshot.js';
import {
  ACTION_CLASSES,
} from './semantics.js';
import {
  descriptorFingerprint,
  validateToolDescriptor,
} from './tools.js';
import { validatePostconditionContract } from './postconditions.js';

export const PREPARED_ACTION_VERSION = 1;

export class ActionPreparationError extends UniversalDataError {
  constructor(code, message, details = {}) {
    super(code, message, details);
    this.name = 'ActionPreparationError';
  }
}

function actionError(code, message, details = {}) {
  return new ActionPreparationError(code, message, details);
}

function plainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null));
}

function snapshotForAction(value) {
  if (!value || typeof value !== 'object') throw actionError('SNAPSHOT_REQUIRED', 'A page snapshot is required.');
  // A valid PageSnapshot is already normalized.  The second branch supports
  // lightweight test/bridge records that carry an opaque fingerprint and are
  // intentionally not re-hashed here.
  if (isPageSnapshot(value) || typeof value.pageFingerprint === 'string') return value;
  return createPageSnapshot(value);
}

function snapshotFingerprint(snapshot) {
  if (typeof snapshot.pageFingerprint === 'string' && snapshot.pageFingerprint.trim()) return snapshot.pageFingerprint;
  return fingerprintPageSnapshot(snapshot);
}

function schemaTypeMatches(value, type) {
  if (type === 'string') return typeof value === 'string';
  if (type === 'number' || type === 'integer') return typeof value === 'number' && Number.isFinite(value)
    && (type !== 'integer' || Number.isInteger(value));
  if (type === 'boolean') return typeof value === 'boolean';
  if (type === 'array') return Array.isArray(value);
  if (type === 'object') return plainObject(value);
  if (type === 'null') return value === null;
  return false;
}

function validateSchemaValue(value, schema, path) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    throw actionError('ACTION_SCHEMA_INVALID', `Schema at ${path} is invalid.`, { path });
  }
  if (schema.type && !schemaTypeMatches(value, schema.type)) {
    throw actionError('ACTION_ARGUMENTS_INVALID', `Argument at ${path} must have type ${schema.type}.`, {
      path,
      expectedType: schema.type,
      receivedType: Array.isArray(value) ? 'array' : typeof value,
    });
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((candidate) => stableStringify(candidate) === stableStringify(value))) {
    throw actionError('ACTION_ARGUMENTS_INVALID', `Argument at ${path} is not one of the permitted values.`, {
      path,
      allowed: schema.enum,
    });
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      throw actionError('ACTION_ARGUMENTS_INVALID', `Argument at ${path} is shorter than minLength.`, { path });
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      throw actionError('ACTION_ARGUMENTS_INVALID', `Argument at ${path} is longer than maxLength.`, { path });
    }
    if (schema.pattern !== undefined && !(new RegExp(schema.pattern)).test(value)) {
      throw actionError('ACTION_ARGUMENTS_INVALID', `Argument at ${path} does not match its pattern.`, { path });
    }
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) throw actionError('ACTION_ARGUMENTS_INVALID', `Argument at ${path} is below minimum.`, { path });
    if (schema.maximum !== undefined && value > schema.maximum) throw actionError('ACTION_ARGUMENTS_INVALID', `Argument at ${path} is above maximum.`, { path });
  }
  if (Array.isArray(value) && schema.items) {
    value.forEach((entry, index) => validateSchemaValue(entry, schema.items, `${path}[${index}]`));
  }
  if (plainObject(value) && schema.properties) {
    const required = Array.isArray(schema.required) ? schema.required : [];
    for (const key of required) {
      if (!Object.hasOwn(value, key)) throw actionError('ACTION_ARGUMENTS_INVALID', `Missing required argument ${path}.${key}.`, { path: `${path}.${key}` });
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!Object.hasOwn(schema.properties, key)) {
          throw actionError('ACTION_ARGUMENTS_INVALID', `Unknown argument ${path}.${key}.`, { path: `${path}.${key}` });
        }
      }
    }
    for (const [key, property] of Object.entries(schema.properties)) {
      if (Object.hasOwn(value, key)) validateSchemaValue(value[key], property, `${path}.${key}`);
    }
  }
}

export function normalizeActionArguments(input, schema) {
  const value = input === undefined ? {} : input;
  if (!plainObject(value)) throw actionError('ACTION_ARGUMENTS_INVALID', 'Action arguments must be a plain object.');
  validateSchemaValue(value, schema, '$');
  return cloneJson(value, '$.arguments');
}

function findTargetInOpaqueSnapshot(snapshot, ref, preferredType = null) {
  if (!ref) return null;
  const preferredCollections = {
    form: [['forms', 'form']],
    link: [['links', 'link']],
    control: [['accessibleControls', 'control']],
    heading: [['headings', 'heading']],
    element: [['elementRefs', 'element']],
  }[preferredType] ?? [];
  for (const [collection, kind] of preferredCollections) {
    const value = Array.isArray(snapshot[collection]) ? snapshot[collection].find((entry) => entry?.ref === ref) : null;
    if (value) return { ref, kind, value };
    if (collection === 'forms') {
      for (const form of snapshot.forms ?? []) {
        const field = (form.fields ?? []).find((entry) => entry?.ref === ref);
        if (field) return { ref, kind: 'form-field', value: field };
      }
    }
  }
  if (Array.isArray(snapshot.elementRefs)) {
    const value = snapshot.elementRefs.find((entry) => entry?.ref === ref);
    if (value) return { ref, kind: 'element', value };
  }
  for (const [collection, kind] of [
    ['headings', 'heading'],
    ['links', 'link'],
    ['forms', 'form'],
    ['accessibleControls', 'control'],
  ]) {
    const value = Array.isArray(snapshot[collection]) ? snapshot[collection].find((entry) => entry?.ref === ref) : null;
    if (value) return { ref, kind, value };
    if (collection === 'forms') {
      for (const form of snapshot.forms ?? []) {
        const field = (form.fields ?? []).find((entry) => entry?.ref === ref);
        if (field) return { ref, kind: 'form-field', value: field };
      }
    }
  }
  return null;
}

function findTarget(snapshot, ref, preferredType = null) {
  if (isPageSnapshot(snapshot)) {
    const preferred = findTargetInOpaqueSnapshot(snapshot, ref, preferredType);
    return preferred ?? findSnapshotElement(snapshot, ref);
  }
  return findTargetInOpaqueSnapshot(snapshot, ref, preferredType);
}

function targetFromDescriptor(tool) {
  const target = plainObject(tool.target) ? tool.target : {};
  const ref = target.elementRef ?? target.ref ?? tool.elementRef ?? null;
  const binding = plainObject(target.binding) ? cloneJson(target.binding, '$.target.binding') : null;
  return {
    ref: typeof ref === 'string' && ref ? ref : null,
    elementRef: typeof ref === 'string' && ref ? ref : null,
    type: target.type ?? tool.sourceType ?? null,
    targetFingerprint: target.targetFingerprint ?? tool.provenance?.targetFingerprint ?? null,
    ...(binding ? { binding } : {}),
  };
}

function assertDescriptorMatchesSnapshot(tool, snapshot, currentFingerprint) {
  const expectedFingerprint = tool.provenance?.pageFingerprint ?? tool.pageFingerprint;
  if (typeof expectedFingerprint !== 'string' || !expectedFingerprint) {
    throw actionError('TOOL_PROVENANCE_MISSING', 'Action descriptor is missing its source page fingerprint.');
  }
  if (expectedFingerprint !== currentFingerprint) {
    throw actionError('PAGE_FINGERPRINT_DRIFT', 'The page changed after this tool descriptor was generated.', {
      expectedFingerprint,
      currentFingerprint,
    });
  }
  const target = targetFromDescriptor(tool);
  if (!target.ref) return target;
  const currentTarget = findTarget(snapshot, target.ref, target.type);
  if (!currentTarget) {
    throw actionError('ACTION_TARGET_NOT_FOUND', `The exact target ${target.ref} is no longer present.`, { ref: target.ref });
  }
  if (target.targetFingerprint) {
    const currentTargetFingerprint = elementFingerprint(currentTarget.value);
    if (currentTargetFingerprint !== target.targetFingerprint) {
      throw actionError('ACTION_TARGET_DRIFT', `The exact target ${target.ref} changed after preparation.`, {
        ref: target.ref,
        expectedTargetFingerprint: target.targetFingerprint,
        currentTargetFingerprint,
      });
    }
  }
  return { ...target, targetFingerprint: target.targetFingerprint ?? elementFingerprint(currentTarget.value) };
}

function actionPayload(action) {
  return {
    version: action.version,
    pageFingerprint: action.pageFingerprint,
    descriptorFingerprint: action.descriptorFingerprint,
    tool: action.tool,
    target: action.target,
    arguments: action.arguments,
    effect: action.effect,
    ...(action.postcondition === undefined ? {} : { postcondition: action.postcondition }),
  };
}

function actionId(payload) {
  return sha256Hex(stableStringify(payload));
}

function prepareOptions(first, second, third, fourth) {
  if (first && typeof first === 'object' && (Object.hasOwn(first, 'snapshot') || Object.hasOwn(first, 'pageSnapshot') || Object.hasOwn(first, 'descriptor') || Object.hasOwn(first, 'tool'))) {
    return {
      snapshot: first.snapshot ?? first.pageSnapshot,
      descriptor: first.descriptor ?? first.tool,
      input: first.arguments ?? first.args ?? first.input ?? first.normalizedArguments,
      options: first,
    };
  }
  const firstLooksSnapshot = first && typeof first === 'object'
    && (Object.hasOwn(first, 'pageFingerprint') || Object.hasOwn(first, 'metadata') || Object.hasOwn(first, 'headings'));
  return firstLooksSnapshot
    ? { snapshot: first, descriptor: second, input: third, options: fourth ?? {} }
    : { descriptor: first, snapshot: second, input: third, options: fourth ?? {} };
}

/**
 * Bind a generated descriptor to one exact page fingerprint, target, argument
 * object, and effect.  The result is data-only and can safely cross the
 * extension/bridge boundary; it does not execute anything.
 */
export function prepareAction(first, second, third, fourth) {
  const { snapshot: rawSnapshot, descriptor, input, options } = prepareOptions(first, second, third, fourth);
  if (!rawSnapshot) throw actionError('SNAPSHOT_REQUIRED', 'A page snapshot is required.');
  if (!descriptor) throw actionError('TOOL_DESCRIPTOR_REQUIRED', 'A generated tool descriptor is required.');
  validateToolDescriptor(descriptor);
  const snapshot = snapshotForAction(rawSnapshot);
  const pageFingerprint = snapshotFingerprint(snapshot);
  const target = assertDescriptorMatchesSnapshot(descriptor, snapshot, pageFingerprint);
  const normalizedArguments = normalizeActionArguments(input, descriptor.inputSchema);
  const effect = cloneJson(descriptor.effect, '$.effect');
  const tool = {
    name: descriptor.name,
    origin: descriptor.provenance.origin ?? null,
  };
  const descriptorHash = descriptorFingerprint(descriptor);
  const postcondition = descriptor.postcondition === undefined
    ? undefined
    : validatePostconditionContract(descriptor.postcondition);
  const payload = {
    version: PREPARED_ACTION_VERSION,
    pageFingerprint,
    descriptorFingerprint: descriptorHash,
    tool,
    target,
    arguments: normalizedArguments,
    effect,
    ...(postcondition === undefined ? {} : { postcondition }),
  };
  const prepared = {
    version: PREPARED_ACTION_VERSION,
    status: 'prepared',
    actionId: actionId(payload),
    pageFingerprint,
    descriptorFingerprint: descriptorHash,
    tool,
    toolName: descriptor.name,
    target,
    targetRef: target.ref,
    arguments: normalizedArguments,
    normalizedArguments,
    classification: descriptor.classification,
    requiresApproval: descriptor.requiresApproval === true,
    effect,
    ...(postcondition === undefined ? {} : { postcondition }),
    effectSummary: effect.summary,
    provenance: cloneJson(descriptor.provenance, '$.provenance'),
  };
  // `now` is accepted for callers that want to attach an external receipt,
  // but is intentionally excluded from the binding so the same semantic
  // action remains deterministically identifiable.
  if (options?.includeDescriptor === true) prepared.descriptor = cloneJson(descriptor, '$.descriptor');
  return freezeDeep(prepared);
}

/**
 * Revalidate a prepared action immediately before execution.  Any page,
 * target, or binding drift fails closed and returns no executable handle.
 */
export function assertPreparedActionCurrent(prepared, rawSnapshot) {
  if (!prepared || typeof prepared !== 'object') throw actionError('ACTION_REQUIRED', 'A prepared action is required.');
  if (prepared.status !== 'prepared') throw actionError('ACTION_INVALIDATED', 'The prepared action is no longer executable.', { status: prepared.status });
  if (prepared.postcondition !== undefined) validatePostconditionContract(prepared.postcondition);
  const snapshot = snapshotForAction(rawSnapshot);
  const currentFingerprint = snapshotFingerprint(snapshot);
  if (currentFingerprint !== prepared.pageFingerprint) {
    throw actionError('PAGE_FINGERPRINT_DRIFT', 'The page changed after action preparation.', {
      expectedFingerprint: prepared.pageFingerprint,
      currentFingerprint,
    });
  }
  const currentTarget = prepared.target?.ref
    ? findTarget(snapshot, prepared.target.ref, prepared.target.type)
    : null;
  if (prepared.target?.ref && !currentTarget) {
    throw actionError('ACTION_TARGET_NOT_FOUND', `The exact target ${prepared.target.ref} is no longer present.`, { ref: prepared.target.ref });
  }
  if (currentTarget && prepared.target.targetFingerprint) {
    const currentTargetFingerprint = elementFingerprint(currentTarget.value);
    if (currentTargetFingerprint !== prepared.target.targetFingerprint) {
      throw actionError('ACTION_TARGET_DRIFT', `The exact target ${prepared.target.ref} changed after preparation.`, {
        ref: prepared.target.ref,
        expectedTargetFingerprint: prepared.target.targetFingerprint,
        currentTargetFingerprint,
      });
    }
  }
  const expectedId = actionId(actionPayload(prepared));
  if (expectedId !== prepared.actionId) {
    throw actionError('ACTION_TAMPERED', 'The prepared action binding has been modified.', {
      expectedActionId: expectedId,
      actionId: prepared.actionId,
    });
  }
  return true;
}

export function isPreparedActionCurrent(prepared, snapshot) {
  try {
    assertPreparedActionCurrent(prepared, snapshot);
    return true;
  } catch {
    return false;
  }
}

export const isActionCurrent = isPreparedActionCurrent;

export function invalidatePreparedAction(prepared, reason = 'PAGE_FINGERPRINT_DRIFT') {
  if (!prepared || typeof prepared !== 'object') throw actionError('ACTION_REQUIRED', 'A prepared action is required.');
  const invalidated = {
    ...cloneJson(prepared, '$.preparedAction'),
    status: 'invalidated',
    invalidatedReason: String(reason),
  };
  return freezeDeep(invalidated);
}

export const validatePreparedAction = assertPreparedActionCurrent;
export const revalidatePreparedAction = assertPreparedActionCurrent;
export const preparePageAction = prepareAction;
