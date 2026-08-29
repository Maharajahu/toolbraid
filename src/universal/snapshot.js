import {
  UniversalDataError,
  assertPlainObject,
  cloneJson,
  freezeDeep,
  sha256Hex,
  stableStringify,
} from './canonical.js';

export const PAGE_SNAPSHOT_VERSION = 1;

export class PageSnapshotError extends UniversalDataError {
  constructor(code, message, details = {}) {
    super(code, message, details);
    this.name = 'PageSnapshotError';
  }
}

function snapshotError(code, message, details = {}) {
  return new PageSnapshotError(code, message, details);
}

function stringValue(value, fallback = '') {
  if (value === null || value === undefined) return fallback;
  return typeof value === 'string' ? value.trim() : String(value).trim();
}

function nullableString(value) {
  if (value === null || value === undefined) return null;
  const result = stringValue(value);
  return result || null;
}

function integerValue(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback;
  const result = Number(value);
  return Number.isInteger(result) ? result : fallback;
}

function sanitizedJson(value, path = '$') {
  if (value === undefined) return undefined;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw snapshotError('SNAPSHOT_VALUE_INVALID', `Non-finite value at ${path}.`, { path });
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== 'object') throw snapshotError('SNAPSHOT_VALUE_INVALID', `Value at ${path} is not JSON-compatible.`, { path });
  if (Array.isArray(value)) {
    return value.map((entry, index) => {
      const child = sanitizedJson(entry, `${path}[${index}]`);
      return child === undefined ? null : child;
    });
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw snapshotError('SNAPSHOT_VALUE_INVALID', `Value at ${path} must be a plain object.`, { path });
  }
  const result = {};
  for (const key of Object.keys(value).sort()) {
    const child = sanitizedJson(value[key], `${path}.${key}`);
    if (child !== undefined) result[key] = child;
  }
  return result;
}

function sourceObject(value, field) {
  if (value === undefined || value === null) return {};
  return assertPlainObject(value, field);
}

function sourceArray(value, field) {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object' && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) {
    return Object.entries(value).map(([key, entry]) => ({
      ...(entry && typeof entry === 'object' && !Array.isArray(entry) ? entry : { value: entry }),
      ref: entry?.ref ?? entry?.elementRef ?? key,
    }));
  }
  throw snapshotError('SNAPSHOT_COLLECTION_INVALID', `${field} must be an array or object map.`, { field });
}

function deriveRef(value, prefix, index) {
  const candidate = value?.ref ?? value?.elementRef ?? value?.id;
  return stringValue(candidate, `${prefix}-${String(index + 1).padStart(3, '0')}`);
}

function normalizeOptions(value, path) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw snapshotError('SNAPSHOT_CONTROL_INVALID', `${path} must be an array.`, { path });
  return value.map((entry, index) => {
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      const label = stringValue(entry.label ?? entry.text ?? entry.name ?? entry.value);
      const optionValue = stringValue(entry.value ?? label);
      return {
        label,
        value: optionValue,
        ...(entry.disabled !== undefined ? { disabled: Boolean(entry.disabled) } : {}),
      };
    }
    return { label: stringValue(entry), value: stringValue(entry) };
  }).filter((entry, index, array) => entry.value || array.findIndex((other) => other.value === entry.value) === index);
}

function normalizeControl(value, index, { prefix = 'control', formRef = null } = {}) {
  const source = sourceObject(value, `accessibleControls[${index}]`);
  const role = nullableString(source.role ?? source.ariaRole);
  const type = nullableString(source.type ?? source.inputType);
  const name = stringValue(source.name ?? source.label ?? source.ariaLabel ?? source.title ?? source.text ?? source.value);
  const output = {
    ref: deriveRef(source, prefix, index),
    role,
    name,
    type,
    description: nullableString(source.description ?? source.helpText),
    formRef: nullableString(source.formRef ?? source.form ?? formRef),
    disabled: Boolean(source.disabled),
    required: Boolean(source.required ?? source.ariaRequired),
    ...(source.value !== undefined ? { value: sanitizedJson(source.value, `accessibleControls[${index}].value`) } : {}),
    ...(source.checked !== undefined ? { checked: Boolean(source.checked) } : {}),
    ...(source.expanded !== undefined ? { expanded: Boolean(source.expanded) } : {}),
    ...(source.pressed !== undefined ? { pressed: Boolean(source.pressed) } : {}),
    ...(source.options !== undefined ? { options: normalizeOptions(source.options, `accessibleControls[${index}].options`) } : {}),
  };
  if (source.attributes !== undefined) output.attributes = sanitizedJson(source.attributes, `accessibleControls[${index}].attributes`);
  return output;
}

