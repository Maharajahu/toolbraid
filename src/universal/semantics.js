import { UniversalDataError } from './canonical.js';

export const ACTION_CLASSES = Object.freeze({
  READ: 'read',
  STAGE: 'stage',
  MUTATE: 'mutate',
});

export const ACTION_RISK = Object.freeze({
  read: 'read-only',
  stage: 'reversible',
  mutate: 'transactional',
});

export class SemanticClassificationError extends UniversalDataError {
  constructor(code, message, details = {}) {
    super(code, message, details);
    this.name = 'SemanticClassificationError';
  }
}

const MUTATE_PATTERNS = Object.freeze([
  /\b(?:submit|send|publish|post|delete|remove|destroy|buy|purchase|pay|checkout|book|order|confirm|update|edit|create|modify|change|apply|deploy|rollout|enable|disable|invite|cancel|transfer|withdraw|sign|accept|reject|approve|follow|like|repost|comment|reply|message)\b/i,
  /\b(?:add|move)\b[\s\-_]*(?:to|from)?\b(?:cart|list|folder|project|workspace)\b/i,
]);

const FINAL_MUTATION_PATTERNS = Object.freeze([
  /\b(?:submit|send|publish|post|delete|remove|destroy|buy|purchase|pay|checkout|book|confirm|apply|deploy|rollout|enable|disable|invite|cancel|transfer|withdraw|sign|accept|reject|approve|follow|like|repost|comment|reply|message)\b/i,
  /\b(?:add|move)\b[\s\-_]*(?:to|from)?\b(?:cart|list|folder|project|workspace)\b/i,
]);

const STAGE_PATTERNS = Object.freeze([
  /\b(?:stage|prepare|preview|draft|review|validate|quote|simulate|hold|reserve|pause|save\s+draft)\b/i,
]);

const READ_PATTERNS = Object.freeze([
  /\b(?:read|get|list|search|find|inspect|view|open|browse|load|fetch|check|query|filter|sort|calculate|measure|lookup|look\s+up|discover|probe|describe)\b/i,
]);

function normalizeText(value) {
  return String(value ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_./:-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function explicitClass(value) {
  if (value === undefined || value === null) return null;
  const normalized = normalizeText(value).replace(/\s+/g, '-');
  if (['read', 'read-only', 'readonly', 'inspect'].includes(normalized)) return ACTION_CLASSES.READ;
  if (['stage', 'staged', 'prepare', 'prepared', 'draft', 'preview', 'reversible'].includes(normalized)) return ACTION_CLASSES.STAGE;
  if (['mutate', 'mutation', 'write', 'transaction', 'transactional', 'high-impact', 'high-impact-action'].includes(normalized)) return ACTION_CLASSES.MUTATE;
  throw new SemanticClassificationError('ACTION_CLASS_INVALID', `Unsupported action classification: ${value}`, { value });
}

function textForAction(action = {}) {
  const fields = [
    action.name,
    action.title,
    action.label,
    action.ariaLabel,
    action.accessibleName,
    action.description,
    action.text,
    action.role,
    action.type,
    action.action,
    action.href,
    action.endpoint,
  ];
  if (Array.isArray(action.options)) fields.push(...action.options.flatMap((option) => [option?.label, option?.value]));
  return normalizeText(fields.filter((value) => value !== undefined && value !== null).join(' '));
}

function firstMatch(text, patterns) {
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match) return { cue: match[0].toLowerCase(), index: match.index };
  }
  return null;
}

function result(classification, evidence, source, text) {
  const readOnly = classification === ACTION_CLASSES.READ;
  // Staging/previewing prepares a candidate without changing external state;
  // only the final mutate class crosses the human approval boundary.
  const requiresApproval = classification === ACTION_CLASSES.MUTATE;
  return Object.freeze({
    classification,
    kind: classification,
    risk: ACTION_RISK[classification],
    readOnly,
    requiresApproval,
    source,
    normalizedText: text,
    evidence: Object.freeze(evidence.map((entry) => Object.freeze(entry))),
  });
}

/**
 * Classify an action using only stable element/form metadata.  Mutation cues
 * always win over a provider's explicit read claim; unknown actions fail
 * closed as mutate so an unfamiliar control cannot be executed as a read.
 */
