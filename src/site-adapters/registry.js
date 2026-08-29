import { cloneJson, freezeDeep } from '../universal/canonical.js';
import { createPageSnapshot } from '../universal/snapshot.js';
import {
  normalizePostconditionResult,
  POSTCONDITION_STATUSES,
  validatePostconditionContract,
} from '../universal/postconditions.js';
import { validateToolDescriptor } from '../universal/tools.js';

export class SiteAdapterError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'SiteAdapterError';
    this.code = code;
    this.details = details;
  }
}

function validateAdapter(adapter) {
  if (!adapter || typeof adapter !== 'object') throw new TypeError('Site adapter must be an object.');
  if (!/^[A-Za-z0-9_.-]{1,128}$/.test(adapter.id ?? '')) throw new TypeError('Site adapter id is invalid.');
  if (typeof adapter.matches !== 'function' || typeof adapter.generateTools !== 'function') {
    throw new TypeError(`Site adapter ${adapter.id} requires matches() and generateTools().`);
  }
  return Object.freeze({
    id: adapter.id,
    version: String(adapter.version ?? '0'),
    priority: Number.isFinite(adapter.priority) ? Number(adapter.priority) : 0,
    matches: adapter.matches.bind(adapter),
    generateTools: adapter.generateTools.bind(adapter),
    executeRead: typeof adapter.executeRead === 'function' ? adapter.executeRead.bind(adapter) : null,
    verifyPostcondition: typeof adapter.verifyPostcondition === 'function'
      ? adapter.verifyPostcondition.bind(adapter)
      : null,
  });
}

function snapshotOrigin(snapshot) {
  const metadata = snapshot?.metadata ?? {};
  let urlOrigin = '';
  try { urlOrigin = metadata.url ? new URL(metadata.url).origin : ''; } catch { /* invalid URL is handled by the caller */ }
  const declaredOrigin = typeof metadata.origin === 'string' ? metadata.origin : '';
  if (urlOrigin && declaredOrigin && urlOrigin !== declaredOrigin) return null;
  return declaredOrigin || urlOrigin || null;
}

function assertVerifiedRead(tool, adapter, snapshot) {
  const provenance = tool?.provenance;
  if (provenance?.pageFingerprint !== snapshot.pageFingerprint
    || tool?.pageFingerprint !== snapshot.pageFingerprint) {
    throw new SiteAdapterError('ADAPTER_PAGE_DRIFT', 'The verified tool was generated for a different page snapshot.');
  }
  if (tool?.adapter?.id && tool.adapter.id !== adapter.id) {
    throw new SiteAdapterError('ADAPTER_DESCRIPTOR_INVALID', 'The tool adapter binding does not match the selected adapter.');
  }
  if (provenance?.source !== 'toolbraid.verified-adapter'
    || provenance.adapterId !== adapter.id
    || String(provenance.adapterVersion) !== adapter.version
    || provenance.sourceType !== tool?.sourceType
    || tool?.classification !== 'read'
    || tool?.kind !== 'read'
    || tool?.requiresApproval !== false
    || tool?.annotations?.readOnlyHint !== true
    || tool?.effect?.classification !== 'read'
    || tool?.effect?.externalStateChange !== false
    || tool?.effect?.requiresApproval !== false) {
    throw new SiteAdapterError('ADAPTER_DESCRIPTOR_INVALID', 'The verified read descriptor is not bound to its adapter contract.');
  }
}

