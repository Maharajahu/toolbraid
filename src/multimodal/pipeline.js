import {
  evaluateMediaLimits,
  mediaAssetFingerprint,
  mergeMediaLimits,
  normalizeMediaAsset,
} from './media.js';
import { sha256Hex, stableStringify } from '../engine/approval.js';

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function abortError(signal) {
  return signal?.reason instanceof Error
    ? signal.reason
    : new DOMException('Multimodal analysis aborted.', 'AbortError');
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError(signal);
}

function cleanError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[\r\n\t]+/g, ' ').slice(0, 512);
}

function normalizeAdapters(adapters) {
  if (!Array.isArray(adapters)) throw new TypeError('adapters must be an array.');
  const ids = new Set();
  return Object.freeze(adapters.map((adapter) => {
    if (!adapter || typeof adapter !== 'object') throw new TypeError('Each multimodal adapter must be an object.');
    if (!/^[A-Za-z0-9_.-]{1,128}$/.test(adapter.id ?? '')) throw new TypeError('Adapter id is invalid.');
    if (ids.has(adapter.id)) throw new TypeError(`Duplicate multimodal adapter id: ${adapter.id}`);
    ids.add(adapter.id);
    if (typeof adapter.supports !== 'function' || typeof adapter.analyze !== 'function') {
      throw new TypeError(`Adapter ${adapter.id} requires supports() and analyze().`);
    }
    return Object.freeze({
      id: adapter.id,
      version: String(adapter.version ?? '0'),
      priority: Number.isFinite(adapter.priority) ? Number(adapter.priority) : 0,
      supports: adapter.supports.bind(adapter),
      analyze: adapter.analyze.bind(adapter),
    });
  }).sort((left, right) => right.priority - left.priority || left.id.localeCompare(right.id)));
}

function normalizeAnalysis(value, { asset, adapter, startedAt, completedAt }) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`Adapter ${adapter.id} returned an invalid result.`);
  }
  const confidence = value.confidence === undefined || value.confidence === null ? null : Number(value.confidence);
  if (confidence !== null && (!Number.isFinite(confidence) || confidence < 0 || confidence > 1)) {
    throw new TypeError(`Adapter ${adapter.id} returned invalid confidence.`);
  }
  const result = {
    version: 1,
    assetId: asset.id,
    assetFingerprint: asset.fingerprint,
    kind: asset.kind,
    status: 'completed',
    summary: value.summary == null ? null : String(value.summary).slice(0, 32_768),
    text: value.text == null ? null : String(value.text).slice(0, 131_072),
    transcript: value.transcript == null ? null : String(value.transcript).slice(0, 262_144),
    language: value.language == null ? null : String(value.language).slice(0, 64),
    labels: Array.isArray(value.labels) ? value.labels.slice(0, 256).map((entry) => String(entry).slice(0, 512)) : [],
    regions: Array.isArray(value.regions) ? clone(value.regions.slice(0, 512)) : [],
    segments: Array.isArray(value.segments) ? clone(value.segments.slice(0, 4096)) : [],
    keyframes: Array.isArray(value.keyframes) ? clone(value.keyframes.slice(0, 256)) : [],
    warnings: Array.isArray(value.warnings) ? value.warnings.slice(0, 128).map((entry) => String(entry).slice(0, 512)) : [],
    confidence,
    untrustedContent: true,
    provider: Object.freeze({ id: adapter.id, version: adapter.version, model: value.model == null ? null : String(value.model).slice(0, 256) }),
    timing: Object.freeze({ startedAt, completedAt }),
  };
  const { timing: _timing, ...fingerprintProjection } = result;
  result.fingerprint = sha256Hex(stableStringify(fingerprintProjection));
  return Object.freeze(result);
}

function blockedResult(asset, reason, details = {}) {
  return Object.freeze({
    version: 1,
    assetId: asset.id,
    assetFingerprint: asset.fingerprint,
    kind: asset.kind,
    status: 'blocked',
    reason,
    details: clone(details),
    untrustedContent: true,
  });
}

function degradedResult(asset, attempts) {
  return Object.freeze({
    version: 1,
    assetId: asset.id,
    assetFingerprint: asset.fingerprint,
    kind: asset.kind,
    status: 'degraded',
    reason: attempts.length ? 'ADAPTERS_FAILED' : 'NO_SUPPORTED_ADAPTER',
    attempts: Object.freeze(attempts.map((attempt) => Object.freeze({ ...attempt }))),
    untrustedContent: true,
  });
}

