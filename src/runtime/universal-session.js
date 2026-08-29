import {
  assertPreparedActionCurrent,
  cloneJson,
  createPageSnapshot,
  freezeDeep,
  generateWebMcpToolDescriptors,
  prepareAction,
  stableStringify,
  validateToolDescriptor,
} from '../universal/index.js';
import {
  applyPostconditionResult,
  normalizePostconditionResult,
} from '../universal/postconditions.js';
import { assessToolSecurity } from '../engine/risk.js';
import { createApprovalEnvelope } from '../engine/approval.js';

const MAX_REGISTERED_TOOLS = 128;
const MAX_SESSION_RECEIPTS = 256;
const MAX_RECEIPT_EVENTS = 16;
const DEFAULT_POSTCONDITION_TIMEOUT_MS = 5_000;

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

function ownDescriptor(value) {
  validateToolDescriptor(value);
  return freezeDeep(cloneJson(value, '$.adapterDescriptor'));
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

function dispatchedRecord({ actionId, dispatchId, receipt, approvalClaim, verification = null }) {
  return Object.freeze({
    dispatchId,
    actionId,
    mode: 'mutation',
    status: 'dispatched',
    outcome: 'postcondition-unverified',
    postcondition: 'unverified',
    receipt: redactReceipt(receipt),
    approvalClaim: redactedApprovalClaim(approvalClaim),
    ...(verification ? { verification: clone(verification) } : {}),
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

function replaceReceipt(state, dispatchId, receipt) {
  const index = state.receipts.findIndex((entry) => entry?.dispatchId === dispatchId);
  if (index < 0) return false;
  state.receipts[index] = clone(receipt);
  return true;
}

function unverifiedPostcondition({ contract, beforeSnapshot, reasonCode, checkedAt }) {
  return normalizePostconditionResult({
    status: 'unverified',
    reasonCode,
  }, {
    contract,
    beforeSnapshot,
    checkedAt,
  });
}

function publicDispatchResult(record) {
  return Object.freeze({
    status: record.status,
    outcome: record.outcome,
    postcondition: record.postcondition,
    receipt: clone(record.receipt),
    approvalClaim: clone(record.approvalClaim),
    ...(record.verification ? { verification: clone(record.verification) } : {}),
  });
}

function withPostconditionTimeout(operation, timeoutMs) {
  const controller = new AbortController();
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    };
    const timer = setTimeout(() => {
      controller.abort();
      finish(reject, sessionError('POSTCONDITION_TIMEOUT', 'The postcondition verifier did not respond before its deadline.'));
    }, timeoutMs);
    Promise.resolve()
      .then(() => operation(controller.signal))
      .then((value) => finish(resolve, value), (error) => finish(reject, error));
  });
}

function receiptRank(record) {
  if (record?.status === 'verified-success' || record?.status === 'verified-failure') return 3;
  if (record?.status === 'dispatched') return 2;
  if (record?.status === 'outcome-unknown') return 1;
  return 0;
}

async function rehydrateReceipts(audit) {
  if (!audit || typeof audit.entries !== 'function') return [];
  const entries = await audit.entries();
  const records = [];
  const positions = new Map();
  const upsert = (id, record) => {
    if (!positions.has(id)) {
      positions.set(id, records.length);
      records.push(record);
      return;
    }
    const index = positions.get(id);
    const current = records[index];
    const currentRank = receiptRank(current);
    const nextRank = receiptRank(record);
    if (nextRank < currentRank) return;
    if (nextRank === currentRank) {
      // An unverified postcondition enriches the known dispatch record, but a
      // later plain dispatch event must never erase an existing verdict.
      if (current?.status === 'dispatched' && !current.verification && record?.verification) {
        records[index] = record;
      }
      return;
    }
    records[index] = record;
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
    } else if (entry.event === 'action.postcondition') {
      const dispatchId = boundedString(details.dispatchId, 256);
      if (!dispatchId || !positions.has(dispatchId)) continue;
      const current = records[positions.get(dispatchId)];
      if (!current || current.status !== 'dispatched' || current.actionId !== actionId) continue;
      const contract = details.contract;
      const persisted = details.verification;
      if (!plainObject(contract) || !plainObject(persisted) || typeof persisted.checkedAt !== 'string') continue;
      try {
        // Persisted verification records contain the normalized identity and
        // before-fingerprint fields as well as the adapter verdict.  Rebuild
        // the verdict through the same boundary instead of accepting those
        // extra fields as an adapter result.
        const verification = normalizePostconditionResult({
          status: persisted.status,
          reasonCode: persisted.reasonCode,
          evidence: persisted.evidence,
          afterPageFingerprint: persisted.afterPageFingerprint,
        }, {
          contract,
          beforeSnapshot: persisted.beforePageFingerprint
            ? { pageFingerprint: persisted.beforePageFingerprint }
            : null,
          afterPageFingerprint: persisted.afterPageFingerprint ?? null,
          checkedAt: persisted.checkedAt,
        });
        if (persisted.version !== verification.version
          || persisted.contractId !== verification.contractId
          || persisted.adapterId !== verification.adapterId
          || persisted.adapterVersion !== verification.adapterVersion
          || persisted.beforePageFingerprint !== verification.beforePageFingerprint
          || persisted.afterPageFingerprint !== verification.afterPageFingerprint
          || persisted.status !== verification.status) continue;
        upsert(dispatchId, applyPostconditionResult(current, verification));
      } catch {
        // A malformed postcondition event can never upgrade a known dispatch.
      }
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
  capabilityPackRegistry = null,
  capabilityObjective = null,
  maxRegisteredTools = MAX_REGISTERED_TOOLS,
  multimodalPipeline = null,
  auditForSession = async () => null,
  dispatchHookAware = false,
  postconditionVerifier = null,
  postconditionTimeoutMs = DEFAULT_POSTCONDITION_TIMEOUT_MS,
  now = () => new Date(),
} = {}) {
  if (typeof registerTools !== 'function') throw new TypeError('registerTools must be a function.');
  if (typeof executePageAction !== 'function') throw new TypeError('executePageAction must be a function.');
  if (!approvalLedger || typeof approvalLedger.claim !== 'function') throw new TypeError('approvalLedger with claim() is required.');
  if (postconditionVerifier !== null && typeof postconditionVerifier !== 'function') throw new TypeError('postconditionVerifier must be a function or null.');
  if (capabilityPackRegistry !== null
      && (typeof capabilityPackRegistry.resolve !== 'function'
        || typeof capabilityPackRegistry.executeRead !== 'function'
        || typeof capabilityPackRegistry.invalidate !== 'function'
        || typeof capabilityPackRegistry.getPublicState !== 'function')) {
    throw new TypeError('capabilityPackRegistry must expose resolve(), executeRead(), invalidate(), and getPublicState().');
  }
  if (!Number.isInteger(maxRegisteredTools) || maxRegisteredTools < 1 || maxRegisteredTools > MAX_REGISTERED_TOOLS) {
    throw new RangeError(`maxRegisteredTools must be an integer between 1 and ${MAX_REGISTERED_TOOLS}.`);
  }
  if (!Number.isInteger(postconditionTimeoutMs) || postconditionTimeoutMs < 1 || postconditionTimeoutMs > 60_000) {
    throw new RangeError('postconditionTimeoutMs must be an integer between 1 and 60000.');
  }
  const sessions = new Map();
  const ingestTails = new Map();

  async function append(state, event, details = {}) {
    const audit = state.audit;
    if (typeof audit?.append !== 'function') return undefined;
    let previousHash = null;
    let canReadBack = false;
    if (typeof audit.head === 'function') {
      try {
        previousHash = await audit.head();
        canReadBack = typeof previousHash === 'string';
      } catch {
        // A failed head lookup keeps the append fail-closed below.
      }
    }
    try {
      return await audit.append(event, details);
    } catch (error) {
      if (!canReadBack || typeof audit.entries !== 'function') throw error;
      try {
        const expectedDetails = stableStringify(details);
        const committed = (await audit.entries()).find((entry) => entry?.event === event
          && entry.previousHash === previousHash
          && stableStringify(entry.details) === expectedDetails);
        if (committed) return committed;
      } catch {
        // Keep the original append error and fail closed when readback is not
        // trustworthy or the audit record is malformed.
      }
      throw error;
    }
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
      capabilityPacks: clone(state.capabilityPacks),
    });
  }

  async function ingestSnapshot({ tabId, frameId = 0, sessionId, snapshot: rawSnapshot, mediaAssets = [] }) {
    if (typeof sessionId !== 'string' || sessionId.length < 8) throw new TypeError('sessionId is required.');
    const key = sessionKey(tabId, frameId);
    const snapshot = createPageSnapshot(rawSnapshot);
    const prior = sessions.get(key);
    if (prior && prior.sessionId !== sessionId) {
      capabilityPackRegistry?.invalidate({ sessionId: prior.sessionId });
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
        capabilityPacks: null,
        capabilityPackStateToken: null,
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

    const adapterQuarantine = (reasonCode) => ({
      descriptor: null,
      assessment: {
        allowedForScoring: false,
        quarantined: true,
        reasonCode,
        evidence: [{ ruleId: 'adapter.descriptor', severity: 'quarantine', reasonCode }],
      },
    });
    let packResolution = null;
    let rawPackTools = [];
    if (capabilityPackRegistry) {
      try {
        packResolution = await capabilityPackRegistry.resolve(snapshot, {
          sessionId,
          ...(capabilityObjective === null ? {} : { objective: capabilityObjective }),
        });
        if (!packResolution?.stale && Array.isArray(packResolution?.tools)) rawPackTools = packResolution.tools;
      } catch {
        packResolution = null;
        rawPackTools = [];
      }
      if (sessions.get(key) !== state || state.sessionId !== sessionId) {
        capabilityPackRegistry.invalidate({ sessionId });
        throw sessionError('SESSION_DRIFT', 'Capability pack resolution belongs to a closed or replaced session.');
      }
    }

    let rawVerified;
    const adapterQuarantined = [];
    try {
      rawVerified = siteAdapterRegistry?.generateTools?.(snapshot) ?? [];
      if (!Array.isArray(rawVerified) || rawVerified.length > MAX_REGISTERED_TOOLS) {
        adapterQuarantined.push(adapterQuarantine('ADAPTER_DESCRIPTOR_ARRAY_INVALID'));
        rawVerified = [];
      }
    } catch {
      rawVerified = [];
      adapterQuarantined.push(adapterQuarantine('ADAPTER_DESCRIPTOR_ARRAY_INVALID'));
    }
    const packDescriptors = [];
    for (let index = 0; index < rawPackTools.length; index += 1) {
      try {
        if (!Object.hasOwn(rawPackTools, index)) throw new TypeError('Capability pack descriptor array contains a hole.');
        packDescriptors.push(ownDescriptor(rawPackTools[index]));
      } catch {
        adapterQuarantined.push(adapterQuarantine('PACK_DESCRIPTOR_INVALID'));
      }
    }
    const verified = [];
    for (let index = 0; index < rawVerified.length; index += 1) {
      try {
        if (!Object.hasOwn(rawVerified, index)) throw new TypeError('Adapter descriptor array contains a hole.');
        verified.push(ownDescriptor(rawVerified[index]));
      } catch {
        adapterQuarantined.push(adapterQuarantine('ADAPTER_DESCRIPTOR_INVALID'));
      }
    }
    const verifiedTargets = new Set([...packDescriptors, ...verified]
      .map((descriptor) => descriptor.target?.ref)
      .filter(Boolean));
    const generic = generateWebMcpToolDescriptors(snapshot, { includePageRead: true, maxTools: 120 })
      .filter((descriptor) => !descriptor.target?.ref || !verifiedTargets.has(descriptor.target.ref))
      .map(ownDescriptor);
    const combined = [...packDescriptors, ...verified, ...generic];
    const accepted = [];
    const quarantined = [...adapterQuarantined];
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
      else if (accepted.length < maxRegisteredTools) accepted.push(descriptor);
      else quarantined.push({
        descriptor: clone(descriptor),
        assessment: {
          allowedForScoring: false,
          quarantined: true,
          reasonCode: 'TOOL_REGISTRATION_LIMIT',
          evidence: [{ ruleId: 'tool.limit.registered', severity: 'quarantine', allowed: maxRegisteredTools }],
        },
      });
    }
    const packNames = new Set(packDescriptors.map((descriptor) => descriptor.name));
    state.tools = new Map(accepted.map((descriptor) => [descriptor.name, {
      descriptor,
      ...(packNames.has(descriptor.name) && packResolution?.stateToken
        ? { capabilityPackStateToken: clone(packResolution.stateToken) }
        : {}),
    }]));
    state.quarantined = quarantined;
    state.capabilityPackStateToken = packResolution?.stateToken ? clone(packResolution.stateToken) : null;
    if (capabilityPackRegistry) {
      const publicRegistry = capabilityPackRegistry.getPublicState(sessionId);
      state.capabilityPacks = freezeDeep({
        registryRevision: publicRegistry.registryRevision,
        catalog: clone(publicRegistry.catalog),
        selected: clone(packResolution?.selected ?? []),
        activePacks: clone(packResolution?.activePacks ?? []),
        budget: clone(packResolution?.budget ?? {
          maxActiveTools: capabilityPackRegistry.maxActiveTools,
          usedTools: 0,
          remainingTools: capabilityPackRegistry.maxActiveTools,
        }),
        quarantined: clone(packResolution?.quarantined ?? []),
      });
    } else {
      state.capabilityPacks = null;
    }
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
      const result = entry.capabilityPackStateToken && capabilityPackRegistry
        ? capabilityPackRegistry.executeRead({
          sessionId,
          stateToken: entry.capabilityPackStateToken,
          descriptor,
          snapshot: state.snapshot,
          input,
        })
        : (descriptor.adapter && siteAdapterRegistry
          ? siteAdapterRegistry.executeRead(descriptor, state.snapshot, input)
          : genericReadResult(descriptor, state.snapshot));
      await append(state, 'tool.read', { name, pageFingerprint: state.snapshot.pageFingerprint });
      return result;
    }

    const prepared = prepareAction({ snapshot: state.snapshot, descriptor, input, includeDescriptor: true });
    state.pending.set(prepared.actionId, { prepared, descriptor });
    try {
      await append(state, 'action.prepared', {
        actionId: prepared.actionId,
        classification: prepared.classification,
        effect: prepared.effectSummary,
      });
    } catch (error) {
      state.pending.delete(prepared.actionId);
      throw error;
    }
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
    try {
      await append(state, 'approval.created', { actionId, fingerprint: envelope.fingerprint, expiresAt: envelope.expiresAt });
    } catch (error) {
      state.approvals.delete(actionId);
      throw error;
    }
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
    let claim;
    try {
      claim = await approvalLedger.claim(approval.envelope, currentContext, { now: now() });
      await append(state, 'approval.claimed', { actionId, nonce: claim.nonce, fingerprint: claim.fingerprint });
    } catch (error) {
      // A claim may have committed before a ledger/audit error.  Never leave
      // an approval in memory that could be replayed after that uncertainty.
      state.pending.delete(actionId);
      state.approvals.delete(actionId);
      throw error;
    }
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
    const dispatchRecord = dispatchedRecord({ actionId, dispatchId, receipt: redacted, approvalClaim: claim });
    pushReceipt(state, dispatchRecord);
    state.snapshot = current;
    const contract = pending.prepared?.postcondition;
    if (!contract || !postconditionVerifier) return publicDispatchResult(dispatchRecord);

    let verification;
    try {
      const rawVerification = await withPostconditionTimeout((signal) => postconditionVerifier({
        tabId,
        frameId,
        sessionId,
        dispatchId,
        signal,
        descriptor: clone(pending.descriptor),
        preparedAction: clone(pending.prepared),
        dispatchReceipt: clone(redacted),
        beforeSnapshot: clone(current),
      }), postconditionTimeoutMs);
      verification = normalizePostconditionResult(rawVerification, {
        contract,
        beforeSnapshot: current,
        afterPageFingerprint: rawVerification?.afterPageFingerprint ?? null,
        checkedAt: now(),
      });
    } catch (error) {
      verification = unverifiedPostcondition({
        contract,
        beforeSnapshot: current,
        reasonCode: error?.code ?? 'POSTCONDITION_VERIFIER_FAILED',
        checkedAt: now(),
      });
    }

    const verificationDetails = {
      dispatchId,
      actionId,
      contract: clone(contract),
      verification: clone(verification),
    };
    try {
      await append(state, 'action.postcondition', verificationDetails);
    } catch {
      // Dispatch is already durable. A verification persistence failure cannot
      // turn it into an unknown outcome or justify a success claim.
      return publicDispatchResult(dispatchRecord);
    }
    const verifiedRecord = applyPostconditionResult(dispatchRecord, verification);
    replaceReceipt(state, dispatchId, verifiedRecord);
    return publicDispatchResult(verifiedRecord);
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
    capabilityPackRegistry?.invalidate({ sessionId: state.sessionId });
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