function normalizeVerifierResult(raw, { contract, beforeSnapshot, afterSnapshot }) {
  const afterPageFingerprint = afterSnapshot.pageFingerprint;
  let candidate = raw;
  if (raw?.status === POSTCONDITION_STATUSES.VERIFIED_SUCCESS
    || raw?.status === POSTCONDITION_STATUSES.VERIFIED_FAILURE) {
    if (raw.afterPageFingerprint !== afterPageFingerprint) {
      candidate = {
        status: POSTCONDITION_STATUSES.UNVERIFIED,
        reasonCode: 'POSTCONDITION_FINGERPRINT_MISMATCH',
      };
    }
  } else if (raw?.status === POSTCONDITION_STATUSES.UNVERIFIED) {
    // The adapter cannot choose which observation is attached to its verdict.
    candidate = { ...raw, afterPageFingerprint };
  }
  try {
    return normalizePostconditionResult(candidate, {
      contract,
      beforeSnapshot,
      afterPageFingerprint,
    });
  } catch (error) {
    return normalizePostconditionResult({
      status: POSTCONDITION_STATUSES.UNVERIFIED,
      reasonCode: error?.code === 'POSTCONDITION_RESULT_INVALID'
        ? 'POSTCONDITION_RESULT_INVALID'
        : 'POSTCONDITION_VERIFIER_FAILED',
      afterPageFingerprint,
    }, {
      contract,
      beforeSnapshot,
      afterPageFingerprint,
    });
  }
}