async function runPool(items, concurrency, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  async function run() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run));
  return results;
}

export function createMultimodalPipeline({
  adapters = [],
  limits: suppliedLimits = {},
  redact = async (asset) => ({ allowed: true, asset }),
  cache = new Map(),
  concurrency = 2,
  now = () => new Date(),
} = {}) {
  const normalizedAdapters = normalizeAdapters(adapters);
  const limits = mergeMediaLimits(suppliedLimits);
  if (typeof redact !== 'function') throw new TypeError('redact must be a function.');
  if (!cache || typeof cache.get !== 'function' || typeof cache.set !== 'function') throw new TypeError('cache must implement get() and set().');
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) throw new RangeError('concurrency must be between 1 and 8.');

  async function analyzeOne(rawAsset, { signal, context, pageOrigin }) {
    throwIfAborted(signal);
    let asset = normalizeMediaAsset(rawAsset, { pageOrigin });
    const policy = evaluateMediaLimits(asset, limits);
    if (!policy.allowed) return blockedResult(asset, 'MEDIA_LIMIT_EXCEEDED', { violations: policy.violations });

    const redaction = await redact(asset, { signal, context: clone(context) });
    throwIfAborted(signal);
    if (!redaction || redaction.allowed === false) {
      return blockedResult(asset, redaction?.reason ?? 'MEDIA_REDACTION_BLOCKED');
    }
    if (redaction.asset) asset = normalizeMediaAsset(redaction.asset, { pageOrigin });

    const eligible = normalizedAdapters.filter((adapter) => adapter.supports(asset, context) === true);
    const attempts = [];
    for (const adapter of eligible) {
      throwIfAborted(signal);
      const cacheKey = sha256Hex(stableStringify({
        asset: mediaAssetFingerprint(asset),
        adapter: adapter.id,
        adapterVersion: adapter.version,
        context: context?.cacheVary ?? null,
      }));
      const cached = cache.get(cacheKey);
      if (cached) return Object.freeze({ ...clone(cached), cache: Object.freeze({ hit: true, key: cacheKey }) });

      const startedAt = now().toISOString();
      try {
        const rawResult = await adapter.analyze(asset, { signal, context: clone(context) });
        throwIfAborted(signal);
        const result = normalizeAnalysis(rawResult, {
          asset,
          adapter,
          startedAt,
          completedAt: now().toISOString(),
        });
        const stored = Object.freeze({ ...result, cache: Object.freeze({ hit: false, key: cacheKey }) });
        cache.set(cacheKey, clone(stored));
        return stored;
      } catch (error) {
        if (signal?.aborted || error?.name === 'AbortError') throw error;
        attempts.push(Object.freeze({ adapterId: adapter.id, adapterVersion: adapter.version, error: cleanError(error) }));
      }
    }
    return degradedResult(asset, attempts);
  }

  return Object.freeze({
    limits,
    adapters: Object.freeze(normalizedAdapters.map(({ id, version, priority }) => Object.freeze({ id, version, priority }))),
    async analyzeAssets(rawAssets, options = {}) {
      if (!Array.isArray(rawAssets)) throw new TypeError('assets must be an array.');
      if (rawAssets.length > limits.maxAssets) throw new RangeError(`Media asset count exceeds ${limits.maxAssets}.`);
      throwIfAborted(options.signal);
      const results = await runPool(rawAssets, concurrency, (asset) => analyzeOne(asset, options));
      return Object.freeze({
        version: 1,
        generatedAt: now().toISOString(),
        results: Object.freeze(results),
        stats: Object.freeze({
          total: results.length,
          completed: results.filter((entry) => entry.status === 'completed').length,
          blocked: results.filter((entry) => entry.status === 'blocked').length,
          degraded: results.filter((entry) => entry.status === 'degraded').length,
        }),
      });
    },
  });
}

export function createDeterministicMultimodalAdapter({
  id = 'deterministic',
  version = '1',
  kinds = ['image', 'audio', 'video'],
  priority = 0,
  analyze,
} = {}) {
  const supported = new Set(kinds);
  return Object.freeze({
    id,
    version,
    priority,
    supports(asset) {
      return supported.has(asset.kind);
    },
    async analyze(asset, options) {
      if (typeof analyze === 'function') return analyze(asset, options);
      return {
        summary: `${asset.kind} asset ${asset.id}`,
        text: asset.altText ?? asset.caption ?? null,
        model: 'deterministic-fixture',
        confidence: asset.altText || asset.caption ? 0.5 : 0,
      };
    },
  });
}
