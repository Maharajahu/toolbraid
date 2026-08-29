import { sha256Hex, stableStringify } from '../engine/approval.js';

export const MEDIA_KIND = Object.freeze({
  IMAGE: 'image',
  AUDIO: 'audio',
  VIDEO: 'video',
});

export const DEFAULT_MEDIA_LIMITS = Object.freeze({
  maxAssets: 24,
  image: Object.freeze({ maxBytes: 15 * 1024 * 1024, maxDurationMs: 0 }),
  audio: Object.freeze({ maxBytes: 25 * 1024 * 1024, maxDurationMs: 15 * 60 * 1000 }),
  video: Object.freeze({ maxBytes: 100 * 1024 * 1024, maxDurationMs: 10 * 60 * 1000 }),
});

const KIND_VALUES = new Set(Object.values(MEDIA_KIND));
const SOURCE_VALUES = new Set(['dom', 'capture', 'upload', 'adapter']);

function finiteNonNegative(value, field, fallback = null) {
  if (value === undefined || value === null) return fallback;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new TypeError(`${field} must be a finite non-negative number.`);
  return number;
}

function optionalText(value, field, maxLength = 4096) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw new TypeError(`${field} must be a string.`);
  const normalized = value.normalize('NFC').trim();
  if (normalized.length > maxLength) throw new RangeError(`${field} exceeds ${maxLength} characters.`);
  return normalized || null;
}

function normalizeUrl(value) {
  const text = optionalText(value, 'asset.url', 8192);
  if (!text) return null;
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new TypeError('asset.url must be an absolute URL.');
  }
  if (!['https:', 'http:', 'blob:', 'data:'].includes(url.protocol)) {
    throw new TypeError(`Unsupported media URL protocol: ${url.protocol}`);
  }
  if (url.username || url.password) throw new TypeError('Media URLs must not contain credentials.');
  return url.href;
}

function inferKind(mimeType) {
  if (mimeType?.startsWith('image/')) return MEDIA_KIND.IMAGE;
  if (mimeType?.startsWith('audio/')) return MEDIA_KIND.AUDIO;
  if (mimeType?.startsWith('video/')) return MEDIA_KIND.VIDEO;
  return null;
}

function normalizeKind(value, mimeType) {
  const kind = value ?? inferKind(mimeType);
  if (!KIND_VALUES.has(kind)) throw new TypeError(`Unsupported media kind: ${kind ?? ''}`);
  return kind;
}

export function normalizeMediaAsset(asset, { pageOrigin = null } = {}) {
  if (!asset || typeof asset !== 'object' || Array.isArray(asset)) throw new TypeError('Media asset must be an object.');
  const mimeType = optionalText(asset.mimeType, 'asset.mimeType', 256)?.toLowerCase() ?? null;
  const kind = normalizeKind(asset.kind, mimeType);
  const source = asset.source ?? 'dom';
  if (!SOURCE_VALUES.has(source)) throw new TypeError(`Unsupported media source: ${source}`);
  const url = normalizeUrl(asset.url);
  const handle = optionalText(asset.handle, 'asset.handle', 512);
  if (!url && !handle) throw new TypeError('Media asset requires an absolute url or an extension-owned handle.');

  const normalized = {
    version: 1,
    id: optionalText(asset.id, 'asset.id', 512) ?? null,
    kind,
    source,
    url,
    handle,
    mimeType,
    byteLength: finiteNonNegative(asset.byteLength, 'asset.byteLength'),
    durationMs: finiteNonNegative(asset.durationMs, 'asset.durationMs'),
    width: finiteNonNegative(asset.width, 'asset.width'),
    height: finiteNonNegative(asset.height, 'asset.height'),
    altText: optionalText(asset.altText, 'asset.altText'),
    caption: optionalText(asset.caption, 'asset.caption'),
    pageOrigin: optionalText(asset.pageOrigin ?? pageOrigin, 'asset.pageOrigin', 2048),
    frameId: optionalText(asset.frameId, 'asset.frameId', 512),
    crossOrigin: Boolean(asset.crossOrigin),
    sensitive: Boolean(asset.sensitive),
  };

  normalized.fingerprint = mediaAssetFingerprint(normalized);
  if (!normalized.id) normalized.id = `media-${normalized.fingerprint.slice(0, 16)}`;
  return Object.freeze(normalized);
}

export function mediaAssetFingerprint(asset) {
  const projection = {
    version: asset.version ?? 1,
    kind: asset.kind,
    source: asset.source,
    url: asset.url ?? null,
    handle: asset.handle ?? null,
    mimeType: asset.mimeType ?? null,
    byteLength: asset.byteLength ?? null,
    durationMs: asset.durationMs ?? null,
    width: asset.width ?? null,
    height: asset.height ?? null,
    pageOrigin: asset.pageOrigin ?? null,
    frameId: asset.frameId ?? null,
  };
  return sha256Hex(stableStringify(projection));
}

export function mergeMediaLimits(overrides = {}) {
  const maxAssets = overrides.maxAssets ?? DEFAULT_MEDIA_LIMITS.maxAssets;
  if (!Number.isInteger(maxAssets) || maxAssets < 1 || maxAssets > 256) {
    throw new RangeError('maxAssets must be an integer between 1 and 256.');
  }
  const merged = { maxAssets };
  for (const kind of KIND_VALUES) {
    const supplied = overrides[kind] ?? {};
    const defaults = DEFAULT_MEDIA_LIMITS[kind];
    merged[kind] = Object.freeze({
      maxBytes: finiteNonNegative(supplied.maxBytes, `${kind}.maxBytes`, defaults.maxBytes),
      maxDurationMs: finiteNonNegative(supplied.maxDurationMs, `${kind}.maxDurationMs`, defaults.maxDurationMs),
    });
  }
  return Object.freeze(merged);
}

export function evaluateMediaLimits(asset, limits = DEFAULT_MEDIA_LIMITS) {
  const policy = limits[asset.kind];
  const violations = [];
  if (asset.byteLength !== null && asset.byteLength > policy.maxBytes) {
    violations.push(Object.freeze({ code: 'MEDIA_BYTES_EXCEEDED', observed: asset.byteLength, allowed: policy.maxBytes }));
  }
  if (policy.maxDurationMs > 0 && asset.durationMs !== null && asset.durationMs > policy.maxDurationMs) {
    violations.push(Object.freeze({ code: 'MEDIA_DURATION_EXCEEDED', observed: asset.durationMs, allowed: policy.maxDurationMs }));
  }
  return Object.freeze({ allowed: violations.length === 0, violations: Object.freeze(violations) });
}
