import {
  PROVENANCE,
  ApprovalStoreError,
  createApprovalStore,
  stableStringify,
} from './approval-store.js';
import { createMultimodalSettingsStore } from './multimodal-provider.js';

export const UI_MESSAGE_TYPES = Object.freeze({
  UI_GET_STATE: 'UI_GET_STATE',
  UI_PREPARE_ACTION: 'UI_PREPARE_ACTION',
  UI_APPROVE_ACTION: 'UI_APPROVE_ACTION',
  UI_EXECUTE_ACTION: 'UI_EXECUTE_ACTION',
  UI_REANALYZE_MULTIMODAL: 'UI_REANALYZE_MULTIMODAL',
});

const UI_MESSAGE_TYPE_SET = new Set(Object.values(UI_MESSAGE_TYPES));
const MAX_TEXT = 512;
const INITIAL_REFRESH_DELAYS_MS = Object.freeze([100, 250, 500, 900, 1500]);

function errorResult(code, message, details = {}) {
  return { ok: false, error: { code, message, details }, provenance: PROVENANCE };
}

function boundedText(value, fallback = '—', limit = MAX_TEXT) {
  if (value === null || value === undefined) return fallback;
  const result = String(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ').trim();
  return result ? result.slice(0, limit) : fallback;
}

function plainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function safeJson(value, fallback = {}) {
  if (!plainObject(value) && !Array.isArray(value)) return fallback;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return fallback;
  }
}

function safeOrigin(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'Unavailable';
    return url.origin;
  } catch {
    return 'Unavailable';
  }
}

function actionIdFor(action, index) {
  const id = action?.id ?? action?.actionId ?? action?.toolId ?? action?.name;
  return boundedText(id, `action-${index + 1}`, 160);
}

function normalizeTool(tool, index) {
  const provenanceSource = plainObject(tool?.provenance) ? tool.provenance.source : tool?.provenance;
  const verified = provenanceSource === 'toolbraid.verified-adapter';
  const generated = verified
    || tool?.provenance === PROVENANCE
    || tool?.annotations?.provenance === PROVENANCE
    || provenanceSource === 'toolbraid.universal'
    || tool?.source === 'toolbraid.universal';
  return {
    id: boundedText(tool?.id ?? tool?.name, `tool-${index + 1}`, 160),
    name: boundedText(tool?.name, `Tool ${index + 1}`, 128),
    title: boundedText(tool?.title ?? tool?.name, `Tool ${index + 1}`, 160),
    description: boundedText(tool?.description, 'No description supplied.', 640),
    kind: verified ? 'verified' : (generated ? 'generated' : 'native'),
    provenance: verified ? 'toolbraid.verified-adapter' : (generated ? PROVENANCE : 'native'),
  };
}

function normalizeAction(action, index) {
  const effect = plainObject(action?.effect) ? safeJson(action.effect) : {};
  const schema = plainObject(action?.inputSchema)
    ? safeJson(action.inputSchema)
    : { type: 'object', properties: {} };
  const classification = boundedText(action?.classification ?? effect.classification, 'read', 32).toLowerCase();
  const risk = boundedText(action?.risk ?? effect.risk, classification === 'read' ? 'read-only' : 'review', 64);
  return {
    id: actionIdFor(action, index),
    name: boundedText(action?.name ?? action?.title, `Page action ${index + 1}`, 160),
    title: boundedText(action?.title ?? action?.name, `Page action ${index + 1}`, 200),
    description: boundedText(action?.description, 'No action description supplied.', 640),
    classification,
    risk,
    effect,
    inputSchema: schema,
    requiresApproval: action?.requiresApproval === true || classification === 'mutate' || classification === 'mutation',
    provenance: safeJson(action?.provenance, {}),
    source: boundedText(action?.source ?? action?.sourceType, 'page', 64),
  };
}

function normalizeApproval(record, index) {
  if (!plainObject(record) || record.provenance !== PROVENANCE) return null;
  const storedState = boundedText(record.state, 'unknown', 32);
  return {
    id: boundedText(record.id, `approval-${index + 1}`, 220),
    state: storedState === 'executed' ? 'dispatched' : storedState,
    nonce: boundedText(record.nonce, '—', 220),
    fingerprint: boundedText(record.fingerprint, '—', 128),
    createdAt: Number.isFinite(record.createdAt) ? record.createdAt : null,
    expiresAt: Number.isFinite(record.expiresAt) ? record.expiresAt : null,
    scope: safeJson(record.scope, {}),
    provenance: PROVENANCE,
  };
}

