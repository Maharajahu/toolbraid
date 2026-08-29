import {
  cloneJson,
  freezeDeep,
  stableStringify,
} from '../../universal/canonical.js';
import {
  createPageSnapshot,
} from '../../universal/snapshot.js';
import {
  validateToolDescriptor,
} from '../../universal/tools.js';
import {
  CapabilityPackError,
  DEFAULT_CAPABILITY_PACK_TOOL_BUDGET,
  MAX_CAPABILITY_PACK_HINT_LENGTH,
  capabilityPackManifestKey,
  catalogRevision,
  createCapabilityPackCatalog,
  matchCapabilityPackHints,
  publicCapabilityPackManifest,
} from './catalog.js';

export { CapabilityPackError } from './catalog.js';

export const DEFAULT_MAX_ACTIVE_CAPABILITY_PACK_TOOLS = 32;
export const DEFAULT_CAPABILITY_PACK_LOAD_TIMEOUT_MS = 5_000;
export const MAX_CAPABILITY_PACK_LOAD_TIMEOUT_MS = 60_000;
export const MAX_GENERATED_CAPABILITY_PACK_TOOLS = 128;
export const MAX_CAPABILITY_PACK_OBJECTIVE_INPUT_TOKENS = 32;

function packError(code, message, details = {}) {
  return new CapabilityPackError(code, message, details);
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function normalizeSessionId(value) {
  if (value === undefined || value === null || value === '') return 'default';
  if (typeof value !== 'string' || value.trim() !== value || value.length > MAX_CAPABILITY_PACK_HINT_LENGTH) {
    throw packError('PACK_SESSION_INVALID', 'Capability pack sessionId must be a bounded string.');
  }
  return value;
}

function objectiveTokens(value) {
  const source = Array.isArray(value) ? value.join(' ') : String(value ?? '');
  return [...new Set((source
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .match(/[a-z0-9]+/g) ?? [])
    .slice(0, MAX_CAPABILITY_PACK_OBJECTIVE_INPUT_TOKENS))];
}

function locationForSnapshot(snapshot) {
  const rawUrl = snapshot?.metadata?.url;
  if (typeof rawUrl !== 'string' || !rawUrl) return null;
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
    return {
      protocol: url.protocol,
      hostname: url.hostname.toLowerCase(),
      pathname: url.pathname || '/',
    };
  } catch {
    return null;
  }
}

function compareCandidates(left, right) {
  return right.objectiveScore - left.objectiveScore
    || right.manifest.priority - left.manifest.priority
    || right.hint.pathSpecificity - left.hint.pathSpecificity
    || left.manifest.id.localeCompare(right.manifest.id)
    || left.manifest.version.localeCompare(right.manifest.version);
}

function publicCandidate(candidate) {
  return freezeDeep({
    ...publicCapabilityPackManifest(candidate.manifest),
    objectiveScore: candidate.objectiveScore,
    pathSpecificity: candidate.hint.pathSpecificity,
    exactPath: candidate.hint.exactPath,
    pathPrefix: candidate.hint.pathPrefix,
  });
}

function safeFault({ code, stage, manifest = null, index = null }) {
  return freezeDeep({
    code,
    stage,
    packId: manifest?.id ?? null,
    version: manifest?.version ?? null,
    ...(index === null ? {} : { index }),
  });
}

function publicActivePack(manifest, toolCount, status = 'active') {
  return freezeDeep({
    id: manifest.id,
    version: manifest.version,
    priority: manifest.priority,
    maxTools: manifest.maxTools,
    toolCount,
    status,
  });
}

function validPackObject(value) {
  if (!isPlainObject(value)) return null;
  const pack = isPlainObject(value.adapter) ? value.adapter : value;
  if (!isPlainObject(pack) || typeof pack.matches !== 'function' || typeof pack.generateTools !== 'function') {
    return null;
  }
  return pack;
}

