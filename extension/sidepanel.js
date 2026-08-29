import {
  PROVENANCE,
  ApprovalStoreError,
  createApprovalStore,
  stableStringify,
} from './approval-store.js';
import { createMultimodalSettingsStore } from './multimodal-provider.js';
import { HANDOFF_UI_MESSAGE_TYPES } from './handoff-runtime.js';
import { MISSION_UI_MESSAGE_TYPES } from './mission-runtime.js';

export const UI_MESSAGE_TYPES = Object.freeze({
  UI_GET_STATE: 'UI_GET_STATE',
  UI_PREPARE_ACTION: 'UI_PREPARE_ACTION',
  UI_EXECUTE_READ: 'UI_EXECUTE_READ',
  UI_APPROVE_ACTION: 'UI_APPROVE_ACTION',
  UI_EXECUTE_ACTION: 'UI_EXECUTE_ACTION',
  UI_REANALYZE_MULTIMODAL: 'UI_REANALYZE_MULTIMODAL',
  UI_MISSION_CREATE: MISSION_UI_MESSAGE_TYPES.CREATE,
  UI_MISSION_ATTACH: MISSION_UI_MESSAGE_TYPES.ATTACH,
  UI_MISSION_REBIND: MISSION_UI_MESSAGE_TYPES.REBIND,
  UI_MISSION_SELECT: MISSION_UI_MESSAGE_TYPES.SELECT,
  UI_MISSION_DETACH: MISSION_UI_MESSAGE_TYPES.DETACH,
  UI_MISSION_ROUTE: MISSION_UI_MESSAGE_TYPES.ROUTE,
  UI_MISSION_SET_PHASE: MISSION_UI_MESSAGE_TYPES.SET_PHASE ?? 'UI_MISSION_SET_PHASE',
  UI_HANDOFF_REQUEST: HANDOFF_UI_MESSAGE_TYPES.REQUEST,
  UI_HANDOFF_OPEN_SURFACE: HANDOFF_UI_MESSAGE_TYPES.OPEN_SURFACE,
  UI_HANDOFF_COMPLETE: HANDOFF_UI_MESSAGE_TYPES.COMPLETE,
  UI_HANDOFF_CAPTCHA_ATTEMPT: HANDOFF_UI_MESSAGE_TYPES.CAPTCHA_ATTEMPT ?? 'UI_HANDOFF_CAPTCHA_ATTEMPT',
});

const UI_MESSAGE_TYPE_SET = new Set(Object.values(UI_MESSAGE_TYPES));
const MAX_TEXT = 512;
const MAX_MISSION_OBJECTIVE = 280;
const MISSION_OBJECTIVE_FALLBACK = 'Inspect the active page and recover safely.';
const INITIAL_REFRESH_DELAYS_MS = Object.freeze([100, 250, 500, 900, 1500]);
const TERMINAL_MISSION_PHASES = new Set(['completed', 'failed', 'cancelled']);

function activeMission(mission) {
  return !TERMINAL_MISSION_PHASES.has(mission?.phase);
}

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

function boundedStructuredValue(value, depth = 0) {
  if (depth > 5) return '[depth limit]';
  if (value === null || value === undefined || typeof value === 'boolean') return value ?? null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') return boundedText(value, '', 4000);
  if (Array.isArray(value)) return value.slice(0, 32).map((entry) => boundedStructuredValue(entry, depth + 1));
  if (!plainObject(value)) return boundedText(value, '[unsupported]', 256);
  const output = {};
  for (const [rawKey, entry] of Object.entries(value).slice(0, 48)) {
    const key = boundedText(rawKey, '', 128);
    if (key) output[key] = boundedStructuredValue(entry, depth + 1);
  }
  return output;
}