function normalizeEvidence(multimodal, capture) {
  const results = Array.isArray(multimodal?.results) ? multimodal.results : [];
  const items = results.slice(0, 48).map((entry, index) => ({
    id: boundedText(entry?.assetId, `evidence-${index + 1}`, 180),
    kind: boundedText(entry?.kind, 'media', 24).toLowerCase(),
    status: boundedText(entry?.status, 'unknown', 32).toLowerCase(),
    summary: boundedText(entry?.summary ?? entry?.text ?? entry?.transcript ?? entry?.reason, 'No textual evidence.', 1200),
    provider: boundedText(entry?.provider?.id, 'deterministic', 128),
    confidence: Number.isFinite(entry?.confidence) ? Number(entry.confidence) : null,
  }));
  const warnings = Array.isArray(capture?.warnings)
    ? capture.warnings.slice(0, 24).map((warning) => boundedText(warning, 'Capture degraded', 160))
    : [];
  return {
    items,
    warnings,
    stats: {
      total: Number.isInteger(multimodal?.stats?.total) ? multimodal.stats.total : items.length,
      completed: Number.isInteger(multimodal?.stats?.completed) ? multimodal.stats.completed : items.filter((entry) => entry.status === 'completed').length,
      blocked: Number.isInteger(multimodal?.stats?.blocked) ? multimodal.stats.blocked : items.filter((entry) => entry.status === 'blocked').length,
      degraded: Number.isInteger(multimodal?.stats?.degraded) ? multimodal.stats.degraded : items.filter((entry) => entry.status === 'degraded').length,
    },
  };
}

function normalizeReceipt(record, index) {
  const receipt = plainObject(record?.receipt) ? record.receipt : {};
  const status = boundedText(record?.status ?? receipt.status, record?.outcome === 'unknown' ? 'outcome-unknown' : 'dispatched', 40);
  const outcome = boundedText(record?.outcome ?? receipt.outcome, status === 'outcome-unknown' ? 'unknown' : 'postcondition-unverified', 64);
  const postcondition = boundedText(record?.postcondition ?? receipt.postcondition, 'unverified', 64);
  return {
    id: boundedText(receipt.receiptId ?? record?.actionId, `receipt-${index + 1}`, 220),
    actionId: boundedText(record?.actionId, 'Unknown action', 220),
    mode: boundedText(record?.mode ?? receipt.mode ?? receipt.classification, 'execution', 40),
    operation: boundedText(receipt.operation ?? receipt.changed?.operation ?? (receipt.changed?.submit ? 'submit' : ''), 'dispatched', 64),
    target: boundedText(receipt.ref ?? receipt.target?.ref, 'Exact bound target', 180),
    events: Array.isArray(receipt.events) ? receipt.events.slice(0, 16).map((event) => boundedText(event, '', 64)).filter(Boolean) : [],
    approvalFingerprint: boundedText(record?.approvalClaim?.fingerprint, '', 128),
    status,
    outcome,
    postcondition,
  };
}

function normalizeAudit(audit) {
  const entries = Array.isArray(audit?.entries) ? audit.entries : [];
  return {
    verified: audit?.verified === true,
    count: Number.isInteger(audit?.count) ? audit.count : entries.length,
    head: boundedText(audit?.head, '—', 128),
    entries: entries.slice(-12).map((entry, index) => {
      const event = boundedText(entry?.event, 'event', 128);
      return {
        sequence: Number.isInteger(entry?.sequence) ? entry.sequence : index + 1,
        event: event === 'action.executed' ? 'action.dispatched' : event,
        timestamp: boundedText(entry?.timestamp, '', 64),
        hash: boundedText(entry?.hash, '—', 128),
      };
    }),
  };
}

function normalizeMultimodalProvider(value) {
  const source = plainObject(value) ? value : {};
  return {
    enabled: source.enabled === true,
    baseUrl: boundedText(source.baseUrl, '', 2048),
    visionModel: boundedText(source.visionModel, '', 256),
    audioModel: boundedText(source.audioModel, '', 256),
    permissionOrigin: boundedText(source.permissionOrigin, '', 2048),
    hasApiKey: source.hasApiKey === true,
  };
}

function normalizeState(source = {}, localApprovals = []) {
  const page = plainObject(source.page) ? source.page : {};
  const tab = plainObject(source.tab) ? source.tab : {};
  const rawTools = [
    ...(Array.isArray(source.tools) ? source.tools : []),
    ...(Array.isArray(source.nativeTools) ? source.nativeTools : []),
    ...(Array.isArray(source.generatedTools) ? source.generatedTools : []),
  ];
  const tools = rawTools.map(normalizeTool);
  const rawActions = Array.isArray(source.actions)
    ? source.actions
    : (Array.isArray(page.actions) ? page.actions : []);
  const actions = rawActions.map(normalizeAction);
  const snapshot = plainObject(source.snapshot) ? source.snapshot : (plainObject(page.snapshot) ? page.snapshot : {});
  const remoteApprovals = (Array.isArray(source.approvals) ? source.approvals : [])
    .map(normalizeApproval)
    .filter(Boolean);
  const approvals = [...localApprovals.map(normalizeApproval).filter(Boolean), ...remoteApprovals]
    .filter((record, index, values) => values.findIndex((candidate) => candidate.id === record.id) === index);
  const connection = source.connection === 'ready' || source.connected === true ? 'ready' : 'error';
  const evidence = normalizeEvidence(source.multimodal, source.capture);
  return {
    connection,
    error: connection === 'error' ? boundedText(source.error?.message ?? source.error, 'Bridge unavailable.', 320) : '',
    tab: {
      id: Number.isInteger(tab.id) ? tab.id : (Number.isInteger(source.tabId) ? source.tabId : null),
      origin: safeOrigin(tab.origin ?? tab.url ?? source.origin ?? source.url),
      url: boundedText(tab.url ?? source.url, '', 1024),
      title: boundedText(tab.title ?? page.title, 'Untitled page', 240),
    },
    mode: boundedText(source.mode ?? source.surface, 'Waiting', 64),
    snapshot: {
      fingerprint: boundedText(snapshot.pageFingerprint ?? snapshot.fingerprint ?? source.pageFingerprint, '—', 128),
      navigation: boundedText(snapshot.navigationGeneration ?? snapshot.navigationId, '—', 80),
    },
    tools,
    actions,
    approvals,
    evidence,
    multimodalProvider: normalizeMultimodalProvider(source.multimodalProvider),
    receipts: (Array.isArray(source.receipts) ? source.receipts : []).slice(-24).map(normalizeReceipt),
    audit: normalizeAudit(source.audit),
    quarantinedCount: Array.isArray(source.quarantined) ? source.quarantined.length : 0,
  };
}

