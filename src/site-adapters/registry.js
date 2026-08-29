import { createPageSnapshot } from '../universal/snapshot.js';

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
  });
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
      const results = matching(snapshot).flatMap((adapter) => adapter.generateTools(snapshot).map((tool) => Object.freeze({
        ...tool,
        adapter: Object.freeze({ id: adapter.id, version: adapter.version }),
      })));
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
  });
}