export function classifyAction(action = {}, { source = 'action' } = {}) {
  if (!action || typeof action !== 'object' || Array.isArray(action)) {
    throw new SemanticClassificationError('ACTION_REQUIRED', 'An action-like object is required.');
  }
  const text = textForAction(action);
  const evidence = [];
  const explicit = explicitClass(action.classification ?? action.kind ?? action.actionClass ?? action.riskClass);
  const mutation = firstMatch(text, MUTATE_PATTERNS);
  const stage = firstMatch(text, STAGE_PATTERNS);
  const finalMutation = firstMatch(text, FINAL_MUTATION_PATTERNS);
  const read = firstMatch(text, READ_PATTERNS);

  if (mutation && (!stage || finalMutation)) {
    evidence.push({ source: 'semantic-text', code: 'MUTATION_CUE', cue: mutation.cue, index: mutation.index });
    if (explicit && explicit !== ACTION_CLASSES.MUTATE) {
      evidence.push({ source: 'explicit-classification', code: 'EXPLICIT_CLASS_OVERRIDDEN', claimed: explicit });
    }
    return result(ACTION_CLASSES.MUTATE, evidence, source, text);
  }

  if (stage) {
    evidence.push({ source: 'semantic-text', code: 'STAGE_CUE', cue: stage.cue, index: stage.index });
    if (explicit && explicit !== ACTION_CLASSES.STAGE) {
      evidence.push({ source: 'explicit-classification', code: 'EXPLICIT_CLASS_OVERRIDDEN', claimed: explicit });
    }
    return result(ACTION_CLASSES.STAGE, evidence, source, text);
  }

  if (explicit) {
    evidence.push({ source: 'explicit-classification', code: 'EXPLICIT_CLASSIFICATION', claimed: explicit });
    return result(explicit, evidence, source, text);
  }

  const method = normalizeText(action.method);
  if (method && ['post', 'put', 'patch', 'delete'].includes(method)) {
    evidence.push({ source: 'form-method', code: 'STATE_CHANGING_METHOD', cue: method });
    return result(ACTION_CLASSES.MUTATE, evidence, source, text);
  }

  if (read) {
    evidence.push({ source: 'semantic-text', code: 'READ_CUE', cue: read.cue, index: read.index });
    return result(ACTION_CLASSES.READ, evidence, source, text);
  }

  evidence.push({ source: 'default-policy', code: 'UNKNOWN_ACTION_FAILS_CLOSED', cue: null });
  return result(ACTION_CLASSES.MUTATE, evidence, source, text);
}

export function classifyControl(control, options = {}) {
  return classifyAction(control, { ...options, source: options.source ?? 'control' });
}

export function classifyForm(form, options = {}) {
  return classifyAction(form, { ...options, source: options.source ?? 'form' });
}

export function classifyLink(link, options = {}) {
  // Links are navigational reads unless their label explicitly carries an
  // effectful command (e.g. “Delete account”).
  return classifyAction({ ...link, classification: link?.classification ?? ACTION_CLASSES.READ }, {
    ...options,
    source: options.source ?? 'link',
  });
}

export function classifyPageActions(snapshot, { includeFields = false } = {}) {
  if (!snapshot || typeof snapshot !== 'object') {
    throw new SemanticClassificationError('SNAPSHOT_REQUIRED', 'A page snapshot object is required.');
  }
  const actions = [];
  for (const form of snapshot.forms ?? []) {
    actions.push({ ref: form.ref ?? null, type: 'form', classification: classifyForm(form) });
    if (includeFields) {
      for (const field of form.fields ?? []) {
        actions.push({ ref: field.ref ?? null, type: 'form-field', classification: classifyControl(field) });
      }
    }
  }
  for (const link of snapshot.links ?? []) {
    actions.push({ ref: link.ref ?? null, type: 'link', classification: classifyLink(link) });
  }
  const formFieldRefs = new Set((snapshot.forms ?? []).flatMap((form) => (form.fields ?? []).map((field) => field.ref)));
  for (const control of snapshot.accessibleControls ?? snapshot.controls ?? []) {
    if (formFieldRefs.has(control.ref)) continue;
    actions.push({ ref: control.ref ?? null, type: 'control', classification: classifyControl(control) });
  }
  return Object.freeze(actions.map((entry) => Object.freeze(entry)));
}

export const classifyPageAction = classifyAction;
export const classifyElementAction = classifyControl;