function adapterBindingForPack(pack, manifest) {
  const id = pack.id ?? manifest.id;
  const version = pack.version ?? manifest.version;
  if (typeof id !== 'string' || !/^[A-Za-z0-9_.-]{1,128}$/.test(id)
      || typeof version !== 'string' || !/^[A-Za-z0-9_.-]{1,128}$/.test(version)) {
    throw new Error('pack adapter binding is invalid');
  }
  return Object.freeze({ id, version });
}

function assertDescriptorContract(descriptor, snapshot, binding) {
  const classification = descriptor.classification;
  const externalStateChange = classification === 'mutate';
  if (descriptor.kind !== classification
      || descriptor.requiresApproval !== externalStateChange
      || descriptor.annotations?.readOnlyHint !== (classification === 'read')
      || descriptor.annotations?.untrustedContentHint !== true
      || descriptor.effect?.classification !== classification
      || descriptor.effect?.externalStateChange !== externalStateChange
      || descriptor.effect?.requiresApproval !== externalStateChange
      || descriptor.pageFingerprint !== snapshot.pageFingerprint
      || descriptor.provenance?.pageFingerprint !== snapshot.pageFingerprint
      || descriptor.provenance?.sourceType !== descriptor.sourceType) {
    throw new Error('descriptor contract is inconsistent');
  }
  if (descriptor.provenance?.adapterId !== undefined
      && descriptor.provenance.adapterId !== binding.id) {
    throw new Error('descriptor provenance adapter id is inconsistent');
  }
  if (descriptor.provenance?.adapterVersion !== undefined
      && String(descriptor.provenance.adapterVersion) !== binding.version) {
    throw new Error('descriptor provenance adapter version is inconsistent');
  }
  if (descriptor.provenance?.source === 'toolbraid.verified-adapter'
      && (descriptor.provenance.adapterId !== binding.id
        || String(descriptor.provenance.adapterVersion) !== binding.version)) {
    throw new Error('verified descriptor is missing its exact adapter binding');
  }
  if (descriptor.adapter?.id !== binding.id || descriptor.adapter?.version !== binding.version) {
    throw new Error('descriptor adapter binding is inconsistent');
  }
}

function descriptorsForPack(pack, snapshot, manifest, quarantined) {
  let generated;
  try {
    generated = pack.generateTools(snapshot);
  } catch {
    quarantined.push(safeFault({ code: 'PACK_DESCRIPTOR_GENERATION_FAILED', stage: 'generateTools', manifest }));
    return [];
  }
  if (!Array.isArray(generated)) {
    quarantined.push(safeFault({ code: 'PACK_DESCRIPTOR_INVALID', stage: 'generateTools', manifest }));
    return [];
  }

  let binding;
  try {
    binding = adapterBindingForPack(pack, manifest);
  } catch {
    quarantined.push(safeFault({ code: 'PACK_DESCRIPTOR_INVALID', stage: 'adapter-binding', manifest }));
    return [];
  }

  const candidates = generated.slice(0, MAX_GENERATED_CAPABILITY_PACK_TOOLS);
  if (generated.length > MAX_GENERATED_CAPABILITY_PACK_TOOLS) {
    quarantined.push(safeFault({ code: 'PACK_DESCRIPTOR_LIMIT', stage: 'generateTools', manifest }));
  }

  const descriptors = [];
  for (const [index, value] of candidates.entries()) {
    try {
      const descriptor = cloneJson(value, `$.packs.${manifest.id}.tools[${index}]`);
      validateToolDescriptor(descriptor);
      if (descriptor.adapter !== undefined
          && (descriptor.adapter?.id !== binding.id || String(descriptor.adapter?.version) !== binding.version)) {
        throw new Error('descriptor adapter binding is forged');
      }
      const bound = cloneJson({ ...descriptor, adapter: binding }, `$.packs.${manifest.id}.tools[${index}]`);
      validateToolDescriptor(bound);
      assertDescriptorContract(bound, snapshot, binding);
      descriptors.push(freezeDeep(bound));
    } catch {
      quarantined.push(safeFault({ code: 'PACK_DESCRIPTOR_INVALID', stage: 'descriptor', manifest, index }));
    }
  }
  return descriptors;
}