function trustedEvent(event) {
  return event?.isTrusted === true;
}

/**
 * Send only the allowlisted side-panel messages. Unknown message types and a missing
 * runtime are rejected locally; a worker response is accepted only when it
 * explicitly contains `ok: true`.
 */
export function sendUiMessage(type, payload = {}, runtime = globalThis.chrome?.runtime) {
  if (!UI_MESSAGE_TYPE_SET.has(type)) return Promise.resolve(errorResult('UI_MESSAGE_TYPE_INVALID', 'Unsupported side-panel message type.'));
  if (!runtime || typeof runtime.sendMessage !== 'function') {
    return Promise.resolve(errorResult('BRIDGE_UNAVAILABLE', 'The ToolBraid service worker is unavailable.'));
  }
  const message = { type, payload: safeJson(payload) };
  return new Promise((resolve) => {
    let settled = false;
    const finish = (response) => {
      if (settled) return;
      settled = true;
      if (response?.ok === true) resolve(response);
      else resolve(errorResult(
        response?.error?.code ?? 'BRIDGE_REJECTED',
        response?.error?.message ?? 'The ToolBraid service worker rejected the request.',
        response?.error?.details,
      ));
    };
    try {
      let returned;
      if (runtime.sendMessage.length >= 2) {
        returned = runtime.sendMessage(message, finish);
      } else {
        returned = runtime.sendMessage(message);
      }
      if (returned && typeof returned.then === 'function') returned.then(finish, (error) => finish({ ok: false, error }));
    } catch (error) {
      finish({ ok: false, error });
    }
  });
}

