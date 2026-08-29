import {
  createMissionCoordinator,
  rehydrateMissionCoordinator,
} from '../src/runtime/mission-coordinator.js';

export const MISSION_STORAGE_KEY = 'toolbraid.universal.missions.v1';

export const MISSION_UI_MESSAGE_TYPES = Object.freeze({
  GET_STATE: 'UI_MISSION_GET_STATE',
  CREATE: 'UI_MISSION_CREATE',
  ATTACH: 'UI_MISSION_ATTACH',
  REBIND: 'UI_MISSION_REBIND',
  SELECT: 'UI_MISSION_SELECT',
  DETACH: 'UI_MISSION_DETACH',
  ROUTE: 'UI_MISSION_ROUTE',
});

const MISSION_UI_MESSAGE_SET = new Set(Object.values(MISSION_UI_MESSAGE_TYPES));

export function isMissionUiMessageType(type) {
  return MISSION_UI_MESSAGE_SET.has(type);
}

const HTTP_PROTOCOLS = new Set(['http:', 'https:']);
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,219}$/;

export class ExtensionMissionRuntimeError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ExtensionMissionRuntimeError';
    this.code = code;
    this.details = details;
  }
}

function missionError(code, message, details = {}) {
  return new ExtensionMissionRuntimeError(code, message, details);
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function validIndex(value, field) {
  if (!Number.isInteger(value) || value < 0) {
    throw missionError('BINDING_INVALID', `${field} must be a non-negative integer.`, { field });
  }
  return value;
}

function validId(value, field, { optional = false } = {}) {
  if (value === null || value === undefined) {
    if (optional) return null;
    throw missionError('BINDING_INVALID', `${field} is required.`, { field });
  }
  if (typeof value !== 'string' || !SAFE_ID.test(value)) {
    throw missionError('BINDING_INVALID', `${field} is invalid.`, { field });
  }
  return value;
}

function canonicalOrigin(value, field = 'origin') {
  if (typeof value !== 'string' || value.length === 0) {
    throw missionError('BINDING_INVALID', `${field} must be an HTTP(S) origin.`, { field });
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw missionError('BINDING_INVALID', `${field} must be an HTTP(S) origin.`, { field });
  }
  if (!HTTP_PROTOCOLS.has(parsed.protocol)
    || parsed.origin === 'null'
    || parsed.username
    || parsed.password
    || parsed.pathname !== '/'
    || parsed.search
    || parsed.hash) {
    throw missionError('BINDING_INVALID', `${field} must be a canonical HTTP(S) origin.`, { field });
  }
  return parsed.origin;
}

function originFromUrl(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  try {
    const parsed = new URL(value);
    return HTTP_PROTOCOLS.has(parsed.protocol) && parsed.origin !== 'null'
      ? parsed.origin
      : null;
  } catch {
    return null;
  }
}

function getTabFrame(input = {}, fallbackFrame = 0) {
  if (!isPlainObject(input)) {
    throw missionError('INPUT_INVALID', 'Mission operation input must be a plain object.');
  }
  return {
    tabId: validIndex(input.tabId, 'tabId'),
    frameId: validIndex(input.frameId ?? fallbackFrame, 'frameId'),
  };
}

function safeJson(value, code = 'MISSION_STATE_INVALID') {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new TypeError('undefined');
    return JSON.parse(serialized);
  } catch {
    throw missionError(code, 'Mission state is not safely serializable.');
  }
}

function errorForStorage(code, error) {
  if (error instanceof ExtensionMissionRuntimeError) return error;
  return missionError(code, 'Mission state storage failed safely.');
}

function operationInput(input, fields) {
  const output = {};
  for (const field of fields) {
    if (input[field] !== undefined) output[field] = input[field];
  }
  return output;
}

function publicLiveState(state, target) {
  if (!isPlainObject(state)) return null;
  return {
    tabId: target.tabId,
    frameId: target.frameId,
    sessionId: target.sessionId,
    origin: target.origin,
    pageFingerprint: target.pageFingerprint,
    revision: Number.isInteger(state.revision) ? state.revision : null,
  };
}

/**
 * Extension-side mission facade.  The coordinator remains the authority for
 * mission transitions; this layer only resolves live tab bindings, serializes
 * access, and persists its redacted coordinator representation.
 */
