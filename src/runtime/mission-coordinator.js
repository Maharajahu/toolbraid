import { sha256Hex, stableStringify } from '../universal/canonical.js';

export const MAX_MISSION_MEMBERS = 16;
export const MISSION_PERSISTENCE_VERSION = 1;

export const MISSION_PHASES = Object.freeze({
  RUNNING: 'running',
  WAITING_HUMAN: 'waiting_human',
  RESUMING: 'resuming',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
});

export const MEMBER_STATUS = Object.freeze({
  ATTACHED: 'attached',
  AWAITING_REBIND: 'awaiting-rebind',
  INVALIDATED: 'invalidated',
  DETACHED: 'detached',
});

const PHASE_VALUES = new Set(Object.values(MISSION_PHASES));
const TERMINAL_PHASES = new Set([
  MISSION_PHASES.COMPLETED,
  MISSION_PHASES.FAILED,
  MISSION_PHASES.CANCELLED,
]);
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,219}$/;
const SAFE_CODE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const HTTP_PROTOCOLS = new Set(['http:', 'https:']);

export class MissionCoordinatorError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'MissionCoordinatorError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details = {}) {
  throw new MissionCoordinatorError(code, message, details);
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function clone(value) {
  return structuredClone(value);
}

function requiredObject(value, field) {
  if (!isPlainObject(value)) fail('FIELD_INVALID', `${field} must be a plain object.`, { field });
  return value;
}

function safeId(value, field, { optional = false } = {}) {
  if (value === null || value === undefined) {
    if (optional) return null;
    fail('FIELD_REQUIRED', `${field} is required.`, { field });
  }
  if (typeof value !== 'string' || !SAFE_ID.test(value)) {
    fail('FIELD_INVALID', `${field} must be a bounded identifier.`, { field });
  }
  return value;
}

function safeCode(value, field, fallback = 'UNSPECIFIED') {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value !== 'string' || !SAFE_CODE.test(value)) {
    fail('FIELD_INVALID', `${field} must be a bounded code.`, { field });
  }
  return value;
}

function nonNegativeInteger(value, field, { optional = false } = {}) {
  if (value === null || value === undefined) {
    if (optional) return null;
    fail('FIELD_REQUIRED', `${field} is required.`, { field });
  }
  if (!Number.isInteger(value) || value < 0) {
    fail('FIELD_INVALID', `${field} must be a non-negative integer.`, { field });
  }
  return value;
}

function booleanValue(value, field, fallback) {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') fail('FIELD_INVALID', `${field} must be boolean.`, { field });
  return value;
}

function timestamp(value, field, fallback) {
  const candidate = value ?? fallback;
  if (typeof candidate !== 'string') fail('FIELD_INVALID', `${field} must be an ISO timestamp.`, { field });
  const date = new Date(candidate);
  if (!Number.isFinite(date.getTime())) fail('FIELD_INVALID', `${field} must be an ISO timestamp.`, { field });
  return date.toISOString();
}

function clockNow(now) {
  let value;
  try {
    value = now();
  } catch {
    fail('CLOCK_UNAVAILABLE', 'Mission clock is unavailable.');
  }
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) fail('CLOCK_INVALID', 'Mission clock returned an invalid time.');
  return date.toISOString();
}

function defaultNow() {
  return new Date();
}

let fallbackIdCounter = 0;