function publicStateForSession(state) {
  return {
    sessionId: state.sessionId,
    pageFingerprint: state.pageFingerprint,
    snapshotVersion: state.snapshotVersion,
    revision: state.revision,
    activePacks: state.activePacks.map((entry) => publicActivePack(entry.manifest, entry.toolCount, entry.status)),
    budget: { ...state.budget },
    quarantined: state.quarantined.map((entry) => ({ ...entry })),
  };
}

function tokenForState(state) {
  return freezeDeep({
    registryRevision: state.registryRevision,
    sessionId: state.sessionId,
    revision: state.revision,
    pageFingerprint: state.pageFingerprint,
    snapshotVersion: state.snapshotVersion,
    packVersions: state.activePacks.map(({ manifest }) => ({ id: manifest.id, version: manifest.version })),
  });
}

function sameToken(left, right) {
  try {
    return stableStringify(left) === stableStringify(right);
  } catch {
    return false;
  }
}

function descriptorExecutionKey(descriptor) {
  try {
    return stableStringify(descriptor);
  } catch {
    return null;
  }
}

function staleResult({ sessionId, snapshot = null, registryRevision: revision, maxActiveTools }) {
  return freezeDeep({
    sessionId,
    pageFingerprint: snapshot?.pageFingerprint ?? null,
    snapshotVersion: snapshot?.version ?? null,
    registryRevision: revision,
    selected: [],
    activePacks: [],
    tools: [],
    quarantined: [safeFault({ code: 'PACK_RESOLUTION_STALE', stage: 'commit' })],
    budget: {
      maxActiveTools,
      usedTools: 0,
      remainingTools: maxActiveTools,
    },
    stateToken: null,
    stale: true,
  });
}

function emptyResult({
  sessionId,
  snapshot = null,
  registryRevision: revision,
  maxActiveTools = DEFAULT_MAX_ACTIVE_CAPABILITY_PACK_TOOLS,
  quarantined = [],
}) {
  const pageFingerprint = snapshot?.pageFingerprint ?? null;
  const snapshotVersion = snapshot?.version ?? null;
  return freezeDeep({
    sessionId,
    pageFingerprint,
    snapshotVersion,
    registryRevision: revision,
    selected: [],
    activePacks: [],
    tools: [],
    quarantined,
    budget: {
      maxActiveTools,
      usedTools: 0,
      remainingTools: maxActiveTools,
    },
    stateToken: null,
  });
}

/**
 * Registry for statically trusted, lazily loaded universal capability packs.
 * The catalog is captured at construction time; page snapshots are only used
 * for matching and can never add or replace a manifest.
 */