function normalizeHeading(value, index) {
  const source = sourceObject(value, `headings[${index}]`);
  return {
    ref: deriveRef(source, 'heading', index),
    level: Math.max(1, Math.min(6, integerValue(source.level ?? source.rank, 1))),
    text: stringValue(source.text ?? source.name ?? source.label),
  };
}

function normalizeLink(value, index) {
  const source = sourceObject(value, `links[${index}]`);
  const href = stringValue(source.href ?? source.url ?? source.target);
  return {
    ref: deriveRef(source, 'link', index),
    href,
    text: stringValue(source.text ?? source.name ?? source.label ?? source.ariaLabel ?? href),
    ariaLabel: nullableString(source.ariaLabel ?? source.accessibleName),
    target: nullableString(source.target),
    rel: nullableString(source.rel),
    ...(source.download !== undefined ? { download: Boolean(source.download) } : {}),
  };
}

function normalizeForm(value, index) {
  const source = sourceObject(value, `forms[${index}]`);
  const rawFields = source.fields ?? source.controls ?? source.inputs ?? [];
  return {
    ref: deriveRef(source, 'form', index),
    name: stringValue(source.name ?? source.ariaLabel ?? source.title),
    action: stringValue(source.action ?? source.endpoint ?? ''),
    method: stringValue(source.method ?? 'GET').toUpperCase() || 'GET',
    encType: nullableString(source.encType ?? source.enctype),
    fields: sourceArray(rawFields, `forms[${index}].fields`).map((field, fieldIndex) => normalizeControl(field, fieldIndex, {
      prefix: `field-${index + 1}`,
      formRef: deriveRef(source, 'form', index),
    })),
  };
}

function normalizeElementRef(value, index) {
  const source = sourceObject(value, `elementRefs[${index}]`);
  const ref = deriveRef(source, 'element', index);
  const output = {
    ref,
    tagName: stringValue(source.tagName ?? source.tag ?? '').toLowerCase(),
    role: nullableString(source.role ?? source.ariaRole),
    name: stringValue(source.name ?? source.label ?? source.ariaLabel ?? source.text),
    locator: source.locator !== undefined
      ? sanitizedJson(source.locator, `elementRefs[${index}].locator`)
      : nullableString(source.selector ?? source.cssSelector ?? source.xpath),
    parentRef: nullableString(source.parentRef ?? source.parent),
  };
  if (source.attributes !== undefined) output.attributes = sanitizedJson(source.attributes, `elementRefs[${index}].attributes`);
  if (source.text !== undefined) output.text = stringValue(source.text);
  if (source.value !== undefined) output.value = sanitizedJson(source.value, `elementRefs[${index}].value`);
  return output;
}

function normalizeMetadata(value) {
  const source = sourceObject(value, 'metadata');
  const output = sanitizedJson(source, 'metadata');
  if (output.url === undefined) output.url = '';
  if (output.title === undefined) output.title = '';
  if (output.origin === undefined) {
    try {
      output.origin = output.url ? new URL(output.url).origin : '';
    } catch {
      output.origin = '';
    }
  }
  return output;
}

function normalizeMainText(input) {
  const value = input.mainText ?? input.main_text ?? input.text ?? '';
  if (Array.isArray(value)) return value.map((entry) => stringValue(entry)).filter(Boolean).join('\n');
  return stringValue(value);
}

function snapshotCore(snapshot) {
  return {
    version: snapshot.version,
    metadata: snapshot.metadata,
    headings: snapshot.headings,
    mainText: snapshot.mainText,
    links: snapshot.links,
    forms: snapshot.forms,
    accessibleControls: snapshot.accessibleControls,
    elementRefs: snapshot.elementRefs,
  };
}

export function fingerprintPageSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') {
    throw snapshotError('SNAPSHOT_REQUIRED', 'A page snapshot object is required.');
  }
  const core = snapshotCore({
    version: snapshot.version ?? PAGE_SNAPSHOT_VERSION,
    metadata: normalizeMetadata(snapshot.metadata ?? snapshot.documentMetadata ?? snapshot.document),
    headings: sourceArray(snapshot.headings, 'headings').map(normalizeHeading),
    mainText: normalizeMainText(snapshot),
    links: sourceArray(snapshot.links, 'links').map(normalizeLink),
    forms: sourceArray(snapshot.forms, 'forms').map(normalizeForm),
    accessibleControls: sourceArray(snapshot.accessibleControls ?? snapshot.controls, 'accessibleControls').map(normalizeControl),
    elementRefs: sourceArray(snapshot.elementRefs ?? snapshot.elements, 'elementRefs').map(normalizeElementRef),
  });
  return sha256Hex(stableStringify(core));
}