function normalizedPreparedKey(value) {
  return boundedText(value?.id ?? value?.toolName ?? value?.tool?.name ?? value?.name ?? value?.actionId, '', 220);
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
  const provenance = plainObject(tool?.provenance) ? tool.provenance : {};
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
    classification: boundedText(tool?.classification ?? tool?.kind, 'read', 32).toLowerCase(),
    risk: boundedText(tool?.risk ?? tool?.effect?.risk, 'read-only', 64),
    inputSchema: plainObject(tool?.inputSchema) ? safeJson(tool.inputSchema) : { type: 'object', properties: {} },
    kind: verified ? 'verified' : (generated ? 'generated' : 'native'),
    provenance: verified ? 'toolbraid.verified-adapter' : (generated ? PROVENANCE : 'native'),
    adapterId: boundedText(provenance.adapterId ?? tool?.adapter?.id, '', 128),
    adapterVersion: boundedText(provenance.adapterVersion ?? provenance.version ?? tool?.adapter?.version, '', 64),
    pageFingerprint: boundedText(provenance.pageFingerprint, '', 128),
    sourceType: boundedText(tool?.sourceType ?? tool?.source ?? provenance.adapterId, 'page', 64),
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

function normalizeMissionInspection(value) {
  const source = plainObject(value) ? value : {};
  const target = plainObject(source.target) ? source.target : {};
  const page = plainObject(source.page) ? source.page : {};
  const mission = plainObject(source.mission) ? source.mission : {};
  const origin = safeOrigin(target.origin ?? page.origin ?? page.url);
  return {
    receivedAt: new Date().toISOString(),
    target: {
      ref: boundedText(target.ref ?? target.targetRef, Number.isInteger(target.tabId) ? `tab:${target.tabId}/frame:${target.frameId ?? 0}` : 'Exact bound target', 220),
      tabId: Number.isInteger(target.tabId) ? target.tabId : null,
      frameId: Number.isInteger(target.frameId) ? target.frameId : 0,
      role: boundedText(target.role, '', 64),
    },
    page: {
      title: boundedText(page.title, 'Live page', 240),
      origin: origin === 'Unavailable' ? null : origin,
      pageFingerprint: boundedText(page.pageFingerprint ?? target.pageFingerprint, '—', 128),
      revision: Number.isInteger(page.revision) ? page.revision : null,
    },
    mission: {
      missionId: boundedText(mission.missionId, 'Unknown mission', 220),
      phase: boundedText(mission.phase, 'unknown', 32),
      revision: Number.isInteger(mission.revision) ? mission.revision : null,
    },
  };
}

function normalizeStageResult(value) {
  const source = plainObject(value) ? value : {};
  const receipt = plainObject(source.receipt) ? source.receipt : {};
  return {
    status: boundedText(source.status, 'staged', 64),
    outcome: boundedText(source.outcome ?? receipt.outcome, 'local-stage', 64),
    operation: boundedText(receipt.operation, 'local-stage', 64),
    target: boundedText(receipt.ref ?? receipt.target?.ref, 'Bound page control', 180),
    events: Array.isArray(receipt.events) ? receipt.events.slice(0, 8).map((event) => boundedText(event, '', 64)).filter(Boolean) : [],
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

function finiteEvidenceNumber(value, fallback = null) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function normalizeEvidenceSegment(value) {
  if (!plainObject(value)) return null;
  const start = Math.max(0, finiteEvidenceNumber(value.start ?? value.begin ?? value.timestamp ?? value.time, 0));
  const end = Math.max(start, finiteEvidenceNumber(value.end ?? value.stop, start));
  return {
    start,
    end,
    text: boundedText(value.text, '', 1000),
    label: boundedText(value.label, '', 160),
    speaker: boundedText(value.speaker, '', 80),
    language: boundedText(value.language, '', 64),
    confidence: Number.isFinite(value.confidence) ? unitInterval(value.confidence) : null,
  };
}

function normalizeEvidenceRegion(value) {
  if (!plainObject(value)) return null;
  const x = unitInterval(value.x ?? value.left);
  const y = unitInterval(value.y ?? value.top);
  const width = Math.min(unitInterval(value.width, 0.08), 1 - x);
  const height = Math.min(unitInterval(value.height, 0.08), 1 - y);
  return {
    label: boundedText(value.label ?? value.name ?? value.role, 'region', 160),
    x,
    y,
    width,
    height,
    confidence: Number.isFinite(value.confidence) ? unitInterval(value.confidence) : null,
  };
}

function normalizeEvidenceKeyframe(value) {
  if (!plainObject(value)) return null;
  const timestamp = Math.max(0, finiteEvidenceNumber(value.timestamp ?? value.time ?? value.at, 0));
  return {
    timestamp,
    summary: boundedText(value.summary, '', 1000),
    label: boundedText(value.label, '', 160),
    confidence: Number.isFinite(value.confidence) ? unitInterval(value.confidence) : null,
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
    transcript: boundedText(entry?.transcript, '', 4000),
    language: boundedText(entry?.language, '', 64),
    model: boundedText(entry?.model ?? entry?.provider?.model, '', 256),
    labels: Array.isArray(entry?.labels) ? entry.labels.slice(0, 32).map((label) => boundedText(label, '', 128)).filter(Boolean) : [],
    segments: Array.isArray(entry?.segments) ? entry.segments.slice(0, 32).map(normalizeEvidenceSegment).filter(Boolean) : [],
    regions: Array.isArray(entry?.regions) ? entry.regions.slice(0, 32).map(normalizeEvidenceRegion).filter(Boolean) : [],
    keyframes: Array.isArray(entry?.keyframes) ? entry.keyframes.slice(0, 24).map(normalizeEvidenceKeyframe).filter(Boolean) : [],
    warnings: Array.isArray(entry?.warnings) ? entry.warnings.slice(0, 24).map((warning) => boundedText(warning, '', 160)).filter(Boolean) : [],
    untrustedContent: entry?.untrustedContent === true,
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
  const verification = plainObject(record?.verification) ? record.verification : {};
  const approvalClaim = plainObject(record?.approvalClaim) ? record.approvalClaim : {};
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
    approvalClaimedAt: boundedText(approvalClaim.claimedAt, '', 64),
    approvalExpiresAt: boundedText(approvalClaim.expiresAt, '', 64),
    status,
    outcome,
    postcondition,
    verification: {
      status: boundedText(verification.status, '', 64),
      reasonCode: boundedText(verification.reasonCode, '', 128),
      contractId: boundedText(verification.contractId, '', 160),
      adapterId: boundedText(verification.adapterId, '', 128),
      adapterVersion: boundedText(verification.adapterVersion, '', 64),
      beforePageFingerprint: boundedText(verification.beforePageFingerprint, '', 128),
      afterPageFingerprint: boundedText(verification.afterPageFingerprint, '', 128),
      checkedAt: boundedText(verification.checkedAt, '', 64),
      evidence: boundedStructuredValue(verification.evidence ?? []),
    },
  };
}

function normalizeAudit(audit) {
  const entries = Array.isArray(audit?.entries) ? audit.entries : [];
  return {
    verified: audit?.verified === true,
    count: Number.isInteger(audit?.count) ? audit.count : entries.length,
    head: boundedText(audit?.head, '—', 128),
    entries: entries.slice(-24).map((entry, index) => {
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

function normalizeQuarantineEntry(value, index) {
  const source = plainObject(value) ? value : {};
  const descriptor = plainObject(source.descriptor) ? source.descriptor : {};
  const assessment = plainObject(source.assessment) ? source.assessment : {};
  const winning = plainObject(source.winningDescriptor) ? source.winningDescriptor : {};
  return {
    id: `quarantine-${index + 1}`,
    name: boundedText(descriptor.name ?? source.name ?? source.packId, `Quarantined item ${index + 1}`, 180),
    reason: boundedText(assessment.reasonCode ?? source.code ?? source.reasonCode, 'Policy rejected this descriptor.', 160),
    source: boundedText(descriptor.sourceType ?? descriptor.provenance?.adapterId ?? source.sourceType, 'discovery', 96),
    stage: boundedText(source.stage, '', 96),
    packId: boundedText(source.packId, '', 128),
    version: boundedText(source.version, '', 64),
    winningName: boundedText(winning.name, '', 180),
  };
}

function normalizeCapabilityPacks(value) {
  const source = plainObject(value) ? value : {};
  const normalizePack = (pack, index, state) => ({
    id: boundedText(pack?.id, `pack-${index + 1}`, 128),
    version: boundedText(pack?.version, 'unknown', 64),
    status: boundedText(pack?.status, state, 48),
    toolCount: Number.isInteger(pack?.toolCount) ? pack.toolCount : null,
    maxTools: Number.isInteger(pack?.maxTools) ? pack.maxTools : null,
    objectiveScore: Number.isFinite(pack?.objectiveScore) ? Number(pack.objectiveScore) : null,
  });
  const selected = (Array.isArray(source.selected) ? source.selected : []).slice(0, 32).map((pack, index) => normalizePack(pack, index, 'selected'));
  const active = (Array.isArray(source.activePacks) ? source.activePacks : []).slice(0, 32).map((pack, index) => normalizePack(pack, index, 'active'));
  const budget = plainObject(source.budget) ? source.budget : {};
  return {
    selected,
    active,
    budget: {
      maxActiveTools: Number.isInteger(budget.maxActiveTools) ? budget.maxActiveTools : 0,
      usedTools: Number.isInteger(budget.usedTools) ? budget.usedTools : 0,
      remainingTools: Number.isInteger(budget.remainingTools) ? budget.remainingTools : 0,
    },
    quarantined: (Array.isArray(source.quarantined) ? source.quarantined : []).slice(0, 48).map(normalizeQuarantineEntry),
  };
}

function normalizePendingAction(value, index) {
  const source = plainObject(value) ? value : {};
  return {
    ...boundedStructuredValue(source),
    actionId: boundedText(source.actionId ?? source.id, `pending-${index + 1}`, 220),
    memberId: boundedText(source.memberId, '', 220),
    createdAt: boundedText(source.createdAt, '', 64),
  };
}

function normalizeMission(value, index) {
  const source = plainObject(value) ? value : {};
  const members = (Array.isArray(source.members) ? source.members : []).slice(0, 16).map((member, memberIndex) => ({
    memberId: boundedText(member?.memberId, `member-${memberIndex + 1}`, 220),
    tabId: Number.isInteger(member?.tabId) ? member.tabId : null,
    frameId: Number.isInteger(member?.frameId) ? member.frameId : 0,
    origin: safeOrigin(member?.origin),
    status: boundedText(member?.status, 'unknown', 32),
    role: boundedText(member?.role, 'tab', 64),
    required: member?.required === true,
    rebindRequired: member?.rebindRequired === true,
    joinedAt: boundedText(member?.joinedAt, '', 64),
    lastSeenAt: boundedText(member?.lastSeenAt, '', 64),
  }));
  return {
    missionId: boundedText(source.missionId, `mission-${index + 1}`, 220),
    objective: boundedText(source.objective, 'Mission objective not supplied.', MAX_MISSION_OBJECTIVE),
    phase: boundedText(source.phase, 'running', 32),
    revision: Number.isInteger(source.revision) ? source.revision : 0,
    activeMemberId: boundedText(source.activeMemberId, '', 220),
    members,
    pendingActions: (Array.isArray(source.pendingActions) ? source.pendingActions : []).slice(0, 48).map(normalizePendingAction),
    invalidatedActionIds: (Array.isArray(source.invalidatedActionIds) ? source.invalidatedActionIds : []).slice(0, 48).map((id) => boundedText(id, '', 220)).filter(Boolean),
  };
}

function approvalActionId(record) {
  const scope = plainObject(record?.scope) ? record.scope : {};
  return boundedText(scope.actionId ?? scope.id ?? scope.toolName ?? scope.name, '', 220);
}

function approvalContextFor(record, state) {
  const scope = plainObject(record?.scope) ? record.scope : {};
  const actionId = approvalActionId(record);
  const pending = state.pendingActions.find((entry) => boundedText(entry?.actionId ?? entry?.id, '', 220) === actionId);
  const scopeTabId = Number.isInteger(scope.tabId) ? scope.tabId : (Number.isInteger(scope.target?.tabId) ? scope.target.tabId : null);
  const scopeFrameId = Number.isInteger(scope.frameId) ? scope.frameId : (Number.isInteger(scope.target?.frameId) ? scope.target.frameId : 0);
  const scopeOriginValue = scope.origin ?? scope.provenance?.origin;
  const scopeOrigin = safeOrigin(scopeOriginValue);
  const scopeFingerprint = boundedText(scope.pageFingerprint ?? scope.provenance?.pageFingerprint ?? scope.target?.pageFingerprint, '', 128);
  const scopeSessionId = boundedText(scope.sessionId ?? scope.provenance?.sessionId, '', 220);
  const currentSessionId = boundedText(state.sessionId ?? pending?.sessionId, '', 220);
  const sameTab = scopeTabId !== null && scopeTabId === state.tab.id;
  const sameFrame = scopeFrameId === 0;
  const sameOrigin = scopeOrigin !== 'Unavailable' && scopeOrigin === state.tab.origin;
  const sameFingerprint = Boolean(scopeFingerprint) && scopeFingerprint === state.snapshot.fingerprint;
  const sameSession = Boolean(scopeSessionId) && Boolean(currentSessionId) && scopeSessionId === currentSessionId;
  const current = Boolean(pending) && sameTab && sameFrame && sameOrigin && sameFingerprint && sameSession;
  const samePage = sameTab && sameFrame && sameOrigin && sameFingerprint;
  const actionableState = ['approved', 'pending'].includes(record.state);
  return {
    actionable: current && actionableState,
    currentContext: current ? 'current' : (samePage ? 'same-page' : 'history'),
    context: {
      actionId,
      tabId: scopeTabId,
      frameId: scopeFrameId,
      sessionId: scopeSessionId || null,
      origin: scopeOrigin === 'Unavailable' ? null : scopeOrigin,
      pageFingerprint: scopeFingerprint || null,
      status: record.state,
    },
  };
}

function normalizeHandoff(value, index) {
  const source = plainObject(value) ? value : {};
  const origin = safeOrigin(source.safeOrigin);
  return {
    handoffId: boundedText(source.handoffId, `handoff-${index + 1}`, 220),
    type: boundedText(source.type, 'login', 24),
    state: boundedText(source.state, 'unknown', 40),
    missionId: boundedText(source.missionId, 'Unknown mission', 220),
    memberId: boundedText(source.memberId, 'Unknown member', 220),
    purpose: boundedText(source.purpose, 'Complete the human-only step.', 512),
    safeOrigin: origin === 'Unavailable' ? null : origin,
    expiresAt: boundedText(source.expiresAt, '', 64),
    captchaCheckboxAttempts: Number.isInteger(source.captchaCheckboxAttempts) ? source.captchaCheckboxAttempts : 0,
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
  const capabilityPacks = normalizeCapabilityPacks(source.capabilityPacks);
  const quarantined = (Array.isArray(source.quarantined) ? source.quarantined : []).slice(0, 64).map(normalizeQuarantineEntry);
  const normalizedTab = {
    id: Number.isInteger(tab.id) ? tab.id : (Number.isInteger(source.tabId) ? source.tabId : null),
    origin: safeOrigin(tab.origin ?? tab.url ?? source.origin ?? source.url),
    url: boundedText(tab.url ?? source.url, '', 1024),
    title: boundedText(tab.title ?? page.title, 'Untitled page', 240),
  };
  const normalizedSnapshot = {
    fingerprint: boundedText(snapshot.pageFingerprint ?? snapshot.fingerprint ?? source.pageFingerprint, '—', 128),
    navigation: boundedText(snapshot.navigationGeneration ?? snapshot.navigationId, '—', 80),
  };
  const pendingActions = (Array.isArray(source.pendingActions) ? source.pendingActions : []).slice(0, 48).map(normalizePendingAction);
  const normalized = {
    connection,
    error: connection === 'error' ? boundedText(source.error?.message ?? source.error, 'Bridge unavailable.', 320) : '',
    tab: normalizedTab,
    sessionId: boundedText(source.sessionId, '', 220),
    mode: boundedText(source.mode ?? source.surface, 'Waiting', 64),
    snapshot: normalizedSnapshot,
    tools,
    actions,
    pendingActions,
    approvals,
    evidence,
    capabilityPacks,
    multimodalProvider: normalizeMultimodalProvider(source.multimodalProvider),
    receipts: (Array.isArray(source.receipts) ? source.receipts : []).slice(-24).map(normalizeReceipt),
    audit: normalizeAudit(source.audit),
    quarantined,
    quarantinedCount: quarantined.length + capabilityPacks.quarantined.length,
    missions: (Array.isArray(source.missions) ? source.missions : []).map(normalizeMission),
    handoffs: (Array.isArray(source.handoffs) ? source.handoffs : []).map(normalizeHandoff),
    missionError: boundedText(source.missionError?.message, '', 320),
    handoffError: boundedText(source.handoffError?.message, '', 320),
  };
  normalized.approvals = approvals.map((record) => ({ ...record, ...approvalContextFor(record, normalized) }));
  return normalized;
}

function trustedEvent(event) {
  return event?.isTrusted === true;
}

function callChromeApi(target, method, argument, runtime = globalThis.chrome?.runtime) {
  const operation = target?.[method];
  if (typeof operation !== 'function') return Promise.reject(new Error(`${method} is unavailable.`));
  if (operation.length >= 2) {
    return new Promise((resolve, reject) => {
      try {
        operation.call(target, argument, (value) => {
          if (runtime?.lastError) reject(new Error(`${method} failed.`));
          else resolve(value);
        });
      } catch {
        reject(new Error(`${method} failed.`));
      }
    });
  }
  try {
    return Promise.resolve(operation.call(target, argument));
  } catch {
    return Promise.reject(new Error(`${method} failed.`));
  }
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
  browser = globalThis.chrome,
  store = createApprovalStore(),
  multimodalSettings = createMultimodalSettingsStore(),
  now = () => Date.now(),
} = {}) {
  let state = normalizeState({ connection: 'error', error: 'Bridge unavailable.' });
  const prepared = new Map();
  const readResults = new Map();
  const missionInspections = new Map();
  const actionResults = new Map();
  let contextKey = '';

  async function localApprovals() {
    try {
      return await store.list();
    } catch {
      return [];
    }
  }

  async function sendBoundUiMessage(type, payload = {}) {
    let target = {};
    if (browser?.tabs?.query) {
      try {
        const tabs = await callChromeApi(browser.tabs, 'query', { active: true, currentWindow: true }, browser.runtime);
        const tab = tabs?.[0];
        if (Number.isInteger(tab?.id) && Number.isInteger(tab?.windowId)) {
          target = { targetTabId: tab.id, targetWindowId: tab.windowId };
        }
      } catch { /* the worker falls back to its legacy active-tab lookup */ }
    }
    return sendUiMessage(type, { ...safeJson(payload), ...target }, runtime);
  }

  async function refresh() {
    const response = await sendBoundUiMessage(UI_MESSAGE_TYPES.UI_GET_STATE);
    const approvals = await localApprovals();
    if (response.ok === true) {
      const source = plainObject(response.state) ? response.state : response;
      const next = normalizeState({ ...source, connection: 'ready' }, approvals);
      const nextContextKey = `${next.tab.id ?? 'none'}:${next.snapshot.fingerprint}`;
      if (contextKey && contextKey !== nextContextKey) {
        for (const [key, pending] of prepared) {
          if (pending.tabId !== next.tab.id
            || pending.origin !== next.tab.origin
            || pending.pageFingerprint !== next.snapshot.fingerprint) prepared.delete(key);
        }
        readResults.clear();
        missionInspections.clear();
        actionResults.clear();
      }
      contextKey = nextContextKey;
      if (Array.isArray(source.pendingActions)) {
        const remoteKeys = new Set(next.pendingActions.map(normalizedPreparedKey).filter(Boolean));
        for (const key of prepared.keys()) if (!remoteKeys.has(key)) prepared.delete(key);
        for (const pending of next.pendingActions) {
          const key = normalizedPreparedKey(pending);
          const hasExactUiBinding = Number.isInteger(pending.tabId)
            && Number.isInteger(pending.frameId)
            && typeof pending.sessionId === 'string'
            && safeOrigin(pending.origin) === pending.origin;
          if (key && hasExactUiBinding) prepared.set(key, safeJson(pending));
        }
      }
      state = next;
    } else {
      state = normalizeState({ connection: 'error', error: response.error?.message }, approvals);
    }
    return state;
  }

  async function prepareAction(actionId, args = {}) {
    const id = boundedText(actionId, '', 160);
    if (!id) return errorResult('ACTION_ID_INVALID', 'A page action id is required.');
    if (!plainObject(args)) return errorResult('ACTION_ARGUMENTS_INVALID', 'Action arguments must be an object.');
    const response = await sendBoundUiMessage(UI_MESSAGE_TYPES.UI_PREPARE_ACTION, { actionId: id, arguments: safeJson(args) });
    if (response.ok !== true) return response;
    if (plainObject(response.preparedAction)) {
      prepared.set(id, safeJson(response.preparedAction));
      return { ...response, preparedAction: prepared.get(id) };
    }
    prepared.delete(id);
    if (plainObject(response.result) && response.result.status === 'staged') {
      actionResults.set(id, normalizeStageResult(response.result));
    }
    return response;
  }

  async function executeRead(toolName, input = {}, event) {
    if (!trustedEvent(event)) return errorResult('TRUSTED_ACTIVATION_REQUIRED', 'Running a page read requires a trusted user activation.');
    const name = boundedText(toolName, '', 160);
    if (!name) return errorResult('TOOL_NAME_INVALID', 'A read tool name is required.');
    if (!plainObject(input)) return errorResult('TOOL_INPUT_INVALID', 'Read input must be an object.');
    const tool = state.tools.find((entry) => entry.name === name || entry.id === name);
    if (!tool || tool.classification !== 'read') return errorResult('READ_TOOL_REQUIRED', 'The selected tool is not an active read tool.');
    const response = await sendBoundUiMessage(UI_MESSAGE_TYPES.UI_EXECUTE_READ, { toolId: tool.name, arguments: safeJson(input) });
    if (response.ok !== true) return response;
    const raw = plainObject(response.result) ? response.result : {};
    const rawTool = plainObject(raw.tool) ? raw.tool : {};
    const binding = plainObject(raw.binding) ? raw.binding : {};
    const normalized = {
      toolName: tool.name,
      receivedAt: new Date(now()).toISOString(),
      status: boundedText(raw.status, 'read-completed', 64),
      data: boundedStructuredValue(Object.prototype.hasOwnProperty.call(raw, 'data') ? raw.data : response.result),
      byteLength: Number.isInteger(raw.byteLength) ? raw.byteLength : null,
      truncated: raw.truncated === true,
      untrustedContent: raw.untrustedContent === true,
      provenance: {
        source: boundedText(rawTool.sourceType ?? tool.sourceType ?? tool.provenance, tool.provenance, 180),
        adapterId: boundedText(rawTool.adapterId ?? tool.adapterId, '', 128),
        adapterVersion: boundedText(rawTool.adapterVersion ?? tool.adapterVersion, '', 64),
        pageFingerprint: boundedText(binding.pageFingerprint ?? tool.pageFingerprint ?? state.snapshot.fingerprint, '', 128),
        origin: safeOrigin(binding.origin ?? state.tab.origin),
      },
    };
    readResults.set(tool.name, normalized);
    return { ...response, result: normalized };
  }

  async function approveAction(action, event, ttlMs) {
    if (!trustedEvent(event)) return errorResult('TRUSTED_ACTIVATION_REQUIRED', 'Approval changes require a trusted user activation.');
    if (!plainObject(action)) return errorResult('ACTION_REQUIRED', 'A prepared action object is required.');
    try {
      const approval = await store.createApproval({ event, action, ttlMs });
      const response = await sendBoundUiMessage(UI_MESSAGE_TYPES.UI_APPROVE_ACTION, { decision: 'approve', approval });
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
    return sendBoundUiMessage(UI_MESSAGE_TYPES.UI_APPROVE_ACTION, { decision: 'deny', action: safeJson(action) });
  }

  async function denyApproval(id, event) {
    if (!trustedEvent(event)) return errorResult('TRUSTED_ACTIVATION_REQUIRED', 'Approval changes require a trusted user activation.');
    try {
      const local = await store.get(id);
      if (local) await store.deny(id, event);
      return sendBoundUiMessage(UI_MESSAGE_TYPES.UI_APPROVE_ACTION, { decision: 'deny', approvalId: id, approval: local });
    } catch (error) {
      return errorResult(error.code ?? 'APPROVAL_DENY_FAILED', error.message ?? 'Approval could not be denied.');
    }
  }

  async function executeApproval(id, event) {
    if (!trustedEvent(event)) return errorResult('TRUSTED_ACTIVATION_REQUIRED', 'Execution changes require a trusted user activation.');
    try {
      const approval = await store.prepareExecution(id, event);
      const response = await sendBoundUiMessage(UI_MESSAGE_TYPES.UI_EXECUTE_ACTION, { approval });
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
      const response = await sendBoundUiMessage(UI_MESSAGE_TYPES.UI_REANALYZE_MULTIMODAL);
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
      const response = await sendBoundUiMessage(UI_MESSAGE_TYPES.UI_REANALYZE_MULTIMODAL);
      if (response.ok !== true) return { ...response, provider };
      await refresh();
      return { ok: true, provider, result: response.result, provenance: PROVENANCE };
    } catch (error) {
      return errorResult(error.code ?? 'MULTIMODAL_CONFIG_FAILED', error.message ?? 'The analysis provider could not be disabled.', error.details);
    }
  }

  async function analyzeMultimodal(event) {
    if (!trustedEvent(event)) return errorResult('TRUSTED_ACTIVATION_REQUIRED', 'Analyzing the current page requires a trusted user activation.');
    const response = await sendBoundUiMessage(UI_MESSAGE_TYPES.UI_REANALYZE_MULTIMODAL);
    if (response.ok === true) await refresh();
    return response;
  }

  async function startMission(event, objective = MISSION_OBJECTIVE_FALLBACK) {
    if (!trustedEvent(event)) return errorResult('TRUSTED_ACTIVATION_REQUIRED', 'Starting a mission requires a trusted user activation.');
    if (!Number.isInteger(state.tab.id)) return errorResult('ACTIVE_TAB_UNAVAILABLE', 'Activate ToolBraid on an HTTP(S) tab first.');
    if (state.missions.some((mission) => activeMission(mission) && mission.members.some((member) => (
      member.tabId === state.tab.id && member.frameId === 0 && member.status !== 'detached'
    )))) {
      return errorResult('TAB_FRAME_ALREADY_ATTACHED', 'The current page already belongs to an active mission.');
    }
    const missionObjective = boundedText(objective, MISSION_OBJECTIVE_FALLBACK, MAX_MISSION_OBJECTIVE);
    const created = await sendBoundUiMessage(UI_MESSAGE_TYPES.UI_MISSION_CREATE, { objective: missionObjective });
    if (created.ok !== true) return created;
    const missionId = created.result?.missionId;
    if (typeof missionId !== 'string') return errorResult('MISSION_CREATE_INVALID', 'The mission runtime returned no mission identifier.');
    const memberId = `member-${state.tab.id}-${Math.max(0, Math.trunc(Number(now())))}`;
    const attached = await sendBoundUiMessage(UI_MESSAGE_TYPES.UI_MISSION_ATTACH, {
      missionId,
      memberId,
      tabId: state.tab.id,
      frameId: 0,
    });
    if (attached.ok === true) return attached;
    const cleanup = await sendBoundUiMessage(UI_MESSAGE_TYPES.UI_MISSION_SET_PHASE, {
      missionId,
      phase: 'cancelled',
    });
    return {
      ...attached,
      cleanup: cleanup.ok === true
        ? { status: 'cancelled', missionId }
        : { status: 'failed', missionId, error: cleanup.error },
    };
  }

  async function setMissionPhase(missionId, phase, event) {
    if (!trustedEvent(event)) return errorResult('TRUSTED_ACTIVATION_REQUIRED', 'Changing a mission phase requires a trusted user activation.');
    const id = boundedText(missionId, '', 220);
    const normalizedPhase = boundedText(phase, '', 32).toLowerCase();
    if (!id || !['completed', 'cancelled'].includes(normalizedPhase)) {
      return errorResult('MISSION_PHASE_INVALID', 'Choose a supported terminal mission phase.');
    }
    const mission = state.missions.find((entry) => entry.missionId === id);
    if (!mission) return errorResult('MISSION_NOT_FOUND', 'The selected mission is no longer active.');
    if (mission.phase !== 'running') return errorResult('MISSION_PHASE_INVALID', 'Only a running mission can be completed or cancelled.');
    return sendBoundUiMessage(UI_MESSAGE_TYPES.UI_MISSION_SET_PHASE, {
      missionId: id,
      phase: normalizedPhase,
      expectedRevision: mission.revision,
    });
  }

  async function rebindMission(missionId, memberId, event) {
    if (!trustedEvent(event)) return errorResult('TRUSTED_ACTIVATION_REQUIRED', 'Rebinding a mission requires a trusted user activation.');
    if (!Number.isInteger(state.tab.id)) return errorResult('ACTIVE_TAB_UNAVAILABLE', 'Activate ToolBraid on an HTTP(S) tab first.');
    return sendBoundUiMessage(UI_MESSAGE_TYPES.UI_MISSION_REBIND, {
      missionId: boundedText(missionId, '', 220),
      memberId: boundedText(memberId, '', 220),
      tabId: state.tab.id,
      frameId: 0,
    });
  }

  async function attachMission(missionId, event, { role = 'tab', required = false } = {}) {
    if (!trustedEvent(event)) return errorResult('TRUSTED_ACTIVATION_REQUIRED', 'Attaching a page requires a trusted user activation.');
    if (!Number.isInteger(state.tab.id)) return errorResult('ACTIVE_TAB_UNAVAILABLE', 'Activate ToolBraid on an HTTP(S) tab first.');
    const id = boundedText(missionId, '', 220);
    if (!state.missions.some((mission) => mission.missionId === id && activeMission(mission))) return errorResult('MISSION_NOT_FOUND', 'The selected mission is no longer active.');
    return sendBoundUiMessage(UI_MESSAGE_TYPES.UI_MISSION_ATTACH, {
      missionId: id,
      memberId: `member-${state.tab.id}-${Math.max(0, Math.trunc(Number(now())))}`,
      tabId: state.tab.id,
      frameId: 0,
      role: boundedText(role, 'tab', 64),
      required: required === true,
    });
  }

  async function selectMissionMember(missionId, memberId, event) {
    if (!trustedEvent(event)) return errorResult('TRUSTED_ACTIVATION_REQUIRED', 'Selecting a mission member requires a trusted user activation.');
    return sendBoundUiMessage(UI_MESSAGE_TYPES.UI_MISSION_SELECT, {
      missionId: boundedText(missionId, '', 220),
      memberId: boundedText(memberId, '', 220),
    });
  }

  async function detachMissionMember(missionId, memberId, event) {
    if (!trustedEvent(event)) return errorResult('TRUSTED_ACTIVATION_REQUIRED', 'Detaching a mission member requires a trusted user activation.');
    return sendBoundUiMessage(UI_MESSAGE_TYPES.UI_MISSION_DETACH, {
      missionId: boundedText(missionId, '', 220),
      memberId: boundedText(memberId, '', 220),
    });
  }

  async function routeMission(missionId, memberId, operation = 'read', event) {
    if (!trustedEvent(event)) return errorResult('TRUSTED_ACTIVATION_REQUIRED', 'Routing a mission requires a trusted user activation.');
    const id = boundedText(missionId, '', 220);
    const member = boundedText(memberId, '', 220);
    const response = await sendBoundUiMessage(UI_MESSAGE_TYPES.UI_MISSION_ROUTE, {
      missionId: id,
      memberId: member,
      operation: operation === 'target' ? 'target' : 'read',
    });
    if (response.ok === true && plainObject(response.result)) {
      missionInspections.set(`${id}:${member}`, normalizeMissionInspection(response.result));
    }
    return response;
  }

  async function requestHandoff({ missionId, memberId, type, purpose }, event) {
    if (!trustedEvent(event)) return errorResult('TRUSTED_ACTIVATION_REQUIRED', 'Requesting a human handoff requires a trusted user activation.');
    const normalizedType = boundedText(type, '', 24).toLowerCase();
    if (!new Set(['login', '2fa', 'captcha']).has(normalizedType)) return errorResult('HANDOFF_TYPE_INVALID', 'Choose login, 2FA, or CAPTCHA.');
    return sendBoundUiMessage(UI_MESSAGE_TYPES.UI_HANDOFF_REQUEST, {
      missionId: boundedText(missionId, '', 220),
      memberId: boundedText(memberId, '', 220),
      type: normalizedType,
      purpose: boundedText(purpose, 'Complete the human-only step.', 512),
    });
  }

  async function openHandoff(handoffId, event) {
    if (!trustedEvent(event)) return errorResult('TRUSTED_ACTIVATION_REQUIRED', 'Opening a human handoff requires a trusted user activation.');
    const handoff = state.handoffs.find((entry) => entry.handoffId === handoffId);
    if (!handoff?.safeOrigin) return errorResult('HANDOFF_ORIGIN_INVALID', 'The handoff has no exact safe origin.');
    let createdWindow = null;
    try {
      if (!browser?.permissions?.request) return errorResult('HANDOFF_PERMISSION_UNAVAILABLE', 'Exact-origin handoff permission is unavailable.');
      const granted = await callChromeApi(browser.permissions, 'request', { origins: [`${handoff.safeOrigin}/*`] }, browser.runtime);
      if (granted !== true) return errorResult('HANDOFF_PERMISSION_DENIED', 'Exact-origin handoff permission was not granted.');
      createdWindow = await callChromeApi(browser.windows, 'create', {
        url: handoff.safeOrigin,
        type: 'popup',
        focused: true,
        width: 520,
        height: 720,
      }, browser.runtime);
      let surfaceTabId = createdWindow?.tabs?.[0]?.id;
      if (!Number.isInteger(surfaceTabId) && Number.isInteger(createdWindow?.id)) {
        const tabs = await callChromeApi(browser.tabs, 'query', { windowId: createdWindow.id }, browser.runtime);
        surfaceTabId = tabs?.[0]?.id;
      }
      if (!Number.isInteger(surfaceTabId)) throw new Error('Human handoff tab is unavailable.');
      const response = await sendBoundUiMessage(UI_MESSAGE_TYPES.UI_HANDOFF_OPEN_SURFACE, {
        handoffId: handoff.handoffId,
        surfaceTabId,
      });
      if (response.ok !== true && Number.isInteger(createdWindow?.id) && browser.windows?.remove) {
        await callChromeApi(browser.windows, 'remove', createdWindow.id, browser.runtime).catch(() => undefined);
      }
      return response;
    } catch {
      if (Number.isInteger(createdWindow?.id) && browser?.windows?.remove) {
        await callChromeApi(browser.windows, 'remove', createdWindow.id, browser.runtime).catch(() => undefined);
      }
      return errorResult('HANDOFF_OPEN_FAILED', 'The human handoff window could not be opened safely.');
    }
  }

  async function completeHandoff(handoffId, event) {
    if (!trustedEvent(event)) return errorResult('TRUSTED_ACTIVATION_REQUIRED', 'Completing a human handoff requires a trusted user activation.');
    return sendBoundUiMessage(UI_MESSAGE_TYPES.UI_HANDOFF_COMPLETE, {
      handoffId: boundedText(handoffId, '', 220),
    });
  }

  async function attemptCaptcha(handoffId, event) {
    if (!trustedEvent(event)) return errorResult('TRUSTED_ACTIVATION_REQUIRED', 'A CAPTCHA checkbox attempt requires a trusted user activation.');
    const handoff = state.handoffs.find((entry) => entry.handoffId === handoffId);
    if (!handoff || handoff.type !== 'captcha' || handoff.state !== 'human-active' || handoff.captchaCheckboxAttempts !== 0) {
      return errorResult('CAPTCHA_ATTEMPT_INVALID', 'The experimental checkbox attempt is not available for this handoff.');
    }
    return sendBoundUiMessage(UI_MESSAGE_TYPES.UI_HANDOFF_CAPTCHA_ATTEMPT, {
      handoffId: handoff.handoffId,
    });
  }

  function getPreparedActions() {
    return [...prepared.values()];
  }

  function getReadResult(toolName) {
    return readResults.get(toolName) ?? null;
  }

  function getMissionInspection(missionId, memberId) {
    return missionInspections.get(`${missionId}:${memberId}`) ?? null;
  }

  function getMissionInspections() {
    return [...missionInspections.values()];
  }

  function getActionResult(actionId) {
    return actionResults.get(actionId) ?? null;
  }

  function getState() {
    return state;
  }

  return Object.freeze({
    refresh,
    prepareAction,
    executeRead,
    approveAction,
    denyPreparedAction,
    denyApproval,
    executeApproval,
    configureMultimodal,
    disableMultimodal,
    analyzeMultimodal,
    startMission,
    rebindMission,
    attachMission,
    selectMissionMember,
    detachMissionMember,
    routeMission,
    setMissionPhase,
    requestHandoff,
    openHandoff,
    completeHandoff,
    attemptCaptcha,
    getPreparedActions,
    getReadResult,
    getMissionInspection,
    getMissionInspections,
    getActionResult,
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

async function withButtonBusy(button, label, operation) {
  const previous = button.textContent;
  button.disabled = true;
  button.textContent = label;
  try {
    return await operation();
  } finally {
    button.disabled = false;
    button.textContent = previous;
  }
}

function renderReadResult(result) {
  const details = makeElement('details', 'structured-result');
  details.open = true;
  const source = result.provenance?.adapterId || result.provenance?.source || 'bounded page result';
  details.append(makeElement('summary', '', `Read result · ${source}`));
  const provenance = makeElement('div', 'detail-list read-provenance');
  provenance.append(detailRow('Received', new Date(result.receivedAt).toLocaleTimeString()));
  provenance.append(detailRow('Status', result.status));
  if (result.provenance?.adapterId) provenance.append(detailRow('Adapter', `${result.provenance.adapterId}${result.provenance.adapterVersion ? ` · ${result.provenance.adapterVersion}` : ''}`));
  if (result.provenance?.origin && result.provenance.origin !== 'Unavailable') provenance.append(detailRow('Origin', result.provenance.origin));
  if (result.provenance?.pageFingerprint) provenance.append(detailRow('Page proof', result.provenance.pageFingerprint, true));
  if (result.byteLength !== null) provenance.append(detailRow('Payload', `${result.byteLength} bytes${result.truncated ? ' · bounded/truncated' : ''}`));
  if (result.untrustedContent) provenance.append(detailRow('Content', 'Untrusted page evidence'));
  details.append(provenance);
  const pre = makeElement('pre');
  pre.textContent = displayJson(result.data);
  details.append(pre);
  return details;
}

function renderTool(tool, controller, onChanged) {
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
  metadata.append(makeElement('span', 'risk-badge', tool.classification));
  if (tool.adapterId) metadata.append(makeElement('span', 'risk-badge', `${tool.adapterId}${tool.adapterVersion ? ` · ${tool.adapterVersion}` : ''}`));
  if (tool.provenance !== 'native') metadata.append(makeElement('span', 'risk-badge', tool.provenance));
  card.append(metadata);
  if (tool.classification === 'read') {
    const form = document.createElement('form');
    form.className = 'action-form';
    form.noValidate = true;
    form.append(makeElement('div', 'field-grid'));
    const properties = plainObject(tool.inputSchema?.properties) ? tool.inputSchema.properties : {};
    for (const [name, schema] of Object.entries(properties).slice(0, 32)) addInputField(form, name, plainObject(schema) ? schema : {});
    const footer = makeElement('div', 'action-footer');
    const run = makeElement('button', 'button button-primary', 'Run safe read');
    run.type = 'submit';
    run.dataset.action = 'run-safe-read';
    run.dataset.toolId = tool.name;
    footer.append(run);
    form.append(footer);
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (!trustedEvent(event)) return;
      const response = await withButtonBusy(run, 'Reading…', () => controller.executeRead(tool.name, readArguments(form, tool.inputSchema), event));
      onChanged(response, response.ok === true ? 'Safe read completed with bound provenance.' : response.error?.message);
    });
    card.append(form);
    const result = controller.getReadResult(tool.name);
    if (result) card.append(renderReadResult(result));
  }
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
  deny.dataset.action = 'deny-prepared-action';
  deny.dataset.actionId = preparedAction.actionId ?? preparedAction.id ?? '';
  deny.addEventListener('click', async (event) => {
    if (!trustedEvent(event)) return;
    const response = await withButtonBusy(deny, 'Denying…', () => controller.denyPreparedAction(preparedAction, event));
    onChanged(response, response.ok === true ? 'Action denied.' : response.error?.message);
  });
  const approve = makeElement('button', 'button button-primary', 'Approve');
  approve.type = 'button';
  approve.dataset.action = 'approve-prepared-action';
  approve.dataset.actionId = preparedAction.actionId ?? preparedAction.id ?? '';
  approve.addEventListener('click', async (event) => {
    if (!trustedEvent(event)) return;
    const response = await withButtonBusy(approve, 'Approving…', () => controller.approveAction(preparedAction, event));
    onChanged(response, response.ok === true ? 'Approval persisted.' : response.error?.message);
  });
  footer.append(deny, approve);
  card.append(footer);
  return card;
}

function renderPendingRestore(pendingAction, action, controller, onChanged) {
  const card = makeElement('div', 'item-card approval-card');
  const heading = makeElement('div', 'item-heading');
  heading.append(makeElement('h3', 'item-title', 'Prepared action recovered'));
  heading.append(badge('Scope refresh required', 'kind-mutate'));
  card.append(heading);
  card.append(makeElement('p', 'item-description', 'The runtime retained this pending action. Refresh its exact live binding before approval.'));
  const footer = makeElement('div', 'approval-footer');
  const restore = makeElement('button', 'button button-primary', 'Restore exact scope');
  restore.type = 'button';
  restore.dataset.action = 'restore-action-scope';
  restore.dataset.actionId = pendingAction.actionId ?? pendingAction.id ?? '';
  restore.addEventListener('click', async (event) => {
    if (!trustedEvent(event)) return;
    const input = plainObject(pendingAction.arguments)
      ? pendingAction.arguments
      : (plainObject(pendingAction.normalizedArguments) ? pendingAction.normalizedArguments : {});
    const response = await withButtonBusy(restore, 'Restoring…', () => controller.prepareAction(action.id, input));
    onChanged(response, response.ok === true ? 'Exact action scope restored for review.' : response.error?.message);
  });
  footer.append(restore);
  card.append(footer);
  return card;
}

function renderStageResult(result) {
  const card = makeElement('div', 'item-card stage-result');
  const heading = makeElement('div', 'item-heading');
  heading.append(makeElement('h3', 'item-title', 'Local stage applied'));
  heading.append(badge(result.status, 'kind-read'));
  card.append(heading);
  card.append(makeElement('p', 'item-description', 'The page control changed locally for review. No external action was dispatched.'));
  const details = makeElement('div', 'detail-list');
  details.append(detailRow('Outcome', result.outcome));
  details.append(detailRow('Target', result.target));
  if (result.events.length) details.append(detailRow('Events', result.events.join(', ')));
  card.append(details);
  return card;
}

function renderAction(action, controller, onChanged) {
  const isStage = action.classification === 'stage';
  const card = makeElement('article', 'item-card');
  card.dataset.actionId = action.id;
  const heading = makeElement('div', 'item-heading');
  heading.append(makeElement('h3', 'item-title', action.title));
  heading.append(badge(isStage ? 'Local stage' : action.classification, (action.classification === 'read' || isStage) ? 'kind-read' : 'kind-mutate'));
  card.append(heading);
  card.append(makeElement('p', 'item-description', action.description));
  const metadata = makeElement('div', 'badge-row');
  metadata.append(makeElement('span', 'risk-badge', `Risk: ${action.risk}`));
  metadata.append(makeElement('span', 'risk-badge', isStage ? 'Local only · no external effect' : (action.requiresApproval ? 'Approval required' : 'Read only')));
  card.append(metadata);

  const form = document.createElement('form');
  form.className = 'action-form';
  form.noValidate = true;
  const fieldGrid = makeElement('div', 'field-grid');
  form.append(fieldGrid);
  const properties = plainObject(action.inputSchema?.properties) ? action.inputSchema.properties : {};
  for (const [name, schema] of Object.entries(properties).slice(0, 32)) addInputField(form, name, plainObject(schema) ? schema : {});
  const footer = makeElement('div', 'action-footer');
  const prepare = makeElement('button', 'button button-primary', isStage ? 'Apply local stage' : 'Prepare exact action');
  prepare.type = 'submit';
  prepare.dataset.action = isStage ? 'apply-local-stage' : 'prepare-action';
  prepare.dataset.actionId = action.id;
  footer.append(prepare);
  form.append(footer);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!trustedEvent(event)) return;
    const response = await withButtonBusy(prepare, isStage ? 'Applying…' : 'Preparing…', () => controller.prepareAction(action.id, readArguments(form, action.inputSchema)));
     onChanged(response, response.ok === true
       ? (isStage ? 'Local stage applied; no external effect was dispatched.' : 'Exact action prepared for review.')
       : response.error?.message);
  });
  card.append(form);
  const preparedAction = controller.getPreparedActions().find((entry) => (
    entry.id ?? entry.toolName ?? entry.tool?.name ?? entry.actionId
  ) === action.id);
  if (preparedAction) card.append(renderPreparedApproval(preparedAction, controller, onChanged));
  else {
    const pendingAction = controller.getState().pendingActions.find((entry) => normalizedPreparedKey(entry) === action.id);
    if (pendingAction) card.append(renderPendingRestore(pendingAction, action, controller, onChanged));
    else if (isStage) {
      const result = controller.getActionResult(action.id);
      if (result) card.append(renderStageResult(result));
    }
  }
  return card;
}

function renderApproval(record, controller, onChanged) {
  const actionable = record.actionable === true;
  const card = makeElement('article', `item-card approval-card${actionable ? '' : ' approval-history-card'}`);
  const scope = plainObject(record.scope) ? record.scope : {};
  const heading = makeElement('div', 'item-heading');
  heading.append(makeElement('h3', 'item-title', scope.title ?? scope.name ?? scope.toolName ?? record.id));
  const contextLabel = actionable ? 'Current page' : (record.currentContext === 'same-page' ? 'Session changed' : 'History');
  heading.append(badge(contextLabel, actionable ? 'approval-context-badge' : 'risk-badge'));
  card.append(heading);
  const details = makeElement('div', 'detail-list');
  const context = record.context ?? {};
  details.append(detailRow('Status', record.state));
  details.append(detailRow('Tab', context.tabId ?? '—'));
  details.append(detailRow('Origin', context.origin ?? 'Unavailable'));
  details.append(detailRow('Session', context.sessionId ?? 'Unavailable', true));
  details.append(detailRow('Fingerprint', record.fingerprint, true));
  details.append(detailRow('Target', scope.target?.ref ?? scope.targetRef ?? 'Exact target bound in approval'));
  details.append(detailRow('Arguments', displayJson(scope.arguments ?? scope.normalizedArguments ?? {}), true));
  details.append(detailRow('Effect', scope.effect?.summary ?? scope.effectSummary ?? 'External effect bound in approval'));
  details.append(detailRow('Nonce', record.nonce, true));
  card.append(details);
  const footer = makeElement('div', 'approval-footer');
  const expiry = makeElement('span', 'approval-expiry', `Expires ${record.expiresAt ? new Date(record.expiresAt).toLocaleTimeString() : 'soon'}`);
  footer.append(expiry);
  if (record.state === 'approved' && actionable) {
    const deny = makeElement('button', 'button button-danger', 'Deny');
    deny.type = 'button';
    deny.dataset.action = 'deny-approval';
    deny.dataset.approvalId = record.id;
    deny.addEventListener('click', async (event) => {
      if (!trustedEvent(event)) return;
      const response = await withButtonBusy(deny, 'Denying…', () => controller.denyApproval(record.id, event));
      onChanged(response, response.ok === true ? 'Approval denied.' : response.error?.message);
    });
    const execute = makeElement('button', 'button button-primary', 'Dispatch approved action');
    execute.type = 'button';
    execute.dataset.action = 'dispatch-approved-action';
    execute.dataset.approvalId = record.id;
    execute.addEventListener('click', async (event) => {
      if (!trustedEvent(event)) return;
      const response = await withButtonBusy(execute, 'Dispatching…', () => controller.executeApproval(record.id, event));
      onChanged(response, response.ok === true ? 'Action dispatched; postcondition unverified.' : response.error?.message);
    });
    footer.append(deny, execute);
  } else {
    footer.append(makeElement('span', 'approval-expiry', actionable ? 'Waiting for an exact action' : 'Read-only history · no action available'));
  }
  card.append(footer);
  return card;
}

function renderMissionInspection(result) {
  const card = makeElement('article', 'item-card mission-inspection-result');
  card.dataset.missionId = result.mission.missionId;
  const heading = makeElement('div', 'item-heading');
  heading.append(makeElement('h3', 'item-title', 'Live mission inspection'));
  heading.append(badge('Verified binding', 'kind-read'));
  card.append(heading);
  const details = makeElement('div', 'detail-list');
  details.append(detailRow('Mission', `${result.mission.missionId} · ${result.mission.phase}`));
  details.append(detailRow('Target', `${result.target.ref} · tab ${result.target.tabId ?? '—'} / frame ${result.target.frameId}`));
  details.append(detailRow('Page', result.page.title));
  details.append(detailRow('Origin', result.page.origin ?? 'Unavailable'));
  details.append(detailRow('Fingerprint', result.page.pageFingerprint, true));
  if (result.page.revision !== null) details.append(detailRow('Revision', result.page.revision));
  card.append(details);
  return card;
}

function renderMission(mission, state, controller, onChanged) {
  const card = makeElement('article', 'item-card mission-card');
  card.tabIndex = -1;
  card.dataset.missionId = mission.missionId;
  card.dataset.phase = mission.phase;
  const heading = makeElement('div', 'item-heading');
  heading.append(makeElement('h3', 'item-title', mission.objective || mission.missionId));
  heading.append(badge(mission.phase, mission.phase === 'running' ? 'kind-read' : 'risk-badge'));
  card.append(heading);
  card.append(makeElement('p', 'item-description', `${mission.missionId} · ${mission.members.length} bound page${mission.members.length === 1 ? '' : 's'} · revision ${mission.revision} · ${mission.pendingActions.length} pending`));
  if (mission.invalidatedActionIds.length) {
    const invalidated = makeElement('div', 'badge-row');
    invalidated.append(makeElement('span', 'kind-badge kind-mutate', `${mission.invalidatedActionIds.length} invalidated action${mission.invalidatedActionIds.length === 1 ? '' : 's'}`));
    card.append(invalidated);
  }
  const members = makeElement('div', 'detail-list');
  for (const member of mission.members) {
    const row = makeElement('div', 'mission-member');
    const summary = makeElement('div', 'detail-list');
    const memberStatus = activeMission(mission) ? member.status : 'recorded';
    summary.append(detailRow(member.memberId, `${memberStatus} · tab ${member.tabId ?? '—'} · ${member.origin}`));
    const metadata = makeElement('div', 'badge-row');
    metadata.append(makeElement('span', 'risk-badge', `Role: ${member.role}`));
    metadata.append(makeElement('span', 'risk-badge', member.required ? 'Required' : 'Optional'));
    if (activeMission(mission) && mission.activeMemberId === member.memberId) metadata.append(makeElement('span', 'kind-badge kind-read', 'Active'));
    const pendingCount = mission.pendingActions.filter((action) => action.memberId === member.memberId).length;
    if (pendingCount) metadata.append(makeElement('span', 'kind-badge kind-mutate', `${pendingCount} pending`));
    if (member.rebindRequired) metadata.append(makeElement('span', 'kind-badge kind-mutate', 'Rebind required'));
    summary.append(metadata);
    row.append(summary);
    const actions = makeElement('div', 'member-actions');
    if (activeMission(mission) && member.status === 'attached' && mission.activeMemberId !== member.memberId) {
      const select = makeElement('button', 'button', 'Make active');
      select.type = 'button';
      select.dataset.action = 'select-mission-member';
      select.dataset.missionId = mission.missionId;
      select.dataset.memberId = member.memberId;
      select.addEventListener('click', async (event) => {
        if (!trustedEvent(event)) return;
        const response = await withButtonBusy(select, 'Selecting…', () => controller.selectMissionMember(mission.missionId, member.memberId, event));
        onChanged(response, response.ok === true ? 'Mission member selected for the next operation.' : response.error?.message);
      });
      actions.append(select);
    }
    if (activeMission(mission) && member.status === 'attached') {
       const inspect = makeElement('button', 'button', 'Inspect live');
       inspect.dataset.action = 'inspect-mission';
       inspect.dataset.missionId = mission.missionId;
       inspect.dataset.memberId = member.memberId;
      inspect.type = 'button';
      inspect.addEventListener('click', async (event) => {
        if (!trustedEvent(event)) return;
        const response = await withButtonBusy(inspect, 'Inspecting…', () => controller.routeMission(mission.missionId, member.memberId, 'read', event));
        onChanged(response, response.ok === true ? 'Live mission member inspected through its exact binding.' : response.error?.message);
      });
      actions.append(inspect);
    }
    if (activeMission(mission) && (member.status === 'awaiting-rebind' || member.status === 'invalidated')) {
      const rebind = makeElement('button', 'button', 'Rebind current tab');
      rebind.type = 'button';
      rebind.dataset.action = 'rebind-mission-member';
      rebind.dataset.missionId = mission.missionId;
      rebind.dataset.memberId = member.memberId;
      rebind.addEventListener('click', async (event) => {
        if (!trustedEvent(event)) return;
        const response = await withButtonBusy(rebind, 'Rebinding…', () => controller.rebindMission(mission.missionId, member.memberId, event));
        onChanged(response, response.ok === true ? 'Mission member rebound to the live page.' : response.error?.message);
      });
      actions.append(rebind);
    }
    if (activeMission(mission) && member.status !== 'detached') {
      const detach = makeElement('button', 'button button-danger', 'Detach');
      detach.type = 'button';
      detach.dataset.action = 'detach-mission-member';
      detach.dataset.missionId = mission.missionId;
      detach.dataset.memberId = member.memberId;
      detach.addEventListener('click', async (event) => {
        if (!trustedEvent(event)) return;
        const response = await withButtonBusy(detach, 'Detaching…', () => controller.detachMissionMember(mission.missionId, member.memberId, event));
        onChanged(response, response.ok === true ? 'Mission member detached.' : response.error?.message);
      });
      actions.append(detach);
    }
    if (actions.childElementCount) row.append(actions);
    members.append(row);
  }
  if (mission.members.length === 0) members.append(emptyMessage('No pages are attached to this mission.'));
  card.append(members);
  const currentBound = state.missions.some((entry) => activeMission(entry) && entry.members.some((member) => (
    member.tabId === state.tab.id && member.frameId === 0 && member.status !== 'detached'
  )));
  if (activeMission(mission) && Number.isInteger(state.tab.id) && !currentBound) {
    const footer = makeElement('div', 'mission-footer');
    const attach = makeElement('button', 'button button-primary', 'Attach current tab');
    attach.type = 'button';
    attach.dataset.action = 'attach-mission-member';
    attach.dataset.missionId = mission.missionId;
    attach.addEventListener('click', async (event) => {
      if (!trustedEvent(event)) return;
      const response = await withButtonBusy(attach, 'Attaching…', () => controller.attachMission(mission.missionId, event));
      onChanged(response, response.ok === true ? 'Current tab attached to the mission.' : response.error?.message);
    });
    footer.append(attach);
    card.append(footer);
  }
  if (mission.phase === 'running') {
    const phaseActions = makeElement('div', 'mission-phase-actions');
    const cancel = makeElement('button', 'button button-danger', 'Cancel mission');
    cancel.type = 'button';
    cancel.dataset.action = 'cancel-mission';
    cancel.dataset.missionId = mission.missionId;
    cancel.addEventListener('click', async (event) => {
      if (!trustedEvent(event)) return;
      const confirmed = typeof globalThis.confirm === 'function'
        ? globalThis.confirm('Cancel this mission? Pending actions will be cleared.')
        : true;
      if (!confirmed) return;
      const response = await withButtonBusy(cancel, 'Cancelling…', () => controller.setMissionPhase(mission.missionId, 'cancelled', event));
      onChanged(response, response.ok === true ? 'Mission cancelled and pending actions cleared.' : response.error?.message);
    });
    const complete = makeElement('button', 'button button-primary', 'Complete mission');
    complete.type = 'button';
    complete.dataset.action = 'complete-mission';
    complete.dataset.missionId = mission.missionId;
    complete.addEventListener('click', async (event) => {
      if (!trustedEvent(event)) return;
      const response = await withButtonBusy(complete, 'Completing…', () => controller.setMissionPhase(mission.missionId, 'completed', event));
      onChanged(response, response.ok === true ? 'Mission completed with its audit trail preserved.' : response.error?.message);
    });
    phaseActions.append(cancel, complete);
    card.append(phaseActions);
  }
  return card;
}

function renderHandoffRequest(state, controller, onChanged) {
  const candidates = state.missions.filter(activeMission).flatMap((mission) => mission.members
    .filter((member) => member.status === 'attached')
    .map((member) => ({ mission, member })));
  if (!candidates.length) return null;
  const form = document.createElement('form');
  form.className = 'handoff-request-form';
  form.noValidate = true;
  const heading = makeElement('div', 'item-heading');
  heading.append(makeElement('h3', 'item-title', 'Request a human-only step'));
  heading.append(badge('Credentials stay on site', 'kind-read'));
  form.append(heading);
  const grid = makeElement('div', 'handoff-request-grid');
  const targetLabel = makeElement('label', 'field-label', 'Mission page');
  const target = document.createElement('select');
  target.name = 'handoffTarget';
  for (const [index, candidate] of candidates.entries()) {
    const option = document.createElement('option');
    option.value = String(index);
    option.textContent = `${candidate.mission.missionId} · ${candidate.member.role} · tab ${candidate.member.tabId ?? '—'}`;
    if (candidate.mission.activeMemberId === candidate.member.memberId) option.selected = true;
    target.append(option);
  }
  targetLabel.append(target);
  const typeLabel = makeElement('label', 'field-label', 'Step type');
  const type = document.createElement('select');
  type.name = 'handoffType';
  for (const [value, label] of [['login', 'Login'], ['2fa', 'Two-factor authentication'], ['captcha', 'CAPTCHA']]) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    type.append(option);
  }
  typeLabel.append(type);
  grid.append(targetLabel, typeLabel);
  form.append(grid);
  const purposeLabel = makeElement('label', 'field-label', 'Why your input is needed');
  const purpose = document.createElement('input');
  purpose.type = 'text';
  purpose.name = 'purpose';
  purpose.required = true;
  purpose.maxLength = 512;
  purpose.value = 'Sign in so the mission can continue.';
  purposeLabel.append(purpose);
  form.append(purposeLabel);
  type.addEventListener('change', () => {
    const defaults = {
      login: 'Sign in so the mission can continue.',
      '2fa': 'Complete two-factor authentication so the mission can continue.',
      captcha: 'Complete the CAPTCHA challenge so the mission can continue.',
    };
    purpose.value = defaults[type.value] ?? defaults.login;
  });
  const footer = makeElement('div', 'action-footer');
  const request = makeElement('button', 'button button-primary', 'Request human step');
  request.type = 'submit';
  request.dataset.action = 'request-human-step';
  footer.append(request);
  form.append(footer);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!trustedEvent(event)) return;
    const selected = candidates[Number(target.value)];
    if (!selected) return;
    const response = await withButtonBusy(request, 'Requesting…', () => controller.requestHandoff({
      missionId: selected.mission.missionId,
      memberId: selected.member.memberId,
      type: type.value,
      purpose: purpose.value,
    }, event));
    onChanged(response, response.ok === true ? 'Human-only step requested with exact mission binding.' : response.error?.message);
  });
  return form;
}

function renderHandoff(handoff, controller, onChanged) {
  const card = makeElement('article', 'item-card approval-card');
  const heading = makeElement('div', 'item-heading');
  heading.append(makeElement('h3', 'item-title', handoff.type));
  heading.append(badge(handoff.state, handoff.state === 'human-active' ? 'kind-mutate' : 'risk-badge'));
  card.append(heading);
  card.append(makeElement('p', 'item-description', handoff.purpose));
  const details = makeElement('div', 'detail-list');
  details.append(detailRow('Origin', handoff.safeOrigin ?? 'Unavailable'));
  details.append(detailRow('Mission', handoff.missionId, true));
  details.append(detailRow('Member', handoff.memberId, true));
  if (handoff.expiresAt) details.append(detailRow('Expires', new Date(handoff.expiresAt).toLocaleTimeString()));
  if (handoff.type === 'captcha') details.append(detailRow('Checkbox attempts', `${handoff.captchaCheckboxAttempts} / 1`));
  card.append(details);
  const footer = makeElement('div', 'approval-footer');
  if (handoff.state === 'awaiting-ui-gesture') {
    const open = makeElement('button', 'button button-primary', 'Open human window');
    open.type = 'button';
    open.dataset.action = 'open-human-window';
    open.dataset.handoffId = handoff.handoffId;
    open.addEventListener('click', async (event) => {
      if (!trustedEvent(event)) return;
      const response = await withButtonBusy(open, 'Opening…', () => controller.openHandoff(handoff.handoffId, event));
      onChanged(response, response.ok === true ? 'Human-only window opened.' : response.error?.message);
    });
    footer.append(open);
  }
  if (handoff.state === 'human-active') {
    if (handoff.type === 'captcha' && handoff.captchaCheckboxAttempts === 0) {
      const attempt = makeElement('button', 'button', 'Try checkbox once');
      attempt.type = 'button';
      attempt.dataset.action = 'attempt-captcha-checkbox';
      attempt.dataset.handoffId = handoff.handoffId;
      attempt.title = 'Experimental: one bounded checkbox attempt. If the site refuses, you remain in control.';
      attempt.addEventListener('click', async (event) => {
        if (!trustedEvent(event)) return;
        const response = await withButtonBusy(attempt, 'Attempting…', () => controller.attemptCaptcha(handoff.handoffId, event));
        onChanged(response, response.ok === true
          ? 'One bounded CAPTCHA checkbox click was dispatched. Finish it manually if the site rejects automation.'
          : response.error?.message);
      });
      footer.append(attempt);
    }
    const complete = makeElement('button', 'button button-primary', 'Done — validate & resume');
    complete.type = 'button';
    complete.dataset.action = 'complete-human-step';
    complete.dataset.handoffId = handoff.handoffId;
    complete.addEventListener('click', async (event) => {
      if (!trustedEvent(event)) return;
      const response = await withButtonBusy(complete, 'Validating…', () => controller.completeHandoff(handoff.handoffId, event));
      onChanged(response, response.ok === true ? 'Human step completed; mission can resume.' : response.error?.message);
    });
    footer.append(complete);
  }
  card.append(footer);
  return card;
}

function unitInterval(value, fallback = 0) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(0, Math.min(1, numeric));
}

function renderEvidenceVisualizer(entry) {
  if (!entry.segments.length && !entry.regions.length && !entry.keyframes.length) return null;
  const visualizer = makeElement('div', 'evidence-visualizer');
  if (entry.segments.length) {
    visualizer.append(makeElement('h4', '', 'Signal timeline'));
    const timeline = makeElement('div', 'evidence-timeline');
    const segments = entry.segments.slice(0, 12).filter((segment) => plainObject(segment));
    const duration = Math.max(1, ...segments.map((segment) => Number(segment.end ?? segment.stop ?? segment.timestamp ?? 0)).filter(Number.isFinite));
    if (!segments.length) {
      timeline.append(makeElement('span', 'evidence-timeline-segment', ''));
      timeline.firstElementChild.dataset.empty = 'true';
    } else {
      for (const segment of segments) {
        const start = Math.max(0, Math.min(duration, Number(segment.start ?? segment.begin ?? segment.timestamp ?? 0) || 0));
        const end = Math.max(start, Math.min(duration, Number(segment.end ?? segment.stop ?? start) || start));
        const startColumn = Math.min(11, Math.floor((start / duration) * 12));
        const span = Math.max(1, Math.min(12 - startColumn, Math.ceil(((end - start) / duration) * 12) || 1));
        const marker = makeElement('span', 'evidence-timeline-segment');
        marker.style.gridColumn = `${startColumn + 1} / span ${span}`;
        marker.title = boundedText(segment.text ?? segment.label ?? 'Evidence segment', 'Evidence segment', 120);
        marker.setAttribute('aria-label', marker.title);
        timeline.append(marker);
      }
    }
    visualizer.append(timeline);
    const labels = makeElement('div', 'evidence-time-labels');
    labels.append(makeElement('span', '', '0:00'), makeElement('span', '', `${Math.round(duration)}s`));
    visualizer.append(labels);
  }
  if (entry.regions.length) {
    visualizer.append(makeElement('h4', '', 'Detected regions'));
    const map = makeElement('div', 'region-map');
    map.setAttribute('role', 'img');
    map.setAttribute('aria-label', `${entry.regions.length} normalized evidence regions`);
    for (const region of entry.regions.slice(0, 16).filter((value) => plainObject(value))) {
      const marker = makeElement('span', 'region-marker');
      const x = unitInterval(region.x ?? region.left);
      const y = unitInterval(region.y ?? region.top);
      const width = Math.max(0.02, Math.min(unitInterval(region.width, .08), 1 - x));
      const height = Math.max(0.02, Math.min(unitInterval(region.height, .08), 1 - y));
      marker.style.left = `${Math.min(x, 1 - width) * 100}%`;
      marker.style.top = `${Math.min(y, 1 - height) * 100}%`;
      marker.style.width = `${width * 100}%`;
      marker.style.height = `${height * 100}%`;
      const label = boundedText(region.label ?? region.name ?? region.role, 'region', 80);
      marker.title = label;
      marker.append(makeElement('span', '', label));
      map.append(marker);
    }
    visualizer.append(map);
  }
  if (entry.keyframes.length) {
    visualizer.append(makeElement('h4', '', 'Keyframe beats'));
    const strip = makeElement('div', 'keyframe-strip');
    for (const keyframe of entry.keyframes.slice(0, 12).filter((value) => plainObject(value))) {
      const chip = makeElement('div', 'keyframe-chip');
      const timestamp = Number(keyframe.timestamp ?? keyframe.time ?? keyframe.at);
      chip.append(makeElement('strong', '', Number.isFinite(timestamp) ? `${timestamp.toFixed(1)}s` : 'frame'));
      chip.append(makeElement('span', '', keyframe.summary ?? keyframe.label ?? 'Keyframe evidence'));
      strip.append(chip);
    }
    visualizer.append(strip);
  }
  return visualizer;
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
  if (entry.language) metadata.append(makeElement('span', 'risk-badge', `Language: ${entry.language}`));
  if (entry.model) metadata.append(makeElement('span', 'risk-badge', entry.model));
  if (entry.untrustedContent) metadata.append(makeElement('span', 'risk-badge', 'Untrusted content'));
  card.append(metadata);
  const visualizer = renderEvidenceVisualizer(entry);
  if (visualizer) card.append(visualizer);
  const rich = {};
  if (entry.transcript) rich.transcript = entry.transcript;
  if (entry.labels.length) rich.labels = entry.labels;
  if (entry.segments.length) rich.segments = entry.segments;
  if (entry.regions.length) rich.regions = entry.regions;
  if (entry.keyframes.length) rich.keyframes = entry.keyframes;
  if (entry.warnings.length) rich.warnings = entry.warnings;
  if (Object.keys(rich).length) {
    const details = makeElement('details', 'evidence-details');
    details.append(makeElement('summary', '', 'Transcript, regions & timing'));
    const content = makeElement('pre', 'evidence-detail-content');
    content.textContent = displayJson(rich);
    details.append(content);
    card.append(details);
  }
  return card;
}

function renderReceipt(record) {
  const card = makeElement('article', 'item-card receipt-card');
  const heading = makeElement('div', 'item-heading');
  heading.append(makeElement('h3', 'item-title', record.operation));
  const statusClass = record.status === 'verified-success'
    ? 'kind-read'
    : (record.status === 'verified-failure' ? 'kind-mutate' : 'risk-badge');
  heading.append(badge(record.status, statusClass));
  card.append(heading);
  const details = makeElement('div', 'detail-list');
  details.append(detailRow('Target', record.target));
  details.append(detailRow('Action', record.actionId, true));
  details.append(detailRow('Events', record.events.join(', ') || 'Dispatched'));
  const outcomeLabel = record.outcome === 'verified-success'
    ? 'Verified success'
    : (record.outcome === 'verified-failure'
      ? 'Verified failure'
      : (record.outcome === 'unknown' ? 'Unknown after dispatch' : 'Postcondition unverified'));
  details.append(detailRow('Outcome', outcomeLabel));
  if (record.approvalFingerprint) details.append(detailRow('Approval', record.approvalFingerprint, true));
  card.append(details);
  const proof = record.verification;
  if (proof.status || proof.reasonCode || proof.beforePageFingerprint || proof.afterPageFingerprint || proof.contractId) {
    const verification = makeElement('details', 'structured-result');
    verification.append(makeElement('summary', '', 'Verification proof'));
    const proofDetails = makeElement('div', 'detail-list read-provenance');
    if (proof.status) proofDetails.append(detailRow('Verdict', proof.status));
    if (proof.reasonCode) proofDetails.append(detailRow('Reason', proof.reasonCode, true));
    if (proof.contractId) proofDetails.append(detailRow('Contract', proof.contractId, true));
    if (proof.adapterId) proofDetails.append(detailRow('Adapter', `${proof.adapterId}${proof.adapterVersion ? ` · ${proof.adapterVersion}` : ''}`));
    if (proof.beforePageFingerprint) proofDetails.append(detailRow('Before', proof.beforePageFingerprint, true));
    if (proof.afterPageFingerprint) proofDetails.append(detailRow('After', proof.afterPageFingerprint, true));
    if (proof.checkedAt) proofDetails.append(detailRow('Checked', new Date(proof.checkedAt).toLocaleString()));
    verification.append(proofDetails);
    if (Array.isArray(proof.evidence) && proof.evidence.length) {
      const evidence = makeElement('pre');
      evidence.textContent = displayJson(proof.evidence);
      verification.append(evidence);
    }
    card.append(verification);
  }
  return card;
}

function renderAuditEntry(entry) {
  const row = makeElement('div', 'audit-row');
  row.append(makeElement('span', 'audit-sequence', `#${entry.sequence}`));
  row.append(makeElement('span', 'audit-event', entry.event));
  row.append(makeElement('code', 'audit-hash', entry.hash));
  if (entry.timestamp) row.append(makeElement('time', 'audit-time', new Date(entry.timestamp).toLocaleString()));
  return row;
}

function renderCapabilityPack(pack) {
  const card = makeElement('article', 'item-card compact-card');
  const heading = makeElement('div', 'item-heading');
  heading.append(makeElement('h3', 'item-title', pack.id));
  heading.append(badge(pack.status, pack.status === 'active' ? 'kind-read' : 'risk-badge'));
  card.append(heading);
  const details = [`v${pack.version}`];
  if (pack.toolCount !== null) details.push(`${pack.toolCount} tool${pack.toolCount === 1 ? '' : 's'}`);
  if (pack.maxTools !== null) details.push(`max ${pack.maxTools}`);
  if (pack.objectiveScore !== null) details.push(`score ${pack.objectiveScore.toFixed(2)}`);
  card.append(makeElement('p', 'item-description', details.join(' · ')));
  return card;
}

function renderQuarantine(entry) {
  const card = makeElement('article', 'item-card compact-card approval-card');
  const heading = makeElement('div', 'item-heading');
  heading.append(makeElement('h3', 'item-title', entry.name));
  heading.append(badge('Quarantined', 'kind-mutate'));
  card.append(heading);
  card.append(makeElement('p', 'item-description', entry.reason));
  const metadata = makeElement('div', 'badge-row');
  metadata.append(makeElement('span', 'risk-badge', entry.source));
  if (entry.stage) metadata.append(makeElement('span', 'risk-badge', `Stage: ${entry.stage}`));
  if (entry.packId) metadata.append(makeElement('span', 'risk-badge', `${entry.packId}${entry.version ? ` · ${entry.version}` : ''}`));
  if (entry.winningName) metadata.append(makeElement('span', 'risk-badge', `Winner: ${entry.winningName}`));
  card.append(metadata);
  return card;
}

function workflowFor(state) {
  if (state.connection !== 'ready') return { now: 'Bridge unavailable', next: 'Reconnect to the active page', required: 'Open an HTTP(S) tab, then refresh' };
  const invalidated = state.missions.some((mission) => mission.members.some((member) => member.status === 'invalidated' || member.status === 'awaiting-rebind'));
  if (invalidated) return { now: 'Mission paused by page drift', next: 'Rebind the affected member', required: 'Activate the correct tab' };
  const human = state.handoffs.find((handoff) => !['completed', 'failed', 'expired'].includes(handoff.state));
  if (human) return { now: `${human.type.toUpperCase()} handoff waiting`, next: human.state === 'human-active' ? 'Validate and resume' : 'Open the secure window', required: 'Complete the step on the site' };
  const actionableApprovals = state.approvals.filter((approval) => approval.actionable === true);
  if (actionableApprovals.length) return { now: 'Exact approval waiting', next: 'Review target, arguments and effect', required: 'Approve or deny' };
  if (state.pendingActions.length || state.missions.some((mission) => mission.pendingActions.length)) return { now: 'Action prepared', next: 'Review its exact scope', required: 'Approve or deny' };
  if (!state.missions.length) return { now: 'Page context connected', next: 'Start a bound mission', required: 'Start on this page' };
  if (state.tools.some((tool) => tool.classification === 'read')) return { now: 'Mission ready', next: 'Run a safe read or prepare an action', required: 'Nothing until an effect needs approval' };
  return { now: 'Mission active', next: 'Wait for live tools', required: 'Nothing yet' };
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
  browser = globalThis.chrome,
  windowRef = globalThis.window,
  wait = (delayMs) => new Promise((resolve) => globalThis.setTimeout(resolve, delayMs)),
} = {}) {
  if (!documentRef) return null;
  const appController = controller ?? createUiController();
  const refs = {
    connection: documentRef.getElementById('connection-badge'),
    refresh: documentRef.getElementById('refresh-button'),
    workflowNow: documentRef.getElementById('workflow-now'),
    workflowNext: documentRef.getElementById('workflow-next'),
    workflowRequired: documentRef.getElementById('workflow-required'),
    mode: documentRef.getElementById('page-mode'),
    origin: documentRef.getElementById('page-origin'),
    title: documentRef.getElementById('page-title'),
    tab: documentRef.getElementById('tab-value'),
    fingerprint: documentRef.getElementById('fingerprint-value'),
    missionsCount: documentRef.getElementById('missions-count'),
    missions: documentRef.getElementById('missions-list'),
    missionObjective: documentRef.getElementById('mission-objective'),
    missionStart: documentRef.getElementById('mission-start'),
    missionInspectResult: documentRef.getElementById('mission-inspect-result'),
    missionNote: documentRef.getElementById('mission-note'),
    handoffsCount: documentRef.getElementById('handoffs-count'),
    handoffs: documentRef.getElementById('handoffs-list'),
    handoffRequest: documentRef.getElementById('handoff-request'),
    handoffNote: documentRef.getElementById('handoff-note'),
    toolsCount: documentRef.getElementById('tools-count'),
    tools: documentRef.getElementById('tools-list'),
    packsSelected: documentRef.getElementById('packs-selected'),
    packsActive: documentRef.getElementById('packs-active'),
    packsBudget: documentRef.getElementById('packs-budget'),
    packs: documentRef.getElementById('packs-list'),
    quarantineList: documentRef.getElementById('quarantine-list'),
    actionsCount: documentRef.getElementById('actions-count'),
    actions: documentRef.getElementById('actions-list'),
    evidenceCount: documentRef.getElementById('evidence-count'),
    evidenceStats: documentRef.getElementById('evidence-stats'),
    evidenceWarnings: documentRef.getElementById('evidence-warnings'),
    evidence: documentRef.getElementById('evidence-list'),
    evidenceAnalyze: documentRef.getElementById('evidence-analyze'),
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
    approvalsCurrentCount: documentRef.getElementById('approvals-current-count'),
    approvals: documentRef.getElementById('approvals-list'),
    approvalsHistoryCount: documentRef.getElementById('approvals-history-count'),
    approvalsHistory: documentRef.getElementById('approvals-history-list'),
    receiptsCount: documentRef.getElementById('receipts-count'),
    receipts: documentRef.getElementById('receipts-list'),
    auditBadge: documentRef.getElementById('audit-badge'),
    auditHead: documentRef.getElementById('audit-head'),
    audit: documentRef.getElementById('audit-list'),
    auditMore: documentRef.getElementById('audit-more'),
    quarantine: documentRef.getElementById('quarantine-count'),
    announcer: documentRef.getElementById('sidepanel-announcer'),
    toast: documentRef.getElementById('toast'),
  };
  let toastTimer = null;
  let lastAnnouncement = '';
  let showAllAudit = false;

  function focusedControlIdentity() {
    const element = documentRef.activeElement;
    if (!element?.dataset?.action) return null;
    return Object.fromEntries(['action', 'missionId', 'memberId', 'actionId', 'approvalId', 'handoffId', 'toolId']
      .map((key) => [key, element.dataset[key]])
      .filter(([, value]) => value));
  }

  function restoreFocusedControl(identity) {
    if (!identity) return;
    globalThis.setTimeout(() => {
      const candidates = [...documentRef.querySelectorAll('[data-action]')];
      const exact = candidates.find((candidate) => Object.entries(identity)
        .every(([key, value]) => candidate.dataset[key] === value));
      if (exact && !exact.disabled) {
        exact.focus({ preventScroll: true });
        return;
      }
      if (identity.missionId) {
        const missionCard = [...documentRef.querySelectorAll('[data-mission-id]')]
          .find((candidate) => candidate.dataset.missionId === identity.missionId);
        missionCard?.focus({ preventScroll: true });
      }
    }, 0);
  }

  function toast(message, isError = false) {
    if (!refs.toast) return;
    clearTimeout(toastTimer);
    refs.toast.textContent = boundedText(message, '', 320);
    refs.toast.className = `toast toast-visible${isError ? ' toast-error' : ''}`;
    toastTimer = setTimeout(() => { refs.toast.className = 'toast'; }, 3600);
  }

  function render(state) {
    if (!state) return;
    const focusIdentity = focusedControlIdentity();
    const workflow = workflowFor(state);
    if (refs.workflowNow) refs.workflowNow.textContent = workflow.now;
    if (refs.workflowNext) refs.workflowNext.textContent = workflow.next;
    if (refs.workflowRequired) refs.workflowRequired.textContent = workflow.required;
    if (refs.connection) {
      refs.connection.textContent = state.connection === 'ready' ? 'Connected' : 'Bridge unavailable';
      refs.connection.className = `status-badge ${state.connection === 'ready' ? 'status-ready' : 'status-error'}`;
    }
    if (refs.mode) refs.mode.textContent = boundedText(state.mode, 'Waiting', 64);
    if (refs.origin) refs.origin.textContent = boundedText(state.tab.origin, 'No active HTTP(S) page', 256);
    if (refs.title) refs.title.textContent = boundedText(state.tab.title, 'Activate ToolBraid on a tab to inspect its live context.', 240);
    if (refs.tab) refs.tab.textContent = state.tab.id === null ? '—' : String(state.tab.id);
    if (refs.fingerprint) refs.fingerprint.textContent = boundedText(state.snapshot.fingerprint, '—', 128);
    if (refs.missionStart) refs.missionStart.disabled = state.tab.id === null || state.missions.some((mission) => (
      activeMission(mission) && mission.members.some((member) => member.tabId === state.tab.id && member.frameId === 0 && member.status !== 'detached')
    ));
    if (refs.toolsCount) refs.toolsCount.textContent = String(state.tools.length);
    if (refs.packsSelected) refs.packsSelected.textContent = String(state.capabilityPacks.selected.length);
    if (refs.packsActive) refs.packsActive.textContent = String(state.capabilityPacks.active.length);
    if (refs.packsBudget) refs.packsBudget.textContent = `${state.capabilityPacks.budget.usedTools} / ${state.capabilityPacks.budget.maxActiveTools}`;
    if (refs.missionsCount) refs.missionsCount.textContent = String(state.missions.length);
    if (refs.handoffsCount) refs.handoffsCount.textContent = String(state.handoffs.length);
    if (refs.actionsCount) refs.actionsCount.textContent = String(state.actions.length);
    if (refs.approvalsCount) refs.approvalsCount.textContent = String(state.approvals.length);
    const actionableApprovals = state.approvals.filter((approval) => approval.actionable === true);
    const historicalApprovals = state.approvals.filter((approval) => approval.actionable !== true);
    if (refs.approvalsCurrentCount) refs.approvalsCurrentCount.textContent = `${actionableApprovals.length} actionable`;
    if (refs.approvalsHistoryCount) refs.approvalsHistoryCount.textContent = `${historicalApprovals.length} record${historicalApprovals.length === 1 ? '' : 's'}`;
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
    if (refs.announcer && state.connection === 'ready') {
      const announcement = `Updated: ${workflow.now}. ${state.missions.length} missions, ${state.handoffs.length} human steps, ${state.tools.length} tools, ${state.actions.length} actions, ${state.approvals.length} approvals, ${state.evidence.stats.total} evidence items, ${state.receipts.length} receipts.`;
      if (announcement !== lastAnnouncement) {
        refs.announcer.textContent = announcement;
        lastAnnouncement = announcement;
      }
    }
    if (refs.missionNote) refs.missionNote.textContent = state.missionError || 'Each mission keeps exact tab, frame, session, origin, and page-fingerprint ownership.';
    if (refs.handoffNote) refs.handoffNote.textContent = state.handoffError || 'Credentials stay inside the approved site. ToolBraid stores no password, one-time code, or raw login URL.';
    if (refs.missions) renderList(refs.missions, state.missions, (mission) => renderMission(mission, state, appController, (response, message) => {
      toast(message ?? 'Mission update failed.', response?.ok !== true);
      if (response?.ok === true) void appController.refresh().then(render);
    }), 'No active mission. Start one from the current page.');
    if (refs.missionInspectResult) {
      const inspections = appController.getMissionInspections();
      refs.missionInspectResult.replaceChildren(...inspections.map(renderMissionInspection));
    }
    if (refs.handoffs) renderList(refs.handoffs, state.handoffs, (handoff) => renderHandoff(handoff, appController, (response, message) => {
      toast(message ?? 'Human handoff update failed.', response?.ok !== true);
      if (response?.ok === true) void appController.refresh().then(render);
    }), 'No human-only step is waiting.');
    if (refs.handoffRequest) {
      refs.handoffRequest.replaceChildren();
      const composer = renderHandoffRequest(state, appController, (response, message) => {
        toast(message ?? 'Human handoff request failed.', response?.ok !== true);
        if (response?.ok === true) void appController.refresh().then(render);
      });
      if (composer) refs.handoffRequest.append(composer);
    }
    if (refs.packs) renderList(refs.packs, state.capabilityPacks.active.length ? state.capabilityPacks.active : state.capabilityPacks.selected, renderCapabilityPack, 'No trusted capability pack matched this page.');
    if (refs.quarantineList) renderList(refs.quarantineList, [...state.quarantined, ...state.capabilityPacks.quarantined], renderQuarantine, 'No quarantined descriptors or capability packs.');
    if (refs.tools) renderList(refs.tools, state.tools, (tool) => renderTool(tool, appController, (response, message) => {
      toast(message ?? 'Read failed.', response?.ok !== true);
      render(appController.getState());
    }), 'No tools discovered yet.');
    if (refs.actions) renderList(refs.actions, state.actions, (action) => renderAction(action, appController, (response, message) => {
      toast(message ?? 'Action update failed.', response?.ok !== true);
      if (response?.ok === true) void appController.refresh().then(render);
      else render(appController.getState());
    }), 'No page actions discovered yet.');
    if (refs.approvals) renderList(refs.approvals, actionableApprovals, (approval) => renderApproval(approval, appController, (response, message) => {
      toast(message ?? 'Approval update failed.', response?.ok !== true);
      if (response?.ok === true) void appController.refresh().then(render);
    }), 'No approval is actionable on this page.');
    if (refs.approvalsHistory) renderList(refs.approvalsHistory, historicalApprovals, (approval) => renderApproval(approval, appController, (response, message) => {
      toast(message ?? 'Approval update failed.', response?.ok !== true);
      if (response?.ok === true) void appController.refresh().then(render);
    }), 'No approval history.');
    if (refs.evidence) renderList(refs.evidence, state.evidence.items, renderEvidence, 'No visual, audio, or video evidence on this page.');
    if (refs.receipts) renderList(refs.receipts, state.receipts, renderReceipt, 'No action has been dispatched.');
    if (refs.audit) {
      const auditEntries = showAllAudit ? state.audit.entries : state.audit.entries.slice(-12);
      renderList(refs.audit, auditEntries, renderAuditEntry, 'Audit entries appear after activation.');
      if (refs.auditMore) {
        refs.auditMore.hidden = state.audit.entries.length <= 12;
        refs.auditMore.textContent = showAllAudit ? 'Show latest 12 events' : `Show all recent events (${state.audit.entries.length})`;
      }
    }
    restoreFocusedControl(focusIdentity);
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
    void withButtonBusy(refs.refresh, '…', refresh);
  });
  refs.missionStart?.addEventListener('click', async (event) => {
    if (!trustedEvent(event)) return;
    const objective = boundedText(refs.missionObjective?.value, MISSION_OBJECTIVE_FALLBACK, MAX_MISSION_OBJECTIVE);
    if (refs.missionObjective) refs.missionObjective.value = objective;
    const response = await withButtonBusy(refs.missionStart, 'Starting…', () => appController.startMission(event, objective));
    toast(response.ok === true ? 'Mission started on the current page.' : response.error?.message, response.ok !== true);
    if (response.ok === true) render(await appController.refresh());
  });
  refs.auditMore?.addEventListener('click', (event) => {
    if (!trustedEvent(event)) return;
    showAllAudit = !showAllAudit;
    render(appController.getState());
  });
  refs.evidenceAnalyze?.addEventListener('click', async (event) => {
    if (!trustedEvent(event)) return;
    const response = await withButtonBusy(refs.evidenceAnalyze, 'Analyzing…', () => appController.analyzeMultimodal(event));
    toast(response.ok === true ? 'Current page evidence analyzed again.' : response.error?.message, response.ok !== true);
    if (response.ok === true) render(appController.getState());
  });
  refs.providerForm?.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!trustedEvent(event)) return;
    const response = await withButtonBusy(refs.providerSave, 'Saving…', () => appController.configureMultimodal({
      baseUrl: refs.providerEndpoint?.value ?? '',
      visionModel: refs.providerVisionModel?.value ?? '',
      audioModel: refs.providerAudioModel?.value ?? '',
      apiKey: refs.providerApiKey?.value ?? '',
    }, event));
    if (refs.providerApiKey) refs.providerApiKey.value = '';
    toast(response.ok === true ? 'Multimodal provider enabled and page reanalyzed.' : response.error?.message, response.ok !== true);
    if (response.ok === true) render(appController.getState());
  });
  refs.providerDisable?.addEventListener('click', async (event) => {
    if (!trustedEvent(event)) return;
    const response = await withButtonBusy(refs.providerDisable, 'Disabling…', () => appController.disableMultimodal(event));
    toast(response.ok === true ? 'Multimodal provider disabled.' : response.error?.message, response.ok !== true);
    if (response.ok === true) render(appController.getState());
  });

  let liveRefreshTimer = null;
  let destroyed = false;
  const removers = [];
  const scheduleLiveRefresh = () => {
    if (destroyed || documentRef.visibilityState === 'hidden') return;
    clearTimeout(liveRefreshTimer);
    liveRefreshTimer = globalThis.setTimeout(() => {
      liveRefreshTimer = null;
      void refresh();
    }, 90);
  };
  const listenChrome = (eventTarget, listener) => {
    if (!eventTarget?.addListener) return;
    eventTarget.addListener(listener);
    removers.push(() => eventTarget.removeListener?.(listener));
  };
  listenChrome(browser?.tabs?.onActivated, scheduleLiveRefresh);
  listenChrome(browser?.tabs?.onUpdated, (_tabId, changeInfo) => {
    if (changeInfo?.status || changeInfo?.url || changeInfo?.title) scheduleLiveRefresh();
  });
  listenChrome(browser?.tabs?.onRemoved, scheduleLiveRefresh);
  listenChrome(browser?.runtime?.onMessage, (message) => {
    const type = typeof message?.type === 'string' ? message.type : '';
    if (type.includes('PAGE_') || type.includes('MISSION') || type.includes('HANDOFF') || type.includes('TOOLBRAID')) scheduleLiveRefresh();
  });
  const onVisibilityChange = () => {
    if (documentRef.visibilityState !== 'hidden') scheduleLiveRefresh();
  };
  const onFocus = () => scheduleLiveRefresh();
  documentRef.addEventListener?.('visibilitychange', onVisibilityChange);
  windowRef?.addEventListener?.('focus', onFocus);
  removers.push(() => documentRef.removeEventListener?.('visibilitychange', onVisibilityChange));
  removers.push(() => windowRef?.removeEventListener?.('focus', onFocus));

  function destroy() {
    destroyed = true;
    clearTimeout(liveRefreshTimer);
    for (const remove of removers) remove();
  }
  void initialRefresh();
  return Object.freeze({ controller: appController, refresh, initialRefresh, render, destroy });
}

if (globalThis.document?.getElementById) createSidepanelApp();

export { ApprovalStoreError, INITIAL_REFRESH_DELAYS_MS, boundedText, normalizeState, trustedEvent };