export async function createExtensionMissionRuntime({
  lifecycleRegistry,
  universalRuntime,
  store,
  storageKey = MISSION_STORAGE_KEY,
  now = () => new Date(),
  idFactory,
} = {}) {
  if (!lifecycleRegistry || typeof lifecycleRegistry.get !== 'function') {
    throw new TypeError('lifecycleRegistry.get is required.');
  }
  if (!universalRuntime || typeof universalRuntime.state !== 'function') {
    throw new TypeError('universalRuntime.state is required.');
  }
  if (!store || typeof store.get !== 'function' || typeof store.set !== 'function') {
    throw new TypeError('store.get and store.set are required.');
  }
  if (typeof storageKey !== 'string' || storageKey.length === 0 || storageKey.length > 160) {
    throw new TypeError('storageKey must be a bounded string.');
  }
  if (typeof now !== 'function') throw new TypeError('now must be a function.');
  if (idFactory !== undefined && typeof idFactory !== 'function') {
    throw new TypeError('idFactory must be a function.');
  }

  let persisted;
  try {
    persisted = await store.get(storageKey);
  } catch (error) {
    throw errorForStorage('MISSION_STORAGE_READ_FAILED', error);
  }

  let coordinator;
  try {
    coordinator = persisted === undefined
      ? createMissionCoordinator({ now, ...(idFactory ? { idFactory } : {}) })
      : rehydrateMissionCoordinator(persisted, { now, ...(idFactory ? { idFactory } : {}) });
  } catch (error) {
    if (error?.code) throw error;
    throw missionError('MISSION_PERSISTENCE_INVALID', 'Persisted mission state is invalid.');
  }

  let tail = Promise.resolve();

  function enqueue(operation) {
    const current = tail.then(operation, operation);
    tail = current.then(() => undefined, () => undefined);
    return current;
  }

  function persistence() {
    return safeJson(coordinator.toPersistence(), 'MISSION_PERSISTENCE_INVALID');
  }

  function restore(previous) {
    try {
      coordinator = rehydrateMissionCoordinator(previous, { now, ...(idFactory ? { idFactory } : {}) });
    } catch {
      coordinator = createMissionCoordinator({ now, ...(idFactory ? { idFactory } : {}) });
    }
  }

  async function writePersistence(value) {
    const safe = safeJson(value, 'MISSION_PERSISTENCE_INVALID');
    try {
      await store.set(storageKey, safe);
    } catch (error) {
      throw errorForStorage('MISSION_STORAGE_WRITE_FAILED', error);
    }
  }

  async function mutate(operation) {
    return enqueue(async () => {
      const previous = persistence();
      let result;
      try {
        result = await operation(coordinator);
      } catch (error) {
        throw error?.code ? error : missionError('MISSION_OPERATION_FAILED', 'Mission operation failed safely.');
      }
      try {
        await writePersistence(persistence());
      } catch (error) {
        // A failed durable write must not leave a newly-created authority in
        // memory. Rehydration intentionally drops all volatile bindings.
        restore(previous);
        throw error;
      }
      return clone(safeJson(result));
    });
  }

  function currentMission(missionId) {
    return coordinator.state(missionId);
  }

  function memberFor(missionId, memberId) {
    const mission = currentMission(missionId);
    const member = mission.members.find((candidate) => candidate.memberId === memberId);
    if (!member) {
      const error = new Error('Member does not exist in this mission.');
      error.code = 'MEMBER_NOT_FOUND';
      error.details = { memberId };
      throw error;
    }
    return { mission, member };
  }

  function liveBinding(tabId, frameId) {
    const session = lifecycleRegistry.get(tabId, frameId);
    const page = universalRuntime.state(tabId, frameId);
    if (!isPlainObject(session) || !isPlainObject(page)) {
      throw missionError('LIVE_BINDING_UNAVAILABLE', 'The live tab binding is unavailable.');
    }
    if (session.tabId !== tabId || session.frameId !== frameId
      || page.tabId !== undefined && page.tabId !== tabId
      || page.frameId !== undefined && page.frameId !== frameId) {
      throw missionError('LIVE_BINDING_MISMATCH', 'The live tab binding does not match its target.');
    }
    const sessionId = validId(session.sessionId, 'sessionId');
    if (page.sessionId !== undefined && page.sessionId !== sessionId) {
      throw missionError('LIVE_BINDING_MISMATCH', 'The live page session no longer matches the lifecycle session.');
    }
    const sessionDocumentId = validId(session.documentId, 'documentId', { optional: true });
    const pageDocumentId = validId(page.documentId, 'documentId', { optional: true });
    if (sessionDocumentId && pageDocumentId && sessionDocumentId !== pageDocumentId) {
      throw missionError('LIVE_BINDING_MISMATCH', 'The live document binding does not match.');
    }
    const sessionPageInstanceId = validId(session.pageInstanceId, 'pageInstanceId', { optional: true });
    const pagePageInstanceId = validId(page.pageInstanceId, 'pageInstanceId', { optional: true });
    if (sessionPageInstanceId && pagePageInstanceId && sessionPageInstanceId !== pagePageInstanceId) {
      throw missionError('LIVE_BINDING_MISMATCH', 'The live page instance binding does not match.');
    }
    const rawOrigin = typeof page.origin === 'string' ? page.origin : originFromUrl(page.url);
    const origin = canonicalOrigin(rawOrigin, 'origin');
    const urlOrigin = originFromUrl(page.url);
    if (urlOrigin && urlOrigin !== origin) {
      throw missionError('LIVE_BINDING_MISMATCH', 'The live page origin does not match its URL.');
    }
    const pageFingerprint = validId(page.pageFingerprint, 'pageFingerprint');
    return Object.freeze({
      tabId,
      frameId,
      sessionId,
      documentId: sessionDocumentId ?? pageDocumentId,
      pageInstanceId: sessionPageInstanceId ?? pagePageInstanceId,
      origin,
      pageFingerprint,
    });
  }

  function inputMemberId(input) {
    return validId(input.memberId, 'memberId');
  }

  async function observeLive(active, missionId, memberId, member, binding) {
    if (member.status !== 'attached') return { drift: false, changed: false };
    const observed = active.observeMember({
      missionId,
      memberId,
      bindingDigest: member.bindingDigest,
      ...binding,
    });
    return { drift: Boolean(observed?.drift), changed: Boolean(observed?.drift), observed };
  }

  function operationTarget(active, missionId, memberId, member) {
    if (member.status !== 'attached') {
      return active.target({
        missionId,
        memberId,
        bindingDigest: member.bindingDigest ?? undefined,
      });
    }
    return active.target({ missionId, memberId, bindingDigest: member.bindingDigest });
  }

  async function syncAndPersist(active, missionId, memberId, member) {
    const binding = liveBinding(member.tabId, member.frameId);
    const result = await observeLive(active, missionId, memberId, member, binding);
    if (result.changed) await writePersistence(active.toPersistence());
    return { binding, result };
  }

  function eventTabFrame(input = {}, sender = {}) {
    const tabId = input.tabId ?? sender?.tab?.id;
    const frameId = input.frameId ?? sender?.frameId ?? 0;
    return {
      tabId: validIndex(tabId, 'tabId'),
      frameId: validIndex(frameId, 'frameId'),
    };
  }

  async function handlePageBindingEvent(input = {}, sender = {}) {
    const { tabId, frameId } = eventTabFrame(input, sender);
    return mutate(async (active) => {
      const affected = [];
      let changed = false;
      for (const mission of active.list()) {
        for (const member of mission.members.filter((candidate) => (
          candidate.tabId === tabId && candidate.frameId === frameId && candidate.status === 'attached'
        ))) {
          const binding = liveBinding(tabId, frameId);
          const observed = await observeLive(active, mission.missionId, member.memberId, member, binding);
          if (observed.changed) changed = true;
          affected.push({ missionId: mission.missionId, memberId: member.memberId, drift: observed.drift });
        }
      }
      // `mutate` persists after every event. The value is still returned as a
      // bounded data-only report, never the live session or nonce.
      return { tabId, frameId, affected, changed };
    });
  }

  async function handleTabUpdated(tabId, changeInfo = {}, tab = {}) {
    validIndex(tabId, 'tabId');
    const nextUrl = typeof changeInfo?.url === 'string'
      ? changeInfo.url
      : (typeof tab?.pendingUrl === 'string' ? tab.pendingUrl : null);
    let nextOrigin = null;
    if (nextUrl) nextOrigin = originFromUrl(nextUrl);
    return mutate(async (active) => {
      if (changeInfo?.status !== 'loading' || !nextOrigin) return [];
      const affected = [];
      for (const mission of active.list()) {
        for (const member of mission.members.filter((candidate) => (
          candidate.tabId === tabId && candidate.status !== 'detached' && candidate.origin !== nextOrigin
        ))) {
          const input = { missionId: mission.missionId, memberId: member.memberId };
          if (member.status === 'attached') input.bindingDigest = member.bindingDigest;
          const result = active.invalidateMember({ ...input, reason: 'NAVIGATION_ORIGIN_CHANGED' });
          affected.push({ missionId: mission.missionId, memberId: member.memberId, state: result });
        }
      }
      return affected;
    });
  }

  async function handleTabRemoved(tabId) {
    validIndex(tabId, 'tabId');
    return mutate(async (active) => {
      const affected = [];
      for (const mission of active.list()) {
        for (const member of mission.members.filter((candidate) => (
          candidate.tabId === tabId && candidate.status !== 'detached'
        ))) {
          const result = active.detachByTabFrame({ tabId, frameId: member.frameId });
          if (result) affected.push({ missionId: mission.missionId, memberId: member.memberId, state: result });
        }
      }
      return affected;
    });
  }

  async function target(input = {}) {
    return enqueue(async () => {
      if (!isPlainObject(input)) throw missionError('INPUT_INVALID', 'Mission target input must be a plain object.');
      const missionId = validId(input.missionId, 'missionId');
      const memberId = inputMemberId(input);
      const { member } = memberFor(missionId, memberId);
      // The UI-supplied digest is only an optimistic concurrency check. The
      // coordinator's live digest remains the authority and is never replaced
      // by arbitrary UI binding fields.
      const requestedDigest = input.bindingDigest;
      if (member.status !== 'attached') {
        return clone(coordinator.target({
          missionId,
          memberId,
          bindingDigest: requestedDigest,
        }));
      }
      const { result } = await syncAndPersist(coordinator, missionId, memberId, member);
      const current = memberFor(missionId, memberId).member;
      if (result.changed) {
        return clone(coordinator.target({ missionId, memberId, bindingDigest: requestedDigest }));
      }
      return clone(coordinator.target({
        missionId,
        memberId,
        bindingDigest: requestedDigest,
        // This is intentionally not accepted as a binding source. It merely
        // documents that the digest was checked against the current record.
        expectedBindingDigest: current.bindingDigest,
      }));
    });
  }

  async function read(input = {}) {
    return enqueue(async () => {
      if (!isPlainObject(input)) throw missionError('INPUT_INVALID', 'Mission read input must be a plain object.');
      const missionId = validId(input.missionId, 'missionId');
      const memberId = inputMemberId(input);
      const { member } = memberFor(missionId, memberId);
      if (member.status === 'attached') {
        const { result } = await syncAndPersist(coordinator, missionId, memberId, member);
        if (result.changed) {
          return clone({
            target: operationTarget(coordinator, missionId, memberId, member),
            page: null,
            mission: coordinator.state(missionId),
          });
        }
      }
      const targetValue = operationTarget(coordinator, missionId, memberId, member);
      const page = targetValue ? publicLiveState(universalRuntime.state(targetValue.tabId, targetValue.frameId), targetValue) : null;
      return clone(safeJson({ target: targetValue, page, mission: coordinator.state(missionId) }));
    });
  }

  function exactMissionBinding(input = {}) {
    try {
      if (!isPlainObject(input)) return false;
      const { member } = memberFor(input.missionId, input.memberId);
      const bindingDigest = input.bindingDigest ?? member.bindingDigest;
      const targetValue = coordinator.target({
        missionId: input.missionId,
        memberId: input.memberId,
        bindingDigest,
      });
      const exact = ['missionId', 'memberId', 'tabId', 'frameId', 'sessionId', 'origin', 'pageFingerprint']
        .every((field) => targetValue[field] === input[field]);
      return exact && (input.bindingDigest === undefined || input.bindingDigest === targetValue.bindingDigest);
    } catch {
      return false;
    }
  }

  const runtime = {
    createMission(input = {}) {
      return mutate((active) => active.createMission(operationInput(input, ['missionId'])));
    },

    attachMember(input = {}) {
      return mutate((active) => {
        if (!isPlainObject(input)) throw missionError('INPUT_INVALID', 'Mission member input must be a plain object.');
        const { tabId, frameId } = getTabFrame(input);
        const binding = liveBinding(tabId, frameId);
        return active.attachMember({
          ...operationInput(input, ['missionId', 'memberId', 'required', 'role']),
          ...binding,
        });
      });
    },

    rebindMember(input = {}) {
      return mutate((active) => {
        if (!isPlainObject(input)) throw missionError('INPUT_INVALID', 'Mission rebind input must be a plain object.');
        const missionId = validId(input.missionId, 'missionId');
        const memberId = inputMemberId(input);
        const { member } = memberFor(missionId, memberId);
        const { tabId, frameId } = getTabFrame(input, member.frameId);
        const binding = liveBinding(tabId, frameId);
        return active.rebindMember({
          missionId,
          memberId,
          ...(member.status === 'attached' ? { expectedBindingDigest: member.bindingDigest } : {}),
          ...binding,
        });
      });
    },

    selectMember(input = {}) {
      return mutate(async (active) => {
        if (!isPlainObject(input)) throw missionError('INPUT_INVALID', 'Mission selection input must be a plain object.');
        const missionId = validId(input.missionId, 'missionId');
        const memberId = inputMemberId(input);
        const { member } = memberFor(missionId, memberId);
        if (member.status === 'attached') {
          const binding = liveBinding(member.tabId, member.frameId);
          await observeLive(active, missionId, memberId, member, binding);
        }
        return active.selectMember({ missionId, memberId });
      });
    },

    detachMember(input = {}) {
      return mutate((active) => {
        if (!isPlainObject(input)) throw missionError('INPUT_INVALID', 'Mission detach input must be a plain object.');
        const missionId = validId(input.missionId, 'missionId');
        const memberId = inputMemberId(input);
        const { member } = memberFor(missionId, memberId);
        const value = { missionId, memberId };
        if (member.status === 'attached') value.bindingDigest = member.bindingDigest;
        return active.detachMember(value);
      });
    },

    registerPendingAction(input = {}) {
      return mutate((active) => {
        if (!isPlainObject(input)) throw missionError('INPUT_INVALID', 'Pending action input must be a plain object.');
        const missionId = validId(input.missionId, 'missionId');
        const memberId = inputMemberId(input);
        const { member } = memberFor(missionId, memberId);
        const value = operationInput(input, ['missionId', 'memberId', 'actionId']);
        if (member.status === 'attached') value.bindingDigest = member.bindingDigest;
        return active.registerPendingAction(value);
      });
    },

    invalidateMember(input = {}) {
      return mutate((active) => {
        if (!isPlainObject(input)) throw missionError('INPUT_INVALID', 'Mission invalidation input must be a plain object.');
        const missionId = validId(input.missionId, 'missionId');
        const memberId = inputMemberId(input);
        const { member } = memberFor(missionId, memberId);
        const value = operationInput(input, ['missionId', 'memberId', 'reason']);
        if (member.status === 'attached') value.bindingDigest = member.bindingDigest;
        return active.invalidateMember(value);
      });
    },

    invalidateMission(input = {}) {
      return mutate((active) => active.invalidateMission(operationInput(input, ['missionId', 'reason'])));
    },

    setPhase(input = {}) {
      return mutate((active) => active.setPhase(operationInput(input, ['missionId', 'phase', 'expectedRevision'])));
    },

    target,
    read,

    async handleUiMessage(type, payload = {}) {
      if (!isMissionUiMessageType(type)) {
        throw missionError('MISSION_UI_MESSAGE_INVALID', 'Unsupported mission side-panel message type.');
      }
      if (type === MISSION_UI_MESSAGE_TYPES.GET_STATE) {
        return { ok: true, state: { missions: runtime.list() } };
      }
      if (type === MISSION_UI_MESSAGE_TYPES.CREATE) return { ok: true, result: await runtime.createMission(payload) };
      if (type === MISSION_UI_MESSAGE_TYPES.ATTACH) return { ok: true, result: await runtime.attachMember(payload) };
      if (type === MISSION_UI_MESSAGE_TYPES.REBIND) return { ok: true, result: await runtime.rebindMember(payload) };
      if (type === MISSION_UI_MESSAGE_TYPES.SELECT) return { ok: true, result: await runtime.selectMember(payload) };
      if (type === MISSION_UI_MESSAGE_TYPES.DETACH) return { ok: true, result: await runtime.detachMember(payload) };
      if (payload?.operation === 'target') return { ok: true, result: await target(payload) };
      if (payload?.operation === 'read') return { ok: true, result: await read(payload) };
      throw missionError('MISSION_ROUTE_OPERATION_INVALID', 'Mission routing supports target or read only.');
    },

    validateBinding: exactMissionBinding,
    validateMissionBinding: exactMissionBinding,
    isBindingCurrent: exactMissionBinding,
    getBinding(input = {}, memberId = undefined) {
      const request = typeof input === 'string'
        ? { missionId: input, memberId }
        : input;
      const { member } = memberFor(request.missionId, request.memberId);
      return clone(coordinator.target({
        missionId: request.missionId,
        memberId: request.memberId,
        bindingDigest: request.bindingDigest ?? member.bindingDigest,
      }));
    },

    handlePageReady: handlePageBindingEvent,
    handlePageSnapshot: handlePageBindingEvent,
    handleTabUpdated,
    handleTabRemoved,

    has(missionId) {
      return coordinator.has(missionId);
    },

    state(missionId) {
      return clone(coordinator.state(missionId));
    },

    list() {
      return clone(coordinator.list());
    },

    toPersistence(input = {}) {
      return clone(coordinator.toPersistence(input));
    },

    serialize(input = {}) {
      return coordinator.serialize(input);
    },
  };

  return Object.freeze(runtime);
}