export function createPageSnapshot(input = {}) {
  const source = sourceObject(input, 'pageSnapshot');
  const headings = sourceArray(source.headings, 'headings').map(normalizeHeading);
  const links = sourceArray(source.links, 'links').map(normalizeLink);
  const forms = sourceArray(source.forms, 'forms').map(normalizeForm);
  const accessibleControls = sourceArray(source.accessibleControls ?? source.controls, 'accessibleControls')
    .map(normalizeControl);
  const elementRefs = sourceArray(source.elementRefs ?? source.elements, 'elementRefs').map(normalizeElementRef);

  const refs = new Set();
  for (const element of elementRefs) {
    if (refs.has(element.ref)) throw snapshotError('SNAPSHOT_REF_DUPLICATE', `Duplicate element ref: ${element.ref}`, { ref: element.ref });
    refs.add(element.ref);
  }

  const snapshot = {
    version: integerValue(source.version, PAGE_SNAPSHOT_VERSION),
    metadata: normalizeMetadata(source.metadata ?? source.documentMetadata ?? source.document),
    headings,
    mainText: normalizeMainText(source),
    links,
    forms,
    accessibleControls,
    elementRefs,
  };
  if (!Number.isInteger(snapshot.version) || snapshot.version < 1) {
    throw snapshotError('SNAPSHOT_VERSION_INVALID', 'Page snapshot version must be a positive integer.');
  }

  const pageFingerprint = fingerprintPageSnapshot(snapshot);
  const suppliedFingerprint = source.pageFingerprint ?? source.fingerprint;
  if (suppliedFingerprint !== undefined && suppliedFingerprint !== pageFingerprint) {
    throw snapshotError(
      'SNAPSHOT_FINGERPRINT_MISMATCH',
      'The supplied page fingerprint does not match the serialized snapshot contents.',
      { suppliedFingerprint, pageFingerprint },
    );
  }
  snapshot.pageFingerprint = pageFingerprint;

  // Non-enumerable aliases keep the canonical wire model compact while making
  // common naming variants convenient for callers integrating an extractor.
  Object.defineProperties(snapshot, {
    documentMetadata: { value: snapshot.metadata, enumerable: false },
    text: { value: snapshot.mainText, enumerable: false },
    controls: { value: snapshot.accessibleControls, enumerable: false },
    elements: { value: snapshot.elementRefs, enumerable: false },
    fingerprint: { value: snapshot.pageFingerprint, enumerable: false },
  });
  return freezeDeep(snapshot);
}

export const normalizePageSnapshot = createPageSnapshot;

export function parsePageSnapshot(serialized) {
  if (typeof serialized !== 'string') throw snapshotError('SNAPSHOT_SERIALIZED_INVALID', 'Serialized page snapshot must be a string.');
  let parsed;
  try {
    parsed = JSON.parse(serialized);
  } catch (cause) {
    throw snapshotError('SNAPSHOT_SERIALIZED_INVALID', 'Serialized page snapshot is not valid JSON.', { cause: String(cause) });
  }
  return createPageSnapshot(parsed);
}

export function serializePageSnapshot(snapshot) {
  return JSON.stringify(createPageSnapshot(snapshot));
}

export function isPageSnapshot(value) {
  return Boolean(value
    && typeof value === 'object'
    && Number.isInteger(value.version)
    && typeof value.pageFingerprint === 'string'
    && Array.isArray(value.headings)
    && Array.isArray(value.links)
    && Array.isArray(value.forms)
    && Array.isArray(value.accessibleControls)
    && Array.isArray(value.elementRefs));
}

export function snapshotElementRefs(snapshot) {
  const normalized = isPageSnapshot(snapshot) ? snapshot : createPageSnapshot(snapshot);
  const entries = [];
  const seen = new Set();
  const add = (entry, kind) => {
    if (!entry?.ref || seen.has(entry.ref)) return;
    seen.add(entry.ref);
    entries.push({ ref: entry.ref, kind, value: entry });
  };
  normalized.elementRefs.forEach((entry) => add(entry, 'element'));
  normalized.headings.forEach((entry) => add(entry, 'heading'));
  normalized.links.forEach((entry) => add(entry, 'link'));
  normalized.forms.forEach((entry) => add(entry, 'form'));
  normalized.forms.forEach((form) => form.fields.forEach((entry) => add(entry, 'form-field')));
  normalized.accessibleControls.forEach((entry) => add(entry, 'control'));
  return entries;
}

export function findSnapshotElement(snapshot, ref) {
  if (typeof ref !== 'string' || !ref) return null;
  return snapshotElementRefs(snapshot).find((entry) => entry.ref === ref) ?? null;
}

export function elementFingerprint(element) {
  if (!element || typeof element !== 'object') throw snapshotError('SNAPSHOT_ELEMENT_REQUIRED', 'An element reference is required.');
  return sha256Hex(stableStringify(cloneJson(element)));
}

export { snapshotCore };