export function createCapabilityPackRegistry({
  catalog = [],
  maxActiveTools = DEFAULT_MAX_ACTIVE_CAPABILITY_PACK_TOOLS,
  loadTimeoutMs = DEFAULT_CAPABILITY_PACK_LOAD_TIMEOUT_MS,
} = {}) {
  if (!Number.isInteger(maxActiveTools) || maxActiveTools < 1 || maxActiveTools > 128) {
    throw packError('PACK_BUDGET_INVALID', 'maxActiveTools must be an integer from 1 to 128.');
  }
  if (!Number.isInteger(loadTimeoutMs) || loadTimeoutMs < 1 || loadTimeoutMs > MAX_CAPABILITY_PACK_LOAD_TIMEOUT_MS) {
    throw packError(
      'PACK_LOAD_TIMEOUT_INVALID',
      `loadTimeoutMs must be an integer from 1 to ${MAX_CAPABILITY_PACK_LOAD_TIMEOUT_MS}.`,
    );
  }
  const trustedCatalog = createCapabilityPackCatalog(catalog);
  const publicCatalog = Object.freeze(trustedCatalog.map(publicCapabilityPackManifest));
  const registryRevision = catalogRevision(trustedCatalog);
  const loadCache = new Map();
  const sessions = new Map();
  // Executable pack instances are kept in this private map only after a
  // resolution commits.  Public state and descriptors never contain these
  // functions; invalidation removes the ownership record before any caller
  // can use the old token again.
  const executableSessions = new Map();
  const generations = new Map();
  let nextRevision = 1;

  function beginGeneration(sessionId) {
    const previous = generations.get(sessionId);
    previous?.cancel();
    let resolveCancelled;
    const cancelPromise = new Promise((resolve) => { resolveCancelled = resolve; });
    const context = {
      sessionId,
      generation: (previous?.generation ?? 0) + 1,
      cancelPromise,
      cancelled: false,
      cancel() {
        if (context.cancelled) return;
        context.cancelled = true;
        resolveCancelled({ stale: true });
      },
    };
    generations.set(sessionId, context);
    return context;
  }

  function generationCurrent(context) {
    return generations.get(context.sessionId) === context && context.cancelled === false;
  }

  async function awaitGeneration(promise, context) {
    return Promise.race([
      promise,
      context.cancelPromise,
    ]);
  }

  function selectCandidates(snapshot, options = {}) {
    const location = locationForSnapshot(snapshot);
    if (!location) return [];
    const requestedTokens = new Set(objectiveTokens(options.objective ?? options.objectives));
    return trustedCatalog.map((manifest) => {
      const hint = matchCapabilityPackHints(manifest, location);
      if (!hint) return null;
      const objectiveScore = manifest.hints.objectiveTokens.reduce(
        (score, token) => score + (requestedTokens.has(token) ? 1 : 0),
        0,
      );
      return { manifest, hint, objectiveScore };
    }).filter(Boolean).sort(compareCandidates);
  }

  function loadOnce(manifest) {
    const key = capabilityPackManifestKey(manifest);
    const cached = loadCache.get(key);
    if (cached) return cached.promise;
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const entry = {};
    let timer;
    const operation = Promise.resolve()
      .then(() => manifest.load({ signal: controller?.signal ?? null }))
      .then((loaded) => {
        const pack = validPackObject(loaded);
        return pack ? { ok: true, pack } : { ok: false, code: 'PACK_LOAD_FAILED' };
      })
      .catch(() => ({ ok: false, code: 'PACK_LOAD_FAILED' }));
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => {
        controller?.abort();
        resolve({ ok: false, code: 'PACK_LOAD_TIMEOUT' });
      }, loadTimeoutMs);
    });
    entry.promise = Promise.race([operation, timeout])
      .then((result) => {
        if (!result.ok && loadCache.get(key) === entry) loadCache.delete(key);
        return result;
      })
      .finally(() => clearTimeout(timer));
    loadCache.set(key, entry);
    return entry.promise;
  }

  async function resolveForSnapshot(rawSnapshot, options = {}) {
    const sessionId = normalizeSessionId(options.sessionId);
    const previous = sessions.get(sessionId);
    const generation = beginGeneration(sessionId);
    if (previous) sessions.delete(sessionId);
    executableSessions.delete(sessionId);
    let snapshot;
    try {
      snapshot = createPageSnapshot(rawSnapshot);
    } catch {
      if (!generationCurrent(generation)) {
        return staleResult({ sessionId, registryRevision, maxActiveTools });
      }
      const result = emptyResult({
        sessionId,
        registryRevision,
        maxActiveTools,
        quarantined: [safeFault({ code: 'PACK_SNAPSHOT_INVALID', stage: 'snapshot' })],
      });
      sessions.delete(sessionId);
      executableSessions.delete(sessionId);
      return result;
    }

    const selectedCandidates = selectCandidates(snapshot, options);
    const selected = selectedCandidates.map(publicCandidate);
    const quarantined = [];
    const activePacks = [];
    const tools = [];
    const executionOwners = new Map();
    const toolNames = new Set();

    for (const candidate of selectedCandidates) {
      const { manifest } = candidate;
      const loaded = await awaitGeneration(loadOnce(manifest), generation);
      if (loaded?.stale || !generationCurrent(generation)) {
        return staleResult({ sessionId, snapshot, registryRevision, maxActiveTools });
      }
      if (!loaded.ok) {
        quarantined.push(safeFault({
          code: loaded.code === 'PACK_LOAD_TIMEOUT' ? 'PACK_LOAD_TIMEOUT' : 'PACK_LOAD_FAILED',
          stage: 'load',
          manifest,
        }));
        continue;
      }

      let matches = false;
      try {
        matches = loaded.pack.matches(snapshot) === true;
      } catch {
        quarantined.push(safeFault({ code: 'PACK_MATCH_FAILED', stage: 'matches', manifest }));
        continue;
      }
      if (!matches) continue;

      const descriptors = descriptorsForPack(loaded.pack, snapshot, manifest, quarantined);
      let accepted = 0;
      for (const descriptor of descriptors) {
        if (toolNames.has(descriptor.name)) {
          quarantined.push(safeFault({ code: 'PACK_DESCRIPTOR_DUPLICATE', stage: 'descriptor', manifest }));
          continue;
        }
        if (accepted >= manifest.maxTools || tools.length >= maxActiveTools) {
          quarantined.push(safeFault({ code: 'PACK_TOOL_BUDGET', stage: 'budget', manifest }));
          continue;
        }
        toolNames.add(descriptor.name);
        tools.push(descriptor);
        executionOwners.set(descriptorExecutionKey(descriptor), {
          pack: loaded.pack,
          binding: Object.freeze({
            id: descriptor.adapter.id,
            version: String(descriptor.adapter.version),
          }),
        });
        accepted += 1;
      }
      activePacks.push({ manifest, toolCount: accepted, status: 'active' });
    }

    tools.sort((left, right) => left.name.localeCompare(right.name));
    if (!generationCurrent(generation)) {
      return staleResult({ sessionId, snapshot, registryRevision, maxActiveTools });
    }
    const state = {
      registryRevision,
      sessionId,
      revision: nextRevision++,
      pageFingerprint: snapshot.pageFingerprint,
      snapshotVersion: snapshot.version,
      activePacks,
      quarantined,
      budget: {
        maxActiveTools,
        usedTools: tools.length,
        remainingTools: maxActiveTools - tools.length,
      },
    };
    state.stateToken = tokenForState(state);
    if (!generationCurrent(generation)) {
      return staleResult({ sessionId, snapshot, registryRevision, maxActiveTools });
    }
    sessions.set(sessionId, state);
    executableSessions.set(sessionId, {
      generation,
      stateToken: state.stateToken,
      pageFingerprint: state.pageFingerprint,
      owners: executionOwners,
    });

    return freezeDeep({
      sessionId,
      pageFingerprint: snapshot.pageFingerprint,
      snapshotVersion: snapshot.version,
      registryRevision,
      selected,
      activePacks: activePacks.map((entry) => publicActivePack(entry.manifest, entry.toolCount, entry.status)),
      tools,
      quarantined: quarantined.map((entry) => ({ ...entry })),
      budget: { ...state.budget },
      stateToken: state.stateToken,
      invalidatedPrevious: Boolean(previous),
    });
  }

  function invalidate({ sessionId = 'default' } = {}) {
    const normalized = normalizeSessionId(sessionId);
    const previous = generations.get(normalized);
    previous?.cancel();
    generations.set(normalized, {
      sessionId: normalized,
      generation: (previous?.generation ?? 0) + 1,
      cancelled: true,
      cancel() {},
      cancelPromise: Promise.resolve({ stale: true }),
    });
    executableSessions.delete(normalized);
    return sessions.delete(normalized);
  }

  function isCurrent(stateToken) {
    if (!stateToken || typeof stateToken !== 'object') return false;
    const state = sessions.get(stateToken.sessionId);
    return Boolean(state && sameToken(state.stateToken, stateToken));
  }

  function executeRead(request = {}) {
    if (!isPlainObject(request)) {
      throw packError('PACK_EXECUTION_INVALID', 'Capability pack read execution requires a plain request object.');
    }
    const { sessionId, stateToken, descriptor, snapshot, input = {} } = request;
    if (typeof sessionId !== 'string' || sessionId.trim() !== sessionId || !sessionId) {
      throw packError('PACK_SESSION_INVALID', 'Capability pack read execution requires an exact sessionId.');
    }
    if (!isPlainObject(stateToken) || stateToken.sessionId !== sessionId) {
      throw packError('PACK_SESSION_MISMATCH', 'Capability pack read state does not belong to the requested session.');
    }

    const state = sessions.get(sessionId);
    const execution = executableSessions.get(sessionId);
    if (!state || !execution
      || !generationCurrent(execution.generation)
      || !sameToken(state.stateToken, stateToken)
      || !sameToken(execution.stateToken, stateToken)) {
      throw packError('PACK_STATE_STALE', 'Capability pack read state is stale or no longer executable.');
    }

    let normalizedSnapshot;
    try {
      normalizedSnapshot = createPageSnapshot(snapshot);
    } catch {
      throw packError('PACK_SNAPSHOT_INVALID', 'Capability pack read execution requires a valid page snapshot.');
    }
    if (normalizedSnapshot.pageFingerprint !== state.pageFingerprint
      || normalizedSnapshot.pageFingerprint !== execution.pageFingerprint) {
      throw packError('PACK_PAGE_DRIFT', 'Capability pack read snapshot does not match the committed page.');
    }
    if (!isPlainObject(descriptor)) {
      throw packError('PACK_DESCRIPTOR_INVALID', 'Capability pack read execution requires a plain descriptor.');
    }

    let binding;
    try {
      binding = adapterBindingForPack({
        id: descriptor.adapter?.id,
        version: descriptor.adapter?.version,
      }, { id: descriptor.adapter?.id, version: descriptor.adapter?.version });
    } catch {
      throw packError('PACK_ADAPTER_MISMATCH', 'Capability pack descriptor adapter binding is invalid.');
    }
    if (descriptor.classification !== 'read' || descriptor.kind !== 'read' || descriptor.requiresApproval !== false) {
      throw packError('PACK_DESCRIPTOR_INVALID', 'Capability pack read execution accepts read-only descriptors only.');
    }
    try {
      validateToolDescriptor(descriptor);
      assertDescriptorContract(descriptor, normalizedSnapshot, binding);
    } catch {
      throw packError('PACK_DESCRIPTOR_INVALID', 'Capability pack descriptor is not bound to the committed read contract.');
    }

    const owner = execution.owners.get(descriptorExecutionKey(descriptor));
    if (!owner
      || owner.binding.id !== binding.id
      || owner.binding.version !== binding.version) {
      throw packError('PACK_ADAPTER_MISMATCH', 'Capability pack descriptor is not owned by the committed adapter.');
    }
    if (typeof owner.pack.executeRead !== 'function') {
      throw packError('PACK_EXECUTOR_MISSING', 'The committed capability pack has no read executor.');
    }
    return owner.pack.executeRead(descriptor, normalizedSnapshot, input);
  }

  function getPublicState(sessionId) {
    const states = sessionId === undefined
      ? [...sessions.values()].sort((left, right) => left.sessionId.localeCompare(right.sessionId))
      : (sessions.has(normalizeSessionId(sessionId)) ? [sessions.get(normalizeSessionId(sessionId))] : []);
    return freezeDeep({
      manifestVersion: 1,
      registryRevision,
      maxActiveTools,
      loadTimeoutMs,
      catalog: publicCatalog,
      sessions: states.map(publicStateForSession),
    });
  }

  const registry = {
    catalog: publicCatalog,
    registryRevision,
    maxActiveTools,
    loadTimeoutMs,
    select(rawSnapshot, options = {}) {
      const snapshot = createPageSnapshot(rawSnapshot);
      return Object.freeze(selectCandidates(snapshot, options).map(publicCandidate));
    },
    resolve: resolveForSnapshot,
    resolveForSnapshot,
    loadForSnapshot: resolveForSnapshot,
    activate: resolveForSnapshot,
    invalidate,
    invalidateForDrift: invalidate,
    isCurrent,
    executeRead,
    getPublicState,
  };
  return Object.freeze(registry);
}

export const createUniversalCapabilityPackRegistry = createCapabilityPackRegistry;