export function createUiController({
  runtime = globalThis.chrome?.runtime,
  store = createApprovalStore(),
  multimodalSettings = createMultimodalSettingsStore(),
  now = () => Date.now(),
} = {}) {
  let state = normalizeState({ connection: 'error', error: 'Bridge unavailable.' });
  const prepared = new Map();

  async function localApprovals() {
    try {
      return await store.list();
    } catch {
      return [];
    }
  }

  async function refresh() {
    const response = await sendUiMessage(UI_MESSAGE_TYPES.UI_GET_STATE, {}, runtime);
    const approvals = await localApprovals();
    if (response.ok === true) {
      state = normalizeState({ ...(plainObject(response.state) ? response.state : response), connection: 'ready' }, approvals);
    } else {
      state = normalizeState({ connection: 'error', error: response.error?.message }, approvals);
    }
    return state;
  }

  async function prepareAction(actionId, args = {}) {
    const id = boundedText(actionId, '', 160);
    if (!id) return errorResult('ACTION_ID_INVALID', 'A page action id is required.');
    if (!plainObject(args)) return errorResult('ACTION_ARGUMENTS_INVALID', 'Action arguments must be an object.');
    const response = await sendUiMessage(UI_MESSAGE_TYPES.UI_PREPARE_ACTION, { actionId: id, arguments: safeJson(args) }, runtime);
    if (response.ok !== true) return response;
    if (plainObject(response.preparedAction)) {
      prepared.set(id, safeJson(response.preparedAction));
      return { ...response, preparedAction: prepared.get(id) };
    }
    prepared.delete(id);
    return response;
  }

  async function approveAction(action, event, ttlMs) {
    if (!trustedEvent(event)) return errorResult('TRUSTED_ACTIVATION_REQUIRED', 'Approval changes require a trusted user activation.');
    if (!plainObject(action)) return errorResult('ACTION_REQUIRED', 'A prepared action object is required.');
    try {
      const approval = await store.createApproval({ event, action, ttlMs });
      const response = await sendUiMessage(UI_MESSAGE_TYPES.UI_APPROVE_ACTION, { decision: 'approve', approval }, runtime);
      if (response.ok === true) prepared.delete(action.id ?? action.actionId);
      return { ...response, approval };
    } catch (error) {
      return errorResult(error.code ?? 'APPROVAL_FAILED', error.message ?? 'Approval could not be created.');
    }
  }

  async function denyPreparedAction(action, event) {
    if (!trustedEvent(event)) return errorResult('TRUSTED_ACTIVATION_REQUIRED', 'Approval changes require a trusted user activation.');
    if (!plainObject(action)) return errorResult('ACTION_REQUIRED', 'A prepared action object is required.');
    prepared.delete(action.id ?? action.actionId);
    return sendUiMessage(UI_MESSAGE_TYPES.UI_APPROVE_ACTION, { decision: 'deny', action: safeJson(action) }, runtime);
  }

  async function denyApproval(id, event) {
    if (!trustedEvent(event)) return errorResult('TRUSTED_ACTIVATION_REQUIRED', 'Approval changes require a trusted user activation.');
    try {
      const local = await store.get(id);
      if (local) await store.deny(id, event);
      return sendUiMessage(UI_MESSAGE_TYPES.UI_APPROVE_ACTION, { decision: 'deny', approvalId: id, approval: local }, runtime);
    } catch (error) {
      return errorResult(error.code ?? 'APPROVAL_DENY_FAILED', error.message ?? 'Approval could not be denied.');
    }
  }

  async function executeApproval(id, event) {
    if (!trustedEvent(event)) return errorResult('TRUSTED_ACTIVATION_REQUIRED', 'Execution changes require a trusted user activation.');
    try {
      const approval = await store.prepareExecution(id, event);
      const response = await sendUiMessage(UI_MESSAGE_TYPES.UI_EXECUTE_ACTION, { approval }, runtime);
      if (response.ok === true) await store.markExecuted(id, event);
      return { ...response, approval };
    } catch (error) {
      return errorResult(error.code ?? 'EXECUTION_BLOCKED', error.message ?? 'Execution was blocked.');
    }
  }

  async function configureMultimodal(input, event) {
    if (!trustedEvent(event)) return errorResult('TRUSTED_ACTIVATION_REQUIRED', 'Analysis provider changes require a trusted user activation.');
    try {
      const provider = await multimodalSettings.save(input);
      const response = await sendUiMessage(UI_MESSAGE_TYPES.UI_REANALYZE_MULTIMODAL, {}, runtime);
      if (response.ok !== true) return { ...response, provider };
      await refresh();
      return { ok: true, provider, result: response.result, provenance: PROVENANCE };
    } catch (error) {
      return errorResult(error.code ?? 'MULTIMODAL_CONFIG_FAILED', error.message ?? 'The analysis provider could not be configured.', error.details);
    }
  }

  async function disableMultimodal(event) {
    if (!trustedEvent(event)) return errorResult('TRUSTED_ACTIVATION_REQUIRED', 'Analysis provider changes require a trusted user activation.');
    try {
      const provider = await multimodalSettings.disable();
      const response = await sendUiMessage(UI_MESSAGE_TYPES.UI_REANALYZE_MULTIMODAL, {}, runtime);
      if (response.ok !== true) return { ...response, provider };
      await refresh();
      return { ok: true, provider, result: response.result, provenance: PROVENANCE };
    } catch (error) {
      return errorResult(error.code ?? 'MULTIMODAL_CONFIG_FAILED', error.message ?? 'The analysis provider could not be disabled.', error.details);
    }
  }

  function getPreparedActions() {
    return [...prepared.values()];
  }

  function getState() {
    return state;
  }

  return Object.freeze({
    refresh,
    prepareAction,
    approveAction,
    denyPreparedAction,
    denyApproval,
    executeApproval,
    configureMultimodal,
    disableMultimodal,
    getPreparedActions,
    getState,
    now,
    store,
    multimodalSettings,
  });
}

function textNode(value) {
  return document.createTextNode(boundedText(value));
}

function appendText(parent, value) {
  parent.append(textNode(value));
  return parent;
}

function makeElement(tag, className = '', value = null) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (value !== null) element.textContent = boundedText(value);
  return element;
}

function badge(value, className = '') {
  return makeElement('span', `kind-badge ${className}`, value);
}

function detailRow(label, value, code = false) {
  const row = makeElement('div', 'detail-row');
  row.append(makeElement('span', 'detail-key', label));
  const valueElement = makeElement('span', 'detail-value');
  if (code) valueElement.append(makeElement('code', '', value));
  else appendText(valueElement, value);
  row.append(valueElement);
  return row;
}

function displayJson(value) {
  try {
    return stableStringify(value);
  } catch {
    return '[unavailable]';
  }
}

function readArguments(form, schema) {
  const result = {};
  const properties = plainObject(schema?.properties) ? schema.properties : {};
  for (const key of Object.keys(properties)) {
    const input = form.elements.namedItem(key);
    if (!input) continue;
    if (input.type === 'checkbox') result[key] = input.checked;
    else if (input.type === 'number') result[key] = input.value === '' ? undefined : Number(input.value);
    else result[key] = input.value;
  }
  for (const key of Object.keys(result)) if (result[key] === undefined) delete result[key];
  return result;
}