function defaultIdFactory(prefix) {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return `${prefix}-${uuid}`;
  fallbackIdCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${fallbackIdCounter.toString(36)}`;
}

function bindingKey(tabId, frameId) {
  return `${tabId}:${frameId}`;
}

function parseWebOrigin(value, field) {
  if (typeof value !== 'string' || value.length === 0) {
    fail('BINDING_ORIGIN_INVALID', `${field} must be an HTTP(S) origin.`, { field });
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail('BINDING_ORIGIN_INVALID', `${field} must be an HTTP(S) origin.`, { field });
  }
  if (!HTTP_PROTOCOLS.has(parsed.protocol) || parsed.origin === 'null' || parsed.username || parsed.password) {
    fail('BINDING_ORIGIN_INVALID', `${field} must be an HTTP(S) origin without credentials.`, { field });
  }
  return parsed.origin;
}

function canonicalOrigin(input) {
  const originValue = input.origin;
  const urlValue = input.url;
  const origin = originValue === undefined || originValue === null
    ? null
    : parseWebOrigin(originValue, 'origin');
  const fromUrl = urlValue === undefined || urlValue === null
    ? null
    : parseWebOrigin(urlValue, 'url');
  if (!origin && !fromUrl) fail('BINDING_ORIGIN_INVALID', 'An HTTP(S) origin is required.', { field: 'origin' });
  if (origin && fromUrl && origin !== fromUrl) {
    fail('BINDING_ORIGIN_MISMATCH', 'origin and url do not identify the same origin.');
  }
  return origin ?? fromUrl;
}

function normalizeBinding(input, field = 'binding') {
  requiredObject(input, field);
  return {
    tabId: nonNegativeInteger(input.tabId, `${field}.tabId`),
    frameId: nonNegativeInteger(input.frameId ?? 0, `${field}.frameId`),
    sessionId: safeId(input.sessionId, `${field}.sessionId`),
    documentId: safeId(input.documentId, `${field}.documentId`, { optional: true }),
    pageInstanceId: safeId(input.pageInstanceId, `${field}.pageInstanceId`, { optional: true }),
    origin: canonicalOrigin(input),
    pageFingerprint: safeId(input.pageFingerprint, `${field}.pageFingerprint`),
  };
}

function normalizeOptionalDigest(input, field = 'bindingDigest') {
  if (input === undefined || input === null) return null;
  return safeId(input, field);
}

/**
 * Compute the control-plane binding token. Only the exact tab/frame/session,
 * document/page identity, origin, and page fingerprint participate; arbitrary
 * caller fields (including URLs and credentials) are ignored.
 */
export function computeBindingDigest(binding) {
  const value = requiredObject(binding, 'binding');
  const projection = {
    missionId: typeof value.missionId === 'string' ? value.missionId : null,
    memberId: typeof value.memberId === 'string' ? value.memberId : null,
    tabId: Number.isInteger(value.tabId) ? value.tabId : null,
    frameId: Number.isInteger(value.frameId) ? value.frameId : null,
    sessionId: typeof value.sessionId === 'string' ? value.sessionId : null,
    documentId: typeof value.documentId === 'string' ? value.documentId : null,
    pageInstanceId: typeof value.pageInstanceId === 'string' ? value.pageInstanceId : null,
    origin: typeof value.origin === 'string' ? value.origin : null,
    pageFingerprint: typeof value.pageFingerprint === 'string' ? value.pageFingerprint : null,
  };
  return sha256Hex(stableStringify(projection));
}

function assertDigest(expected, actual) {
  const supplied = normalizeOptionalDigest(expected);
  if (supplied !== null && supplied !== actual) {
    fail('BINDING_DIGEST_MISMATCH', 'The supplied binding digest is stale or incorrect.');
  }
}

function requireCurrentDigest(input, member) {
  const expected = input.expectedBindingDigest ?? input.bindingDigest;
  const supplied = normalizeOptionalDigest(expected);
  if (supplied === null) {
    fail('BINDING_DIGEST_REQUIRED', 'The current binding digest is required.', { field: 'bindingDigest' });
  }
  if (supplied !== member.bindingDigest) {
    fail('BINDING_DIGEST_MISMATCH', 'The supplied binding digest is stale or incorrect.');
  }
  return supplied;
}

function assertPhase(phase) {
  if (!PHASE_VALUES.has(phase)) fail('MISSION_PHASE_INVALID', 'Unknown mission phase.', { field: 'phase' });
}

function assertExpectedRevision(mission, expectedRevision) {
  if (expectedRevision === undefined) return;
  const expected = nonNegativeInteger(expectedRevision, 'expectedRevision');
  if (expected !== mission.revision) {
    fail('MISSION_REVISION_MISMATCH', 'Mission revision is stale.', {
      expectedRevision: expected,
      actualRevision: mission.revision,
    });
  }
}

function bindingChanged(previous, next) {
  return ['tabId', 'frameId', 'sessionId', 'documentId', 'pageInstanceId', 'origin', 'pageFingerprint']
    .some((field) => previous[field] !== next[field]);
}

function driftReason(previous, next) {
  if (previous.sessionId !== next.sessionId) return 'SESSION_CHANGED';
  if (previous.documentId !== next.documentId) return 'DOCUMENT_CHANGED';
  if (previous.pageInstanceId !== next.pageInstanceId) return 'PAGE_INSTANCE_CHANGED';
  if (previous.origin !== next.origin) return 'ORIGIN_CHANGED';
  if (previous.pageFingerprint !== next.pageFingerprint) return 'PAGE_FINGERPRINT_CHANGED';
  if (previous.tabId !== next.tabId) return 'TAB_CHANGED';
  if (previous.frameId !== next.frameId) return 'FRAME_CHANGED';
  return 'BINDING_CHANGED';
}

function publicMember(member) {
  return {
    memberId: member.memberId,
    tabId: member.tabId,
    frameId: member.frameId,
    sessionId: member.sessionId,
    documentId: member.documentId,
    pageInstanceId: member.pageInstanceId,
    origin: member.origin,
    pageFingerprint: member.pageFingerprint,
    bindingDigest: member.bindingDigest,
    status: member.status,
    required: member.required,
    role: member.role,
    joinedAt: member.joinedAt,
    lastSeenAt: member.lastSeenAt,
    rebindRequired: member.rebindRequired,
  };
}

function publicPendingAction(action) {
  return {
    actionId: action.actionId,
    memberId: action.memberId,
    bindingDigest: action.bindingDigest,
    createdAt: action.createdAt,
  };
}

function publicState(mission) {
  return {
    missionId: mission.missionId,
    phase: mission.phase,
    revision: mission.revision,
    activeMemberId: mission.activeMemberId,
    members: [...mission.members.values()].map(publicMember),
    pendingActions: [...mission.pendingActions.values()].map(publicPendingAction),
    invalidatedActionIds: [...mission.lastInvalidatedActionIds],
  };
}

function operationResult(mission, metadata = {}) {
  const state = publicState(mission);
  return { ...state, ...metadata, state: clone(state) };
}

function persistenceMember(member) {
  return {
    memberId: member.memberId,
    tabId: member.tabId,
    frameId: member.frameId,
    origin: member.origin,
    pageFingerprint: member.pageFingerprint,
    status: member.status === MEMBER_STATUS.DETACHED
      ? MEMBER_STATUS.DETACHED
      : MEMBER_STATUS.AWAITING_REBIND,
    required: member.required,
    role: member.role,
    joinedAt: member.joinedAt,
    bindingDigest: null,
  };
}

function persistenceMission(mission) {
  const active = mission.members.get(mission.activeMemberId);
  return {
    missionId: mission.missionId,
    phase: mission.phase,
    revision: mission.revision,
    activeMemberId: active && active.status !== MEMBER_STATUS.DETACHED ? active.memberId : null,
    members: [...mission.members.values()].map(persistenceMember),
    // Pending actions are intentionally never restored across a worker restart.
    pendingActions: [],
  };
}

function parsePersistence(input) {
  let value = input;
  if (typeof input === 'string') {
    try {
      value = JSON.parse(input);
    } catch {
      fail('PERSISTENCE_INVALID', 'Mission persistence is not valid JSON.');
    }
  }
  requiredObject(value, 'persistence');
  if (value.version !== MISSION_PERSISTENCE_VERSION) {
    fail('PERSISTENCE_VERSION_UNSUPPORTED', 'Mission persistence version is unsupported.', {
      version: value.version,
    });
  }
  if (!Array.isArray(value.missions)) fail('PERSISTENCE_INVALID', 'Mission persistence missions must be an array.');
  return value;
}

function createMissionRecord(missionId, now) {
  return {
    missionId,
    phase: MISSION_PHASES.RUNNING,
    revision: 0,
    activeMemberId: null,
    members: new Map(),
    pendingActions: new Map(),
    joinedAt: now,
    lastInvalidatedActionIds: [],
  };
}

function clearPending(mission, memberId = null) {
  const invalidated = [];
  for (const [actionId, action] of mission.pendingActions) {
    if (memberId === null || action.memberId === memberId) {
      invalidated.push(actionId);
      mission.pendingActions.delete(actionId);
    }
  }
  mission.lastInvalidatedActionIds = invalidated;
  return invalidated;
}

export class MissionCoordinator {
  constructor(options = {}) {
    if (!isPlainObject(options)) fail('CONFIG_INVALID', 'Mission coordinator options must be a plain object.');
    this.maxMembers = Math.min(
      MAX_MISSION_MEMBERS,
      options.maxMembers === undefined ? MAX_MISSION_MEMBERS : nonNegativeInteger(options.maxMembers, 'maxMembers'),
    );
    if (this.maxMembers === 0) fail('CONFIG_INVALID', 'maxMembers must be greater than zero.', { field: 'maxMembers' });
    this.now = typeof options.now === 'function' ? options.now : defaultNow;
    this.idFactory = typeof options.idFactory === 'function' ? options.idFactory : defaultIdFactory;
    this.missions = new Map();
    this.owners = new Map();
    if (options.persistence !== undefined) this.restore(options.persistence);
  }

  createMission(input = {}) {
    requiredObject(input, 'mission');
    const proposed = input.missionId ?? this.idFactory('mission');
    const missionId = safeId(proposed, 'missionId');
    if (this.missions.has(missionId)) fail('MISSION_ALREADY_EXISTS', 'Mission already exists.', { missionId });
    const mission = createMissionRecord(missionId, clockNow(this.now));
    this.missions.set(missionId, mission);
    return publicState(mission);
  }

  has(missionId) {
    if (typeof missionId !== 'string') return false;
    return this.missions.has(missionId);
  }

  state(missionId) {
    const mission = this.#mission(missionId);
    return clone(publicState(mission));
  }

  snapshot(missionId) {
    return this.state(missionId);
  }

  list() {
    return [...this.missions.values()].map((mission) => publicState(mission));
  }

  attachMember(input = {}) {
    requiredObject(input, 'member');
    const mission = this.#mission(input.missionId);
    this.#assertMutableMission(mission);
    if (mission.members.size >= this.maxMembers) {
      fail('MEMBER_LIMIT_REACHED', 'Mission member limit reached.', {
        maxMembers: this.maxMembers,
      });
    }
    const memberId = safeId(input.memberId ?? this.idFactory('member'), 'memberId');
    if (mission.members.has(memberId)) fail('MEMBER_ALREADY_EXISTS', 'Member already exists in this mission.', { memberId });
    const binding = normalizeBinding(input);
    const ownerKey = bindingKey(binding.tabId, binding.frameId);
    this.#assertOwnerAvailable(ownerKey, mission.missionId, memberId);
    const digest = computeBindingDigest({ missionId: mission.missionId, memberId, ...binding });
    assertDigest(input.bindingDigest, digest);
    const now = clockNow(this.now);
    const record = {
      memberId,
      ...binding,
      bindingDigest: digest,
      status: MEMBER_STATUS.ATTACHED,
      required: booleanValue(input.required, 'required', false),
      role: input.role === undefined ? 'tab' : safeCode(input.role, 'role'),
      joinedAt: now,
      lastSeenAt: now,
      rebindRequired: false,
    };
    mission.members.set(memberId, record);
    this.owners.set(ownerKey, { missionId: mission.missionId, memberId });
    if (mission.activeMemberId === null) mission.activeMemberId = memberId;
    mission.lastInvalidatedActionIds = [];
    mission.revision += 1;
    return publicState(mission);
  }

  selectMember(input = {}) {
    requiredObject(input, 'selection');
    const mission = this.#mission(input.missionId);
    this.#assertMutableMission(mission);
    const memberId = safeId(input.memberId, 'memberId');
    const member = this.#member(mission, memberId);
    if (member.status === MEMBER_STATUS.DETACHED) {
      fail('MEMBER_DETACHED', 'Member is detached.', { memberId });
    }
    if (member.status !== MEMBER_STATUS.ATTACHED) {
      fail('MEMBER_REBIND_REQUIRED', 'Member must be rebound before selection.', { memberId });
    }
    if (mission.activeMemberId === memberId) return publicState(mission);
    mission.lastInvalidatedActionIds = [];
    mission.activeMemberId = memberId;
    mission.revision += 1;
    return publicState(mission);
  }

  target(input = {}) {
    requiredObject(input, 'target');
    const mission = this.#mission(input.missionId);
    if (TERMINAL_PHASES.has(mission.phase)) {
      fail('MISSION_TERMINAL', 'A terminal mission cannot be targeted.', { missionId: mission.missionId });
    }
    const memberId = safeId(input.memberId, 'memberId');
    const member = this.#member(mission, memberId);
    if (member.status === MEMBER_STATUS.DETACHED) {
      fail('MEMBER_DETACHED', 'Member is detached.', { memberId });
    }
    if (member.status !== MEMBER_STATUS.ATTACHED || member.rebindRequired) {
      fail('MEMBER_REBIND_REQUIRED', 'Member requires an exact rebind before targeting.', { memberId });
    }
    const supplied = normalizeOptionalDigest(input.bindingDigest);
    if (supplied === null) fail('BINDING_DIGEST_REQUIRED', 'An exact binding digest is required.', { field: 'bindingDigest' });
    if (supplied !== member.bindingDigest) {
      fail('BINDING_DIGEST_MISMATCH', 'The supplied binding digest is stale or incorrect.');
    }
    return {
      missionId: mission.missionId,
      memberId: member.memberId,
      bindingDigest: member.bindingDigest,
      tabId: member.tabId,
      frameId: member.frameId,
      sessionId: member.sessionId,
      documentId: member.documentId,
      pageInstanceId: member.pageInstanceId,
      origin: member.origin,
      pageFingerprint: member.pageFingerprint,
    };
  }

  registerPendingAction(input = {}) {
    requiredObject(input, 'pendingAction');
    const mission = this.#mission(input.missionId);
    this.#assertMutableMission(mission);
    const target = this.target(input);
    const actionId = safeId(input.actionId ?? this.idFactory('action'), 'actionId');
    if (mission.pendingActions.has(actionId)) fail('ACTION_ALREADY_PENDING', 'Action is already pending.', { actionId });
    mission.pendingActions.set(actionId, {
      actionId,
      memberId: target.memberId,
      bindingDigest: target.bindingDigest,
      createdAt: clockNow(this.now),
    });
    mission.lastInvalidatedActionIds = [];
    mission.revision += 1;
    return publicState(mission);
  }

  pendingActions(missionId) {
    const mission = this.#mission(missionId);
    return clone([...mission.pendingActions.values()].map(publicPendingAction));
  }

  observeMember(input = {}) {
    requiredObject(input, 'observation');
    const mission = this.#mission(input.missionId);
    this.#assertMutableMission(mission);
    const memberId = safeId(input.memberId, 'memberId');
    const member = this.#member(mission, memberId);
    if (member.status === MEMBER_STATUS.DETACHED) {
      fail('MEMBER_DETACHED', 'Member is detached.', { memberId });
    }
    const observed = normalizeBinding(input, 'observation');
    const observedDigest = computeBindingDigest({ missionId: mission.missionId, memberId, ...observed });
    if (member.status === MEMBER_STATUS.ATTACHED) requireCurrentDigest(input, member);
    if (member.status === MEMBER_STATUS.ATTACHED && member.bindingDigest === observedDigest) {
      member.lastSeenAt = clockNow(this.now);
      return operationResult(mission, { drift: false, reason: null });
    }
    if (member.status !== MEMBER_STATUS.ATTACHED) {
      return operationResult(mission, { drift: true, reason: 'REBIND_REQUIRED' });
    }
    const reason = driftReason(member, observed);
    this.#beginMutation(mission);
    const invalidatedActionIds = clearPending(mission, memberId);
    member.status = MEMBER_STATUS.AWAITING_REBIND;
    member.rebindRequired = true;
    member.bindingDigest = null;
    member.sessionId = null;
    member.documentId = null;
    member.pageInstanceId = null;
    mission.revision += 1;
    return operationResult(mission, {
      drift: true,
      reason,
      invalidatedActionIds,
    });
  }

  rebindMember(input = {}) {
    requiredObject(input, 'memberRebind');
    const mission = this.#mission(input.missionId);
    this.#assertMutableMission(mission);
    const memberId = safeId(input.memberId, 'memberId');
    const member = this.#member(mission, memberId);
    if (member.status === MEMBER_STATUS.DETACHED) {
      fail('MEMBER_DETACHED', 'Detached members cannot be rebound; attach a new member id.', { memberId });
    }
    if (member.status === MEMBER_STATUS.ATTACHED) requireCurrentDigest(input, member);
    const binding = normalizeBinding(input, 'memberRebind');
    const nextOwnerKey = bindingKey(binding.tabId, binding.frameId);
    this.#assertOwnerAvailable(nextOwnerKey, mission.missionId, memberId);
    const digest = computeBindingDigest({ missionId: mission.missionId, memberId, ...binding });
    assertDigest(input.newBindingDigest, digest);
    const changed = member.status !== MEMBER_STATUS.ATTACHED || bindingChanged(member, binding);
    if (!changed) {
      member.lastSeenAt = clockNow(this.now);
      return publicState(mission);
    }
    this.#beginMutation(mission);
    const invalidatedActionIds = clearPending(mission, memberId);
    const oldOwnerKey = bindingKey(member.tabId, member.frameId);
    if (this.owners.get(oldOwnerKey)?.missionId === mission.missionId
      && this.owners.get(oldOwnerKey)?.memberId === memberId) {
      this.owners.delete(oldOwnerKey);
    }
    Object.assign(member, binding, {
      bindingDigest: digest,
      status: MEMBER_STATUS.ATTACHED,
      lastSeenAt: clockNow(this.now),
      rebindRequired: false,
    });
    this.owners.set(nextOwnerKey, { missionId: mission.missionId, memberId });
    if (mission.activeMemberId === null) mission.activeMemberId = memberId;
    mission.revision += 1;
    return operationResult(mission, { invalidatedActionIds });
  }

  invalidateMember(input = {}) {
    requiredObject(input, 'memberInvalidation');
    const mission = this.#mission(input.missionId);
    this.#assertMutableMission(mission);
    const memberId = safeId(input.memberId, 'memberId');
    const member = this.#member(mission, memberId);
    if (member.status === MEMBER_STATUS.DETACHED) {
      fail('MEMBER_DETACHED', 'Member is detached.', { memberId });
    }
    if (member.status === MEMBER_STATUS.ATTACHED) requireCurrentDigest(input, member);
    this.#beginMutation(mission);
    const invalidatedActionIds = clearPending(mission, memberId);
    const changed = member.status !== MEMBER_STATUS.INVALIDATED || member.bindingDigest !== null;
    member.status = MEMBER_STATUS.INVALIDATED;
    member.rebindRequired = true;
    member.bindingDigest = null;
    member.sessionId = null;
    member.documentId = null;
    member.pageInstanceId = null;
    if (mission.activeMemberId === memberId) {
      mission.activeMemberId = [...mission.members.values()]
        .find((candidate) => candidate.status === MEMBER_STATUS.ATTACHED)?.memberId ?? null;
    }
    if (changed || invalidatedActionIds.length > 0) mission.revision += 1;
    return operationResult(mission, {
      invalidatedActionIds,
      reason: safeCode(input.reason, 'reason'),
    });
  }

  invalidateMission(input = {}) {
    requiredObject(input, 'missionInvalidation');
    const mission = this.#mission(input.missionId);
    this.#assertMutableMission(mission);
    this.#beginMutation(mission);
    const invalidatedActionIds = clearPending(mission);
    for (const member of mission.members.values()) {
      member.status = MEMBER_STATUS.INVALIDATED;
      member.rebindRequired = true;
      member.bindingDigest = null;
      member.sessionId = null;
      member.documentId = null;
      member.pageInstanceId = null;
    }
    mission.phase = MISSION_PHASES.FAILED;
    this.#releaseMissionOwners(mission);
    mission.revision += 1;
    return operationResult(mission, {
      invalidatedActionIds,
      reason: safeCode(input.reason, 'reason'),
    });
  }

  detachMember(input = {}) {
    requiredObject(input, 'memberDetach');
    const mission = this.#mission(input.missionId);
    this.#assertMutableMission(mission);
    const memberId = safeId(input.memberId, 'memberId');
    const member = this.#member(mission, memberId);
    if (member.status === MEMBER_STATUS.DETACHED) {
      fail('MEMBER_DETACHED', 'Member is detached.', { memberId });
    }
    if (member.status === MEMBER_STATUS.ATTACHED) requireCurrentDigest(input, member);
    return this.#detachMemberRecord(mission, member);
  }

  #detachMemberRecord(mission, member) {
    this.#beginMutation(mission);
    const invalidatedActionIds = clearPending(mission, member.memberId);
    const ownerKey = bindingKey(member.tabId, member.frameId);
    if (this.owners.get(ownerKey)?.missionId === mission.missionId
      && this.owners.get(ownerKey)?.memberId === member.memberId) {
      this.owners.delete(ownerKey);
    }
    const changed = member.status !== MEMBER_STATUS.DETACHED || invalidatedActionIds.length > 0;
    member.status = MEMBER_STATUS.DETACHED;
    member.rebindRequired = true;
    member.bindingDigest = null;
    member.sessionId = null;
    member.documentId = null;
    member.pageInstanceId = null;
    if (mission.activeMemberId === member.memberId) {
      mission.activeMemberId = [...mission.members.values()]
        .find((candidate) => candidate.status === MEMBER_STATUS.ATTACHED)?.memberId ?? null;
    }
    if (changed) mission.revision += 1;
    return operationResult(mission, { invalidatedActionIds });
  }

  detachByTabFrame(input = {}) {
    requiredObject(input, 'tabFrame');
    const tabId = nonNegativeInteger(input.tabId, 'tabId');
    const frameId = nonNegativeInteger(input.frameId ?? 0, 'frameId');
    const owner = this.owners.get(bindingKey(tabId, frameId));
    if (!owner) return null;
    const mission = this.#mission(owner.missionId);
    this.#assertMutableMission(mission);
    const member = this.#member(mission, owner.memberId);
    if (member.status === MEMBER_STATUS.DETACHED) {
      fail('MEMBER_DETACHED', 'Member is detached.', { memberId: member.memberId });
    }
    return this.#detachMemberRecord(mission, member);
  }

  setPhase(input = {}) {
    requiredObject(input, 'phaseChange');
    const mission = this.#mission(input.missionId);
    const phase = input.phase;
    assertPhase(phase);
    assertExpectedRevision(mission, input.expectedRevision);
    if (TERMINAL_PHASES.has(mission.phase)) {
      fail('MISSION_TERMINAL', 'A terminal mission cannot change phase.', { missionId: mission.missionId });
    }
    if (mission.phase === phase) return publicState(mission);
    this.#beginMutation(mission);
    let invalidatedActionIds = [];
    if (TERMINAL_PHASES.has(phase)) {
      invalidatedActionIds = clearPending(mission);
      this.#releaseMissionOwners(mission);
    }
    mission.phase = phase;
    mission.revision += 1;
    return operationResult(mission, { invalidatedActionIds });
  }

  toPersistence(input = {}) {
    let missionId = null;
    if (typeof input === 'string') missionId = safeId(input, 'missionId');
    else if (input && typeof input === 'object' && input.missionId !== undefined) missionId = safeId(input.missionId, 'missionId');
    else if (input !== undefined && input !== null && typeof input !== 'object') {
      fail('FIELD_INVALID', 'persistence options must be an object.', { field: 'persistence' });
    }
    const missions = missionId === null
      ? [...this.missions.values()]
      : [this.#mission(missionId)];
    return {
      version: MISSION_PERSISTENCE_VERSION,
      missions: missions.map(persistenceMission),
    };
  }

  serialize(input = {}) {
    return stableStringify(this.toPersistence(input));
  }

  restore(input) {
    const value = parsePersistence(input);
    const restored = new MissionCoordinator({
      maxMembers: this.maxMembers,
      now: this.now,
      idFactory: this.idFactory,
    });
    for (const persistedMission of value.missions) restored.#restoreMission(persistedMission);
    this.missions = restored.missions;
    this.owners = restored.owners;
    return this.list();
  }

  static fromPersistence(input, options = {}) {
    return new MissionCoordinator({ ...options, persistence: input });
  }

  #mission(missionId) {
    const id = safeId(missionId, 'missionId');
    const mission = this.missions.get(id);
    if (!mission) fail('MISSION_NOT_FOUND', 'Mission does not exist.', { missionId: id });
    return mission;
  }

  #member(mission, memberId) {
    const member = mission.members.get(memberId);
    if (!member) fail('MEMBER_NOT_FOUND', 'Member does not exist in this mission.', { memberId });
    return member;
  }

  #assertMutableMission(mission) {
    if (TERMINAL_PHASES.has(mission.phase)) {
      fail('MISSION_TERMINAL', 'A terminal mission cannot accept this operation.', { missionId: mission.missionId });
    }
  }

  #assertOwnerAvailable(ownerKey, missionId, memberId) {
    const owner = this.owners.get(ownerKey);
    if (!owner || (owner.missionId === missionId && owner.memberId === memberId)) return;
    fail('TAB_FRAME_ALREADY_ATTACHED', 'Tab/frame is already owned by another active mission.', {
      tabFrame: ownerKey,
    });
  }

  #beginMutation(mission) {
    mission.lastInvalidatedActionIds = [];
  }

  #releaseMissionOwners(mission) {
    for (const member of mission.members.values()) {
      const ownerKey = bindingKey(member.tabId, member.frameId);
      const owner = this.owners.get(ownerKey);
      if (owner?.missionId === mission.missionId && owner.memberId === member.memberId) {
        this.owners.delete(ownerKey);
      }
    }
  }

  #restoreMission(input) {
    requiredObject(input, 'mission');
    const missionId = safeId(input.missionId, 'missionId');
    if (this.missions.has(missionId)) fail('PERSISTENCE_INVALID', 'Persistence contains duplicate missions.', { missionId });
    const phase = input.phase;
    assertPhase(phase);
    const revision = nonNegativeInteger(input.revision, 'revision');
    if (!Array.isArray(input.members) || input.members.length > this.maxMembers) {
      fail('PERSISTENCE_INVALID', 'Persisted mission members exceed the configured limit.');
    }
    const mission = createMissionRecord(missionId, clockNow(this.now));
    mission.phase = phase;
    mission.revision = revision;
    this.missions.set(missionId, mission);
    const members = input.members;
    for (const persistedMember of members) {
      requiredObject(persistedMember, 'member');
      const memberId = safeId(persistedMember.memberId, 'memberId');
      if (mission.members.has(memberId)) fail('PERSISTENCE_INVALID', 'Persistence contains duplicate members.', { memberId });
      const tabId = nonNegativeInteger(persistedMember.tabId, 'tabId');
      const frameId = nonNegativeInteger(persistedMember.frameId ?? 0, 'frameId');
      const origin = parseWebOrigin(persistedMember.origin, 'origin');
      const pageFingerprint = safeId(persistedMember.pageFingerprint, 'pageFingerprint');
      const status = persistedMember.status === MEMBER_STATUS.DETACHED
        ? MEMBER_STATUS.DETACHED
        : MEMBER_STATUS.AWAITING_REBIND;
      const member = {
        memberId,
        tabId,
        frameId,
        sessionId: null,
        documentId: null,
        pageInstanceId: null,
        origin,
        pageFingerprint,
        bindingDigest: null,
        status,
        required: booleanValue(persistedMember.required, 'required', false),
        role: persistedMember.role === undefined ? 'tab' : safeCode(persistedMember.role, 'role'),
        joinedAt: timestamp(persistedMember.joinedAt, 'joinedAt', clockNow(this.now)),
        lastSeenAt: null,
        rebindRequired: status !== MEMBER_STATUS.DETACHED,
      };
      mission.members.set(memberId, member);
      if (status !== MEMBER_STATUS.DETACHED && !TERMINAL_PHASES.has(phase)) {
        const ownerKey = bindingKey(tabId, frameId);
        this.#assertOwnerAvailable(ownerKey, missionId, memberId);
        this.owners.set(ownerKey, { missionId, memberId });
      }
    }
    const requestedActive = input.activeMemberId === null || input.activeMemberId === undefined
      ? null
      : safeId(input.activeMemberId, 'activeMemberId');
    const active = requestedActive ? mission.members.get(requestedActive) : null;
    mission.activeMemberId = active && active.status !== MEMBER_STATUS.DETACHED ? active.memberId : null;
    // Persisted pending actions, if supplied by an older/newer writer, are deliberately discarded.
    mission.pendingActions.clear();
    mission.lastInvalidatedActionIds = [];
  }
}

export function createMissionCoordinator(options = {}) {
  return new MissionCoordinator(options);
}

export function rehydrateMissionCoordinator(input, options = {}) {
  return MissionCoordinator.fromPersistence(input, options);
}
