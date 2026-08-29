import {
  assertPreparedActionCurrent,
  createPageSnapshot,
  generateWebMcpToolDescriptors,
  prepareAction,
} from '../universal/index.js';
import { assessToolSecurity } from '../engine/risk.js';
import { createApprovalEnvelope } from '../engine/approval.js';

const MAX_REGISTERED_TOOLS = 128;
const MAX_SESSION_RECEIPTS = 256;
const MAX_RECEIPT_EVENTS = 16;

export class UniversalSessionError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'UniversalSessionError';
    this.code = code;
    this.details = details;
  }
}

function sessionError(code, message, details = {}) {
  return new UniversalSessionError(code, message, details);
}

function sessionKey(tabId, frameId) {
  if (!Number.isInteger(tabId) || tabId < 0) throw new TypeError('tabId must be a non-negative integer.');
  if (!Number.isInteger(frameId) || frameId < 0) throw new TypeError('frameId must be a non-negative integer.');
  return `${tabId}:${frameId}`;
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function plainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function boundedString(value, maxLength = 256) {
  if (typeof value !== 'string') return null;
  const result = value.trim();
  return result ? result.slice(0, maxLength) : null;
}

function redactedTarget(value) {
  if (!plainObject(value)) return null;
  return Object.fromEntries(['ref', 'role', 'name', 'formRef', 'type']
    .map((key) => [key, boundedString(value[key], 256)])
    .filter(([, entry]) => entry !== null));
}

function redactedChanged(value) {
  if (!plainObject(value)) return null;
  const changed = {};
  for (const key of ['operation', 'property']) {
    const entry = boundedString(value[key], 64);
    if (entry !== null) changed[key] = entry;
  }
  if (typeof value.submit === 'boolean') changed.submit = value.submit;
  if (typeof value.applied === 'boolean') changed.applied = value.applied;
  if (Object.hasOwn(value, 'value')) changed.value = '[redacted]';
  if (Array.isArray(value.fields)) {
    changed.fields = value.fields.slice(0, 64).map((field) => {
      if (!plainObject(field)) return null;
      return Object.fromEntries(['key', 'ref', 'name', 'type']
        .map((key) => [key, boundedString(field[key], 256)])
        .filter(([, entry]) => entry !== null)
        .concat([['redacted', true]]));
    }).filter(Boolean);
  }
  return Object.keys(changed).length ? changed : null;
}

function redactReceipt(value) {
  const receipt = plainObject(value) ? value : {};
  const result = {
    receiptId: boundedString(receipt.receiptId, 220),
    version: Number.isInteger(receipt.version) ? receipt.version : null,
    classification: boundedString(receipt.classification, 40),
    operation: boundedString(receipt.operation, 64) ?? 'dispatch',
    ref: boundedString(receipt.ref, 256),
    target: redactedTarget(receipt.target),
    changed: redactedChanged(receipt.changed),
    events: Array.isArray(receipt.events)
      ? receipt.events.slice(0, MAX_RECEIPT_EVENTS).map((entry) => boundedString(entry, 64)).filter(Boolean)
      : [],
  };
  return Object.freeze(Object.fromEntries(Object.entries(result).filter(([, entry]) => entry !== null)));
}

function redactedApprovalClaim(claim) {
  if (!plainObject(claim)) return null;
  return Object.freeze(Object.fromEntries([
    ['fingerprint', boundedString(claim.fingerprint, 128)],
    ['claimedAt', boundedString(claim.claimedAt, 64)],
    ['expiresAt', boundedString(claim.expiresAt, 64)],
  ].filter(([, entry]) => entry !== null)));
}

function dispatchIdFor(actionId, claim) {
  return `dispatch:${boundedString(claim?.fingerprint, 128) ?? boundedString(actionId, 220) ?? 'unknown'}`;
}

function dispatchedRecord({ actionId, dispatchId, receipt, approvalClaim }) {
  return Object.freeze({
    dispatchId,
    actionId,
    mode: 'mutation',
    status: 'dispatched',
    outcome: 'postcondition-unverified',
    postcondition: 'unverified',
    receipt: redactReceipt(receipt),
    approvalClaim: redactedApprovalClaim(approvalClaim),
  });
}

function unknownDispatchRecord({ actionId, dispatchId, approvalFingerprint = null }) {
  return Object.freeze({
    dispatchId,
    actionId,
    mode: 'mutation',
    status: 'outcome-unknown',
    outcome: 'unknown',
    postcondition: 'unverified',
    receipt: Object.freeze({ operation: 'dispatch', events: Object.freeze([]) }),
    approvalClaim: approvalFingerprint ? Object.freeze({ fingerprint: approvalFingerprint }) : null,
  });
}

function pushReceipt(state, receipt) {
  state.receipts.push(clone(receipt));
  if (state.receipts.length > MAX_SESSION_RECEIPTS) state.receipts.splice(0, state.receipts.length - MAX_SESSION_RECEIPTS);
}

async function rehydrateReceipts(audit) {
  if (!audit || typeof audit.entries !== 'function') return [];
  const entries = await audit.entries();
  const records = [];
  const positions = new Map();
  const upsert = (id, record) => {
    if (positions.has(id)) records[positions.get(id)] = record;
    else {
      positions.set(id, records.length);
      records.push(record);
    }
  };
  for (const entry of entries) {
    const details = plainObject(entry?.details) ? entry.details : {};
    const actionId = boundedString(details.actionId, 220);
    if (!actionId) continue;
    if (entry.event === 'action.dispatching') {
      const dispatchId = boundedString(details.dispatchId, 256) ?? `dispatch:${entry.sequence}`;
      upsert(dispatchId, unknownDispatchRecord({
        actionId,
        dispatchId,
        approvalFingerprint: boundedString(details.approvalFingerprint, 128),
      }));
    } else if (entry.event === 'action.dispatched' || entry.event === 'action.executed') {
      const dispatchId = boundedString(details.dispatchId, 256) ?? `dispatch:${entry.sequence}`;
      upsert(dispatchId, dispatchedRecord({
        actionId,
        dispatchId,
        receipt: details.receipt,
        approvalClaim: { fingerprint: details.approvalFingerprint },
      }));
    } else if (entry.event === 'action.staged') {
      const id = `stage:${actionId}:${entry.sequence}`;
      upsert(id, Object.freeze({
        actionId,
        mode: 'stage',
        status: 'staged',
        outcome: 'local-stage',
        postcondition: 'not-applicable',
        receipt: redactReceipt(details.receipt),
      }));
    }
  }
  return records.slice(-MAX_SESSION_RECEIPTS).map(clone);
}

function duplicateAssessment(winner) {
  return Object.freeze({
    allowedForScoring: false,
    quarantined: true,
    reasonCode: 'TOOL_NAME_DUPLICATE',
    evidence: Object.freeze([Object.freeze({
      ruleId: 'tool.name.duplicate',
      severity: 'quarantine',
      winningDescriptor: clone(winner),
    })]),
  });
}

function descriptorIdentity(descriptor) {
  return Object.freeze({
    name: boundedString(descriptor?.name, 256),
    sourceType: boundedString(descriptor?.sourceType, 64),
    targetRef: boundedString(descriptor?.target?.ref, 256),
    origin: boundedString(descriptor?.provenance?.origin, 512),
    pageFingerprint: boundedString(descriptor?.provenance?.pageFingerprint, 128),
  });
}

function numericRisk(value) {
  if (Number.isFinite(value)) return Number(value);
  if (value === 'read-only') return 0;
  if (value === 'reversible') return 1;
  if (value === 'transactional') return 2;
  return 3;
}

function approvalContext(state, prepared, descriptor) {
  return Object.freeze({
    planId: `${state.sessionId}:${state.snapshot.metadata.origin}`,
    planRevision: state.revision,
    nodeId: prepared.actionId,
    toolOrigin: descriptor.provenance.origin,
    toolName: descriptor.name,
    toolSchemaFingerprint: prepared.descriptorFingerprint,
    canonicalCapability: `page.action.${prepared.classification}`,
    normalizedArguments: Object.freeze({
      tabId: state.tabId,
      frameId: state.frameId,
      sessionId: state.sessionId,
      pageFingerprint: prepared.pageFingerprint,
      targetFingerprint: prepared.target?.targetFingerprint ?? null,
      actionId: prepared.actionId,
      arguments: clone(prepared.normalizedArguments),
    }),
    effectSummary: prepared.effectSummary,
    risk: numericRisk(descriptor.risk),
  });
}

function genericReadResult(descriptor, snapshot) {
  if (descriptor.sourceType === 'page') {
    return Object.freeze({
      type: 'page',
      metadata: clone(snapshot.metadata),
      headings: clone(snapshot.headings),
      mainText: snapshot.mainText,
      pageFingerprint: snapshot.pageFingerprint,
      untrustedContent: true,
    });
  }
  const collections = {
    link: snapshot.links,
    form: snapshot.forms,
    control: snapshot.accessibleControls,
  };
  const value = collections[descriptor.sourceType]?.find((entry) => entry.ref === descriptor.target?.ref);
  if (!value) throw sessionError('READ_TARGET_MISSING', 'The exact read target is no longer present.', { ref: descriptor.target?.ref });
  return Object.freeze({ type: descriptor.sourceType, value: clone(value), pageFingerprint: snapshot.pageFingerprint, untrustedContent: true });
}

export function createUniversalSessionRuntime({
  registerTools,
  executePageAction,
  approvalLedger,
  siteAdapterRegistry = null,
  multimodalPipeline = null,
  auditForSession = async () => null,
  dispatchHookAware = false,
  now = () => new Date(),
} = {}) {
  if (typeof registerTools !== 'function') throw new TypeError('registerTools must be a function.');
  if (typeof executePageAction !== 'function') throw new TypeError('executePageAction must be a function.');
  if (!approvalLedger || typeof approvalLedger.claim !== 'function') throw new TypeError('approvalLedger with claim() is required.');
  const sessions = new Map();
  const ingestTails = new Map();

  async function append(state, event, details = {}) {
    await state.audit?.append?.(event, details);
  }

  function getState(tabId, frameId = 0) {
    const state = sessions.get(sessionKey(tabId, frameId));
    if (!state) throw sessionError('SESSION_NOT_FOUND', 'ToolBraid Universal session is not active.', { tabId, frameId });
    return state;
  }

  function publicState(state) {
    return Object.freeze({
      tabId: state.tabId,
      frameId: state.frameId,
      sessionId: state.sessionId,
      revision: state.revision,
      pageFingerprint: state.snapshot.pageFingerprint,
      url: state.snapshot.metadata.url,
      origin: state.snapshot.metadata.origin,
      tools: Object.freeze([...state.tools.values()].map((entry) => clone(entry.descriptor))),
      quarantined: Object.freeze(clone(state.quarantined)),
      pendingActions: Object.freeze([...state.pending.values()].map((entry) => clone(entry.prepared))),
      approvals: Object.freeze([...state.approvals.values()].map(clone)),
      receipts: Object.freeze(clone(state.receipts)),
      multimodal: clone(state.multimodal),
    });
  }

  async function ingestSnapshot({ tabId, frameId = 0, sessionId, snapshot: rawSnapshot, mediaAssets = [] }) {
    if (typeof sessionId !== 'string' || sessionId.length < 8) throw new TypeError('sessionId is required.');
    const key = sessionKey(tabId, frameId);
    const snapshot = createPageSnapshot(rawSnapshot);
    const prior = sessions.get(key);
    if (prior && prior.sessionId !== sessionId) {
      await prior.audit?.append?.('session.invalidated', { reason: 'session-replaced', nextSessionId: sessionId });
      if (sessions.get(key) === prior) sessions.delete(key);
    }
    let state = sessions.get(key);
    if (state && state.sessionId !== sessionId) {
      throw sessionError('SESSION_DRIFT', 'A newer ToolBraid Universal session already owns this tab and frame.', {
        tabId,
        frameId,
        requestedSessionId: sessionId,
        activeSessionId: state.sessionId,
      });
    }
    if (!state) {
      const audit = await auditForSession({ tabId, frameId, sessionId });
      state = {
        tabId,
        frameId,
        sessionId,
        revision: 0,
        snapshot,
        tools: new Map(),
        quarantined: [],
        pending: new Map(),
        approvals: new Map(),
        receipts: await rehydrateReceipts(audit),
        multimodal: null,
        audit,
      };
      sessions.set(key, state);
    }
    const changed = state.snapshot?.pageFingerprint !== snapshot.pageFingerprint;
    state.snapshot = snapshot;
    if (changed || state.revision === 0) {
      state.revision += 1;
      state.pending.clear();
      state.approvals.clear();
    }

    const verified = siteAdapterRegistry?.generateTools?.(snapshot) ?? [];
    const verifiedTargets = new Set(verified.map((descriptor) => descriptor.target?.ref).filter(Boolean));
    const generic = generateWebMcpToolDescriptors(snapshot, { includePageRead: true, maxTools: 120 })
      .filter((descriptor) => !descriptor.target?.ref || !verifiedTargets.has(descriptor.target.ref));
    const combined = [...verified, ...generic];
    const accepted = [];
    const quarantined = [];
    const names = new Map();
    for (const descriptor of combined) {
      if (names.has(descriptor.name)) {
        const winner = names.get(descriptor.name);
        quarantined.push({
          descriptor: clone(descriptor),
          winningDescriptor: clone(winner),
          assessment: duplicateAssessment(winner),
        });
        continue;
      }
      names.set(descriptor.name, descriptorIdentity(descriptor));
      const assessment = assessToolSecurity(descriptor);
      if (!assessment.allowedForScoring) quarantined.push({ descriptor: clone(descriptor), assessment: clone(assessment) });
      else if (accepted.length < MAX_REGISTERED_TOOLS) accepted.push(descriptor);
      else quarantined.push({
        descriptor: clone(descriptor),
        assessment: {
          allowedForScoring: false,
          quarantined: true,
          reasonCode: 'TOOL_REGISTRATION_LIMIT',
          evidence: [{ ruleId: 'tool.limit.registered', severity: 'quarantine', allowed: MAX_REGISTERED_TOOLS }],
        },
      });
    }
    state.tools = new Map(accepted.map((descriptor) => [descriptor.name, { descriptor }]));
    state.quarantined = quarantined;
    if (multimodalPipeline && mediaAssets.length) {
      state.multimodal = await multimodalPipeline.analyzeAssets(mediaAssets, {
        pageOrigin: snapshot.metadata.origin,
        context: { cacheVary: snapshot.pageFingerprint, tabId, frameId, sessionId },
      });
    }
    await append(state, 'page.ingested', {
      revision: state.revision,
      pageFingerprint: snapshot.pageFingerprint,
      generatedTools: accepted.length,
      quarantinedTools: quarantined.length,
      mediaAssets: mediaAssets.length,
    });
    const registration = await registerTools({ tabId, frameId, sessionId, tools: accepted });
    if (registration?.ok === false) throw sessionError('TOOL_REGISTRATION_FAILED', 'Generated WebMCP tool registration failed.', { registration });
    return publicState(state);
  }

  function ingest(request) {
    const key = sessionKey(request?.tabId, request?.frameId ?? 0);
    const prior = ingestTails.get(key) ?? Promise.resolve();
    const current = prior.then(() => ingestSnapshot(request), () => ingestSnapshot(request));
    ingestTails.set(key, current);
    return current.finally(() => {
      if (ingestTails.get(key) === current) ingestTails.delete(key);
    });
  }

  async function executeTool({ tabId, frameId = 0, sessionId, name, input = {} }) {
    const state = getState(tabId, frameId);
    if (state.sessionId !== sessionId) throw sessionError('SESSION_DRIFT', 'Execution session no longer matches the active page.');
    const entry = state.tools.get(name);
    if (!entry) throw sessionError('TOOL_NOT_FOUND', `Generated tool is not active: ${name}`);
    const { descriptor } = entry;
    if (descriptor.classification === 'read') {
      const result = descriptor.adapter && siteAdapterRegistry
        ? siteAdapterRegistry.executeRead(descriptor, state.snapshot, input)
        : genericReadResult(descriptor, state.snapshot);
      await append(state, 'tool.read', { name, pageFingerprint: state.snapshot.pageFingerprint });
      return result;
    }

    const prepared = prepareAction({ snapshot: state.snapshot, descriptor, input, includeDescriptor: true });
    state.pending.set(prepared.actionId, { prepared, descriptor });
    await append(state, 'action.prepared', {
      actionId: prepared.actionId,
      classification: prepared.classification,
      effect: prepared.effectSummary,
    });
    if (descriptor.classification === 'stage') {
      const receipt = await executePageAction({
        tabId,
        frameId,
        sessionId,
        preparedAction: clone(prepared),
        approved: false,
        mode: 'stage',
      });
      const redacted = redactReceipt(receipt);
      state.pending.delete(prepared.actionId);
      pushReceipt(state, {
        actionId: prepared.actionId,
        mode: 'stage',
        status: 'staged',
        outcome: 'local-stage',
        postcondition: 'not-applicable',
        receipt: redacted,
      });
      await append(state, 'action.staged', { actionId: prepared.actionId, receipt: redacted });
      return Object.freeze({ status: 'staged', preparedAction: clone(prepared), receipt: redacted });
    }
    return Object.freeze({ status: 'approval-required', preparedAction: clone(prepared) });
  }

  async function approve({ tabId, frameId = 0, sessionId, actionId, ttlMs }) {
    const state = getState(tabId, frameId);
    if (state.sessionId !== sessionId) throw sessionError('SESSION_DRIFT', 'Approval session no longer matches the active page.');
    const pending = state.pending.get(actionId);
    if (!pending) throw sessionError('ACTION_NOT_PENDING', 'The requested action is not pending approval.', { actionId });
    assertPreparedActionCurrent(pending.prepared, state.snapshot);
    const context = approvalContext(state, pending.prepared, pending.descriptor);
    const envelope = createApprovalEnvelope(context, { now: now(), ttlMs });
    state.approvals.set(actionId, { envelope, context });
    await append(state, 'approval.created', { actionId, fingerprint: envelope.fingerprint, expiresAt: envelope.expiresAt });
    return Object.freeze(clone(envelope));
  }

  async function executeApproved({ tabId, frameId = 0, sessionId, actionId, snapshot: refreshedSnapshot }) {
    const state = getState(tabId, frameId);
    if (state.sessionId !== sessionId) throw sessionError('SESSION_DRIFT', 'Execution session no longer matches the active page.');
    const pending = state.pending.get(actionId);
    const approval = state.approvals.get(actionId);
    if (!pending || !approval) throw sessionError('APPROVAL_REQUIRED', 'An exact pending action and approval are required.', { actionId });
    const current = createPageSnapshot(refreshedSnapshot);
    assertPreparedActionCurrent(pending.prepared, current);
    const currentContext = approvalContext({ ...state, snapshot: current }, pending.prepared, pending.descriptor);
    const claim = await approvalLedger.claim(approval.envelope, currentContext, { now: now() });
    await append(state, 'approval.claimed', { actionId, nonce: claim.nonce, fingerprint: claim.fingerprint });
    const dispatchId = dispatchIdFor(actionId, claim);
    let dispatchRecorded = false;
    const recordDispatching = async () => {
      if (dispatchRecorded) return;
      await append(state, 'action.dispatching', {
        dispatchId,
        actionId,
        mode: 'mutation',
        approvalFingerprint: claim.fingerprint,
      });
      dispatchRecorded = true;
    };
    let receipt;
    try {
      if (!dispatchHookAware) await recordDispatching();
      receipt = await executePageAction({
        tabId,
        frameId,
        sessionId,
        preparedAction: clone(pending.prepared),
        approved: true,
        approvalClaim: clone(claim),
        mode: 'mutation',
        ...(dispatchHookAware ? { beforeDispatch: recordDispatching } : {}),
      });
      if (!dispatchRecorded) {
        throw sessionError('DISPATCH_AUDIT_MISSING', 'The page action returned without recording durable dispatch intent.');
      }
    } catch (error) {
      state.pending.delete(actionId);
      state.approvals.delete(actionId);
      if (dispatchRecorded) {
        pushReceipt(state, unknownDispatchRecord({ actionId, dispatchId, approvalFingerprint: claim.fingerprint }));
        throw sessionError(
          'ACTION_OUTCOME_UNKNOWN',
          'The action was dispatched, but its postcondition could not be verified.',
          { actionId, dispatchId, causeCode: error?.code ?? 'DISPATCH_INTERRUPTED' },
        );
      }
      throw error;
    }
    const redacted = redactReceipt(receipt);
    try {
      await append(state, 'action.dispatched', {
        dispatchId,
        actionId,
        mode: 'mutation',
        outcome: 'postcondition-unverified',
        postcondition: 'unverified',
        approvalFingerprint: claim.fingerprint,
        receipt: redacted,
      });
    } catch (error) {
      state.pending.delete(actionId);
      state.approvals.delete(actionId);
      pushReceipt(state, unknownDispatchRecord({ actionId, dispatchId, approvalFingerprint: claim.fingerprint }));
      throw sessionError(
        'ACTION_OUTCOME_UNKNOWN',
        'The action was dispatched, but its durable receipt could not be recorded.',
        { actionId, dispatchId, causeCode: error?.code ?? 'RECEIPT_PERSISTENCE_FAILED' },
      );
    }
    state.pending.delete(actionId);
    state.approvals.delete(actionId);
    pushReceipt(state, dispatchedRecord({ actionId, dispatchId, receipt: redacted, approvalClaim: claim }));
    state.snapshot = current;
    return Object.freeze({
      status: 'dispatched',
      outcome: 'postcondition-unverified',
      postcondition: 'unverified',
      receipt: redacted,
      approvalClaim: redactedApprovalClaim(claim),
    });
  }

  async function deny({ tabId, frameId = 0, sessionId, actionId, reason = 'user-denied' }) {
    const state = getState(tabId, frameId);
    if (state.sessionId !== sessionId) throw sessionError('SESSION_DRIFT', 'Denial session no longer matches the active page.');
    if (!state.pending.has(actionId)) throw sessionError('ACTION_NOT_PENDING', 'The requested action is not pending.', { actionId });
    state.pending.delete(actionId);
    state.approvals.delete(actionId);
    await append(state, 'action.denied', { actionId, reason: String(reason).slice(0, 256) });
    return Object.freeze({ status: 'denied', actionId });
  }

  async function close({ tabId, frameId = 0, sessionId = null, reason = 'closed' }) {
    const key = sessionKey(tabId, frameId);
    const state = sessions.get(key);
    if (!state) return false;
    if (sessionId !== null && state.sessionId !== sessionId) return false;
    await append(state, 'session.closed', { reason });
    await state.audit?.seal?.();
    if (sessions.get(key) === state) sessions.delete(key);
    return true;
  }

  return Object.freeze({
    ingest,
    executeTool,
    approve,
    executeApproved,
    deny,
    close,
    state: (tabId, frameId = 0) => publicState(getState(tabId, frameId)),
  });
}

export { approvalContext as universalApprovalContext };