export function createSiteAdapterRegistry({ adapters = [] } = {}) {
  const ids = new Set();
  const normalized = adapters.map(validateAdapter).sort((left, right) => right.priority - left.priority || left.id.localeCompare(right.id));
  for (const adapter of normalized) {
    if (ids.has(adapter.id)) throw new TypeError(`Duplicate site adapter id: ${adapter.id}`);
    ids.add(adapter.id);
  }

  function matching(snapshot) {
    return normalized.filter((adapter) => adapter.matches(snapshot) === true);
  }

  return Object.freeze({
    adapters: Object.freeze(normalized.map(({ id, version, priority }) => Object.freeze({ id, version, priority }))),
    resolve(rawSnapshot) {
      const snapshot = createPageSnapshot(rawSnapshot);
      return Object.freeze(matching(snapshot).map(({ id, version, priority }) => Object.freeze({ id, version, priority })));
    },
    generateTools(rawSnapshot) {
      const snapshot = createPageSnapshot(rawSnapshot);
      const results = [];
      for (const adapter of matching(snapshot)) {
        let generated;
        try {
          generated = adapter.generateTools(snapshot);
        } catch {
          continue;
        }
        if (!Array.isArray(generated)) continue;
        for (const tool of generated) {
          if (!tool || typeof tool !== 'object' || Array.isArray(tool)) continue;
          try {
            const bound = {
              ...tool,
              adapter: { id: adapter.id, version: adapter.version },
            };
            validateToolDescriptor(bound);
            results.push(freezeDeep(cloneJson(bound)));
          } catch {
            // A malformed adapter output is quarantined at the registry boundary.
          }
        }
      }
      const names = new Set();
      for (const tool of results) {
        if (names.has(tool.name)) throw new SiteAdapterError('ADAPTER_TOOL_DUPLICATE', `Duplicate verified-adapter tool: ${tool.name}`);
        names.add(tool.name);
      }
      return Object.freeze(results);
    },
    executeRead(tool, rawSnapshot, input = {}) {
      const snapshot = createPageSnapshot(rawSnapshot);
      const adapterId = tool?.adapter?.id ?? tool?.provenance?.adapterId;
      const adapter = normalized.find((candidate) => candidate.id === adapterId);
      if (!adapter || !adapter.executeRead) throw new SiteAdapterError('ADAPTER_EXECUTOR_MISSING', 'No verified read executor exists for this tool.');
      if (!adapter.matches(snapshot)) throw new SiteAdapterError('ADAPTER_PAGE_MISMATCH', 'The verified adapter no longer matches the current page.');
      assertVerifiedRead(tool, adapter, snapshot);
      return adapter.executeRead(tool, snapshot, input);
    },
    verifyPostcondition(tool, context = {}) {
      const rawContract = tool?.postcondition;
      if (rawContract === undefined) return null;
      if (!context || typeof context !== 'object' || Array.isArray(context)
        || !Number.isInteger(context.tabId) || context.tabId < 0
        || !Number.isInteger(context.frameId) || context.frameId < 0
        || typeof context.sessionId !== 'string'
        || context.sessionId.length < 8
        || context.sessionId.length > 256) {
        return { status: 'unverified', reasonCode: 'POSTCONDITION_CONTEXT_INVALID' };
      }
      if (context.signal?.aborted) return { status: 'unverified', reasonCode: 'POSTCONDITION_ABORTED' };
      let contract;
      try {
        contract = validatePostconditionContract(rawContract);
      } catch {
        return { status: 'unverified', reasonCode: 'POSTCONDITION_CONTRACT_INVALID' };
      }
      const adapterId = tool?.adapter?.id ?? tool?.provenance?.adapterId;
      const adapter = normalized.find((candidate) => candidate.id === adapterId);
      if (!adapter || !adapter.verifyPostcondition) {
        return { status: 'unverified', reasonCode: 'POSTCONDITION_VERIFIER_UNAVAILABLE' };
      }
      if (tool?.provenance?.source !== 'toolbraid.verified-adapter'
        || tool?.provenance?.adapterId !== adapter.id
        || String(tool?.provenance?.adapterVersion) !== adapter.version
        || tool?.classification !== 'mutate'
        || contract.adapterId !== adapter.id
        || String(contract.adapterVersion) !== adapter.version) {
        return { status: 'unverified', reasonCode: 'POSTCONDITION_ADAPTER_MISMATCH' };
      }
      let beforeSnapshot;
      let afterSnapshot;
      try {
        beforeSnapshot = context.beforeSnapshot ? createPageSnapshot(context.beforeSnapshot) : null;
        afterSnapshot = context.afterSnapshot ? createPageSnapshot(context.afterSnapshot) : null;
      } catch {
        return { status: 'unverified', reasonCode: 'POSTCONDITION_SNAPSHOT_INVALID' };
      }
      if (!beforeSnapshot || !afterSnapshot
        || tool?.provenance?.pageFingerprint !== beforeSnapshot.pageFingerprint
        || tool?.pageFingerprint !== beforeSnapshot.pageFingerprint) {
        return { status: 'unverified', reasonCode: 'POSTCONDITION_PAGE_DRIFT' };
      }
      const beforeOrigin = snapshotOrigin(beforeSnapshot);
      const afterOrigin = snapshotOrigin(afterSnapshot);
      if (!beforeOrigin || !afterOrigin || beforeOrigin !== afterOrigin
        || tool?.provenance?.origin !== beforeOrigin) {
        return { status: 'unverified', reasonCode: 'POSTCONDITION_ORIGIN_MISMATCH' };
      }
      try {
        if (adapter.matches(beforeSnapshot) !== true || adapter.matches(afterSnapshot) !== true) {
          return { status: 'unverified', reasonCode: 'POSTCONDITION_PAGE_MISMATCH' };
        }
      } catch {
        return { status: 'unverified', reasonCode: 'POSTCONDITION_PAGE_MISMATCH' };
      }
      let result;
      try {
        result = adapter.verifyPostcondition({ ...context, tool, contract, beforeSnapshot, afterSnapshot });
      } catch {
        return normalizeVerifierResult(null, { contract, beforeSnapshot, afterSnapshot });
      }
      if (result && typeof result.then === 'function') {
        return result.then((verdict) => context.signal?.aborted
          ? { status: 'unverified', reasonCode: 'POSTCONDITION_ABORTED' }
          : normalizeVerifierResult(verdict, { contract, beforeSnapshot, afterSnapshot }), () =>
          normalizeVerifierResult(null, { contract, beforeSnapshot, afterSnapshot }));
      }
      return context.signal?.aborted
        ? { status: 'unverified', reasonCode: 'POSTCONDITION_ABORTED' }
        : normalizeVerifierResult(result, { contract, beforeSnapshot, afterSnapshot });
    },
  });
}