function addInputField(form, name, schema = {}) {
  const label = makeElement('label', 'field-label');
  appendText(label, boundedText(schema.title ?? schema.description ?? name, name, 180));
  let input;
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    input = document.createElement('select');
    input.name = name;
    for (const optionValue of schema.enum.slice(0, 50)) {
      const option = document.createElement('option');
      option.value = boundedText(optionValue, '', 256);
      option.textContent = boundedText(optionValue, '—', 256);
      input.append(option);
    }
  } else {
    input = document.createElement('input');
    input.name = name;
    const type = schema.type === 'boolean' ? 'checkbox' : (schema.type === 'number' || schema.type === 'integer' ? 'number' : 'text');
    input.type = type;
    if (type === 'number') {
      if (Number.isFinite(schema.minimum)) input.min = String(schema.minimum);
      if (Number.isFinite(schema.maximum)) input.max = String(schema.maximum);
      input.step = schema.type === 'integer' ? '1' : 'any';
    }
  }
  input.setAttribute('aria-label', boundedText(name, 'Action argument', 160));
  label.append(input);
  form.querySelector('.field-grid').append(label);
}

function renderTool(tool) {
  const card = makeElement('article', 'item-card');
  const heading = makeElement('div', 'item-heading');
  heading.append(makeElement('h3', 'item-title', tool.title));
  const kindLabel = tool.kind === 'verified' ? 'Verified adapter' : (tool.kind === 'generated' ? 'Generated' : 'Native');
  const kindClass = tool.kind === 'verified' ? 'kind-verified' : (tool.kind === 'generated' ? 'kind-generated' : 'kind-native');
  heading.append(badge(kindLabel, kindClass));
  card.append(heading);
  card.append(makeElement('p', 'item-description', tool.description));
  const metadata = makeElement('div', 'badge-row');
  metadata.append(makeElement('span', 'risk-badge', tool.name));
  if (tool.provenance !== 'native') metadata.append(makeElement('span', 'risk-badge', tool.provenance));
  card.append(metadata);
  return card;
}

function renderPreparedApproval(preparedAction, controller, onChanged) {
  const card = makeElement('div', 'item-card approval-card');
  const heading = makeElement('div', 'item-heading');
  heading.append(makeElement('h3', 'item-title', 'Review exact action'));
  heading.append(badge('Awaiting approval', 'kind-mutate'));
  card.append(heading);
  const effect = preparedAction.effect ?? {};
  const target = preparedAction.target ?? {};
  const details = makeElement('div', 'detail-list');
  details.append(detailRow('Action', preparedAction.title ?? preparedAction.name ?? preparedAction.toolName ?? preparedAction.id));
  details.append(detailRow('Target', target.ref ?? preparedAction.targetRef ?? 'Exact target bound in snapshot'));
  details.append(detailRow('Arguments', displayJson(preparedAction.arguments ?? preparedAction.normalizedArguments ?? {}), true));
  details.append(detailRow('Effect', effect.summary ?? preparedAction.effectSummary ?? 'External effect not supplied'));
  details.append(detailRow('Risk', preparedAction.risk ?? effect.risk ?? preparedAction.classification ?? 'Review'));
  card.append(details);
  const footer = makeElement('div', 'approval-footer');
  const deny = makeElement('button', 'button button-danger', 'Deny');
  deny.type = 'button';
  deny.addEventListener('click', async (event) => {
    if (!trustedEvent(event)) return;
    const response = await controller.denyPreparedAction(preparedAction, event);
    onChanged(response, response.ok === true ? 'Action denied.' : response.error?.message);
  });
  const approve = makeElement('button', 'button button-primary', 'Approve');
  approve.type = 'button';
  approve.addEventListener('click', async (event) => {
    if (!trustedEvent(event)) return;
    const response = await controller.approveAction(preparedAction, event);
    onChanged(response, response.ok === true ? 'Approval persisted.' : response.error?.message);
  });
  footer.append(deny, approve);
  card.append(footer);
  return card;
}

function renderAction(action, controller, onChanged) {
  const card = makeElement('article', 'item-card');
  const heading = makeElement('div', 'item-heading');
  heading.append(makeElement('h3', 'item-title', action.title));
  heading.append(badge(action.classification, action.classification === 'read' ? 'kind-read' : 'kind-mutate'));
  card.append(heading);
  card.append(makeElement('p', 'item-description', action.description));
  const metadata = makeElement('div', 'badge-row');
  metadata.append(makeElement('span', 'risk-badge', `Risk: ${action.risk}`));
  metadata.append(makeElement('span', 'risk-badge', action.requiresApproval ? 'Approval required' : 'Read / stage'));
  card.append(metadata);

  const form = document.createElement('form');
  form.className = 'action-form';
  form.noValidate = true;
  const fieldGrid = makeElement('div', 'field-grid');
  form.append(fieldGrid);
  const properties = plainObject(action.inputSchema?.properties) ? action.inputSchema.properties : {};
  for (const [name, schema] of Object.entries(properties).slice(0, 32)) addInputField(form, name, plainObject(schema) ? schema : {});
  const footer = makeElement('div', 'action-footer');
  const prepare = makeElement('button', 'button button-primary', 'Prepare exact action');
  prepare.type = 'submit';
  footer.append(prepare);
  form.append(footer);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!trustedEvent(event)) return;
    prepare.disabled = true;
    const response = await controller.prepareAction(action.id, readArguments(form, action.inputSchema));
    prepare.disabled = false;
    onChanged(response, response.ok === true ? 'Exact action prepared for review.' : response.error?.message);
  });
  card.append(form);
  const preparedAction = controller.getPreparedActions().find((entry) => (
    entry.id ?? entry.toolName ?? entry.tool?.name ?? entry.actionId
  ) === action.id);
  if (preparedAction) card.append(renderPreparedApproval(preparedAction, controller, onChanged));
  return card;
}

function renderApproval(record, controller, onChanged) {
  const card = makeElement('article', 'item-card approval-card');
  const scope = plainObject(record.scope) ? record.scope : {};
  const heading = makeElement('div', 'item-heading');
  heading.append(makeElement('h3', 'item-title', scope.title ?? scope.name ?? scope.toolName ?? record.id));
  heading.append(badge(record.state, record.state === 'approved' ? 'kind-mutate' : 'risk-badge'));
  card.append(heading);
  const details = makeElement('div', 'detail-list');
  details.append(detailRow('Fingerprint', record.fingerprint, true));
  details.append(detailRow('Target', scope.target?.ref ?? scope.targetRef ?? 'Exact target bound in approval'));
  details.append(detailRow('Arguments', displayJson(scope.arguments ?? scope.normalizedArguments ?? {}), true));
  details.append(detailRow('Effect', scope.effect?.summary ?? scope.effectSummary ?? 'External effect bound in approval'));
  details.append(detailRow('Nonce', record.nonce, true));
  card.append(details);
  const footer = makeElement('div', 'approval-footer');
  const expiry = makeElement('span', 'approval-expiry', `Expires ${record.expiresAt ? new Date(record.expiresAt).toLocaleTimeString() : 'soon'}`);
  footer.append(expiry);
  if (record.state === 'approved') {
    const deny = makeElement('button', 'button button-danger', 'Deny');
    deny.type = 'button';
    deny.addEventListener('click', async (event) => {
      if (!trustedEvent(event)) return;
      const response = await controller.denyApproval(record.id, event);
      onChanged(response, response.ok === true ? 'Approval denied.' : response.error?.message);
    });
    const execute = makeElement('button', 'button button-primary', 'Dispatch approved action');
    execute.type = 'button';
    execute.addEventListener('click', async (event) => {
      if (!trustedEvent(event)) return;
      execute.disabled = true;
      const response = await controller.executeApproval(record.id, event);
      execute.disabled = false;
      onChanged(response, response.ok === true ? 'Action dispatched; postcondition unverified.' : response.error?.message);
    });
    footer.append(deny, execute);
  }
  card.append(footer);
  return card;
}

function renderEvidence(entry) {
  const card = makeElement('article', 'item-card evidence-card');
  const heading = makeElement('div', 'item-heading');
  heading.append(makeElement('h3', 'item-title', entry.kind));
  heading.append(badge(entry.status, entry.status === 'completed' ? 'kind-read' : 'risk-badge'));
  card.append(heading);
  card.append(makeElement('p', 'item-description evidence-summary', entry.summary));
  const metadata = makeElement('div', 'badge-row');
  metadata.append(makeElement('span', 'risk-badge', entry.provider));
  if (entry.confidence !== null) metadata.append(makeElement('span', 'risk-badge', `${Math.round(entry.confidence * 100)}% confidence`));
  card.append(metadata);
  return card;
}

function renderReceipt(record) {
  const card = makeElement('article', 'item-card receipt-card');
  const heading = makeElement('div', 'item-heading');
  heading.append(makeElement('h3', 'item-title', record.operation));
  heading.append(badge(record.status, record.status === 'outcome-unknown' ? 'risk-badge' : 'kind-mutate'));
  card.append(heading);
  const details = makeElement('div', 'detail-list');
  details.append(detailRow('Target', record.target));
  details.append(detailRow('Action', record.actionId, true));
  details.append(detailRow('Events', record.events.join(', ') || 'Dispatched'));
  details.append(detailRow('Outcome', record.outcome === 'unknown' ? 'Unknown after dispatch' : 'Postcondition unverified'));
  if (record.approvalFingerprint) details.append(detailRow('Approval', record.approvalFingerprint, true));
  card.append(details);
  return card;
}

function renderAuditEntry(entry) {
  const row = makeElement('div', 'audit-row');
  row.append(makeElement('span', 'audit-sequence', `#${entry.sequence}`));
  row.append(makeElement('span', 'audit-event', entry.event));
  row.append(makeElement('code', 'audit-hash', entry.hash));
  return row;
}

function emptyMessage(value) {
  return makeElement('p', 'empty-state', value);
}

function renderList(container, values, renderer, fallback) {
  container.replaceChildren();
  if (!values.length) {
    container.append(emptyMessage(fallback));
    return;
  }
  for (const value of values) container.append(renderer(value));
}

export function createSidepanelApp({
  documentRef = globalThis.document,
  controller = null,
  wait = (delayMs) => new Promise((resolve) => globalThis.setTimeout(resolve, delayMs)),
} = {}) {
  if (!documentRef) return null;
  const appController = controller ?? createUiController();
  const refs = {
    connection: documentRef.getElementById('connection-badge'),
    refresh: documentRef.getElementById('refresh-button'),
    mode: documentRef.getElementById('page-mode'),
    origin: documentRef.getElementById('page-origin'),
    title: documentRef.getElementById('page-title'),
    tab: documentRef.getElementById('tab-value'),
    fingerprint: documentRef.getElementById('fingerprint-value'),
    toolsCount: documentRef.getElementById('tools-count'),
    tools: documentRef.getElementById('tools-list'),
    actionsCount: documentRef.getElementById('actions-count'),
    actions: documentRef.getElementById('actions-list'),
    evidenceCount: documentRef.getElementById('evidence-count'),
    evidenceStats: documentRef.getElementById('evidence-stats'),
    evidenceWarnings: documentRef.getElementById('evidence-warnings'),
    evidence: documentRef.getElementById('evidence-list'),
    providerBadge: documentRef.getElementById('provider-badge'),
    providerForm: documentRef.getElementById('provider-form'),
    providerEndpoint: documentRef.getElementById('provider-endpoint'),
    providerVisionModel: documentRef.getElementById('provider-vision-model'),
    providerAudioModel: documentRef.getElementById('provider-audio-model'),
    providerApiKey: documentRef.getElementById('provider-api-key'),
    providerDisable: documentRef.getElementById('provider-disable'),
    providerSave: documentRef.getElementById('provider-save'),
    providerNote: documentRef.getElementById('provider-note'),
    approvalsCount: documentRef.getElementById('approvals-count'),
    approvals: documentRef.getElementById('approvals-list'),
    receiptsCount: documentRef.getElementById('receipts-count'),
    receipts: documentRef.getElementById('receipts-list'),
    auditBadge: documentRef.getElementById('audit-badge'),
    auditHead: documentRef.getElementById('audit-head'),
    audit: documentRef.getElementById('audit-list'),
    quarantine: documentRef.getElementById('quarantine-count'),
    toast: documentRef.getElementById('toast'),
  };
  let toastTimer = null;

  function toast(message, isError = false) {
    if (!refs.toast) return;
    clearTimeout(toastTimer);
    refs.toast.textContent = boundedText(message, '', 320);
    refs.toast.className = `toast toast-visible${isError ? ' toast-error' : ''}`;
    toastTimer = setTimeout(() => { refs.toast.className = 'toast'; }, 3600);
  }

  function render(state) {
    if (!state) return;
    if (refs.connection) {
      refs.connection.textContent = state.connection === 'ready' ? 'Connected' : 'Bridge unavailable';
      refs.connection.className = `status-badge ${state.connection === 'ready' ? 'status-ready' : 'status-error'}`;
    }
    if (refs.mode) refs.mode.textContent = boundedText(state.mode, 'Waiting', 64);
    if (refs.origin) refs.origin.textContent = boundedText(state.tab.origin, 'No active HTTP(S) page', 256);
    if (refs.title) refs.title.textContent = boundedText(state.tab.title, 'Activate ToolBraid on a tab to inspect its live context.', 240);
    if (refs.tab) refs.tab.textContent = state.tab.id === null ? '—' : String(state.tab.id);
    if (refs.fingerprint) refs.fingerprint.textContent = boundedText(state.snapshot.fingerprint, '—', 128);
    if (refs.toolsCount) refs.toolsCount.textContent = String(state.tools.length);
    if (refs.actionsCount) refs.actionsCount.textContent = String(state.actions.length);
    if (refs.approvalsCount) refs.approvalsCount.textContent = String(state.approvals.length);
    if (refs.evidenceCount) refs.evidenceCount.textContent = String(state.evidence.stats.total);
    if (refs.evidenceStats) refs.evidenceStats.textContent = `${state.evidence.stats.completed} analyzed · ${state.evidence.stats.degraded} degraded · ${state.evidence.stats.blocked} blocked`;
    if (refs.evidenceWarnings) {
      refs.evidenceWarnings.textContent = state.evidence.warnings.length ? `Capture notes: ${state.evidence.warnings.join(', ')}` : 'Visible-tab capture is ephemeral and never grants action authority.';
      refs.evidenceWarnings.className = `policy-note${state.evidence.warnings.length ? ' policy-warning' : ''}`;
    }
    if (refs.providerBadge) {
      refs.providerBadge.textContent = state.multimodalProvider.enabled ? 'Provider enabled' : 'Metadata only';
      refs.providerBadge.className = `status-badge ${state.multimodalProvider.enabled ? 'status-ready' : 'status-pending'}`;
    }
    const providerFields = [
      [refs.providerEndpoint, state.multimodalProvider.baseUrl],
      [refs.providerVisionModel, state.multimodalProvider.visionModel],
      [refs.providerAudioModel, state.multimodalProvider.audioModel],
    ];
    for (const [field, value] of providerFields) {
      if (field && documentRef.activeElement !== field) field.value = value;
    }
    if (refs.providerApiKey && documentRef.activeElement !== refs.providerApiKey) refs.providerApiKey.value = '';
    if (refs.providerNote) {
      refs.providerNote.textContent = state.multimodalProvider.enabled
        ? `Enabled for ${state.multimodalProvider.permissionOrigin || 'the configured endpoint'} · ${state.multimodalProvider.hasApiKey ? 'session key loaded' : 'no API key'}. Analysis remains evidence only.`
        : 'Disabled by default. Enabling requests access only to the exact endpoint origin; the API key stays in extension session storage.';
    }
    if (refs.receiptsCount) refs.receiptsCount.textContent = String(state.receipts.length);
    if (refs.auditBadge) {
      refs.auditBadge.textContent = state.audit.verified ? `Chain verified · ${state.audit.count}` : 'Chain unavailable';
      refs.auditBadge.className = `status-badge ${state.audit.verified ? 'status-ready' : 'status-error'}`;
    }
    if (refs.auditHead) refs.auditHead.textContent = state.audit.head;
    if (refs.quarantine) refs.quarantine.textContent = state.quarantinedCount ? `${state.quarantinedCount} quarantined` : 'No quarantined tools';
    if (refs.tools) renderList(refs.tools, state.tools, renderTool, 'No tools discovered yet.');
    if (refs.actions) renderList(refs.actions, state.actions, (action) => renderAction(action, appController, (response, message) => {
      toast(message ?? 'Action update failed.', response?.ok !== true);
      if (response?.ok === true) void appController.refresh().then(render);
      else render(appController.getState());
    }), 'No page actions discovered yet.');
    if (refs.approvals) renderList(refs.approvals, state.approvals, (approval) => renderApproval(approval, appController, (response, message) => {
      toast(message ?? 'Approval update failed.', response?.ok !== true);
      if (response?.ok === true) void appController.refresh().then(render);
    }), 'No active approvals.');
    if (refs.evidence) renderList(refs.evidence, state.evidence.items, renderEvidence, 'No visual, audio, or video evidence on this page.');
    if (refs.receipts) renderList(refs.receipts, state.receipts, renderReceipt, 'No action has been dispatched.');
    if (refs.audit) renderList(refs.audit, state.audit.entries, renderAuditEntry, 'Audit entries appear after activation.');
  }

  async function refresh() {
    const state = await appController.refresh();
    render(state);
    if (state.connection !== 'ready') toast(state.error || 'Bridge unavailable.', true);
    return state;
  }

  async function initialRefresh() {
    let state = null;
    for (let attempt = 0; attempt <= INITIAL_REFRESH_DELAYS_MS.length; attempt += 1) {
      state = await appController.refresh();
      if (state.connection === 'ready') {
        render(state);
        return state;
      }
      if (attempt < INITIAL_REFRESH_DELAYS_MS.length) {
        if (refs.connection) {
          refs.connection.textContent = 'Connecting';
          refs.connection.className = 'status-badge status-pending';
        }
        await wait(INITIAL_REFRESH_DELAYS_MS[attempt]);
      }
    }
    render(state);
    toast(state?.error || 'Bridge unavailable.', true);
    return state;
  }

  refs.refresh?.addEventListener('click', (event) => {
    if (!trustedEvent(event)) return;
    void refresh();
  });
  refs.providerForm?.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!trustedEvent(event)) return;
    refs.providerSave.disabled = true;
    const response = await appController.configureMultimodal({
      baseUrl: refs.providerEndpoint?.value ?? '',
      visionModel: refs.providerVisionModel?.value ?? '',
      audioModel: refs.providerAudioModel?.value ?? '',
      apiKey: refs.providerApiKey?.value ?? '',
    }, event);
    refs.providerSave.disabled = false;
    if (refs.providerApiKey) refs.providerApiKey.value = '';
    toast(response.ok === true ? 'Multimodal provider enabled and page reanalyzed.' : response.error?.message, response.ok !== true);
    if (response.ok === true) render(appController.getState());
  });
  refs.providerDisable?.addEventListener('click', async (event) => {
    if (!trustedEvent(event)) return;
    refs.providerDisable.disabled = true;
    const response = await appController.disableMultimodal(event);
    refs.providerDisable.disabled = false;
    toast(response.ok === true ? 'Multimodal provider disabled.' : response.error?.message, response.ok !== true);
    if (response.ok === true) render(appController.getState());
  });
  void initialRefresh();
  return Object.freeze({ controller: appController, refresh, initialRefresh, render });
}

if (globalThis.document?.getElementById) createSidepanelApp();

export { ApprovalStoreError, INITIAL_REFRESH_DELAYS_MS, boundedText, normalizeState, trustedEvent };
