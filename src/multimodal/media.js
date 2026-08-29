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
const CAPTURE_BINDING_FIELDS = Object.freeze([
  'pageOrigin',
  'frameId',
  'sessionId',
  'pageFingerprint',
  'documentId',
  'pageInstanceId',
  'elementRef',
]);
const MAX_VIDEO_KEYFRAMES = 12;

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

function plainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function normalizeCaptureBinding(value) {
  if (value === undefined || value === null) return null;
  if (!plainObject(value)) throw new TypeError('asset.captureBinding must be a plain object.');
  const output = {};
  for (const key of CAPTURE_BINDING_FIELDS) {
    const supplied = value[key];
    if (supplied === undefined || supplied === null) continue;
    if (key === 'frameId' && Number.isInteger(supplied) && supplied >= 0) output[key] = String(supplied);
    else output[key] = optionalText(supplied, `asset.captureBinding.${key}`, 2048);
  }
  return Object.keys(output).length ? Object.freeze(output) : null;
}

function normalizeVideoKeyframe(value, pageOrigin, index) {
  if (!plainObject(value)) throw new TypeError('asset.keyframes entries must be plain objects.');
  const frame = normalizeMediaAsset(value, { pageOrigin });
  if (frame.kind !== MEDIA_KIND.IMAGE || frame.source !== 'capture' || !frame.handle || frame.url) {
    throw new TypeError('Video keyframes must be extension-owned captured image handles.');
  }
  return Object.freeze({
    ...frame,
    timeMs: finiteNonNegative(value.timeMs ?? value.timestampMs ?? value.timestamp, `asset.keyframes[${index}].timeMs`, 0),
  });
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

  const elementRef = optionalText(asset.elementRef, 'asset.elementRef', 512);
  const primaryBinding = normalizeCaptureBinding(asset.captureBinding);
  const aliasBinding = normalizeCaptureBinding(asset.binding);
  if (primaryBinding && aliasBinding && stableStringify(primaryBinding) !== stableStringify(aliasBinding)) {
    throw new TypeError('asset capture binding aliases conflict.');
  }
  const captureBinding = primaryBinding ?? aliasBinding;
  if (captureBinding) {
    for (const key of CAPTURE_BINDING_FIELDS) {
      if (asset[key] === undefined || asset[key] === null || captureBinding[key] === undefined) continue;
      const topLevel = normalizeCaptureBinding({ [key]: asset[key] });
      if (topLevel?.[key] !== captureBinding[key]) throw new TypeError(`asset.${key} conflicts with asset.captureBinding.${key}.`);
    }
  }
  if (elementRef) normalized.elementRef = elementRef;
  if (captureBinding) normalized.captureBinding = captureBinding;

  if (kind === MEDIA_KIND.VIDEO) {
    const rawKeyframes = asset.keyframes ?? asset.frames ?? asset.videoEvidence?.keyframes;
    if (rawKeyframes !== undefined && !Array.isArray(rawKeyframes)) throw new TypeError('asset.keyframes must be an array.');
    const keyframes = (rawKeyframes ?? []).slice(0, MAX_VIDEO_KEYFRAMES)
      .map((frame, index) => normalizeVideoKeyframe(frame, normalized.pageOrigin, index));
    if (keyframes.length) normalized.keyframes = Object.freeze(keyframes);

    const rawAudio = asset.audioAsset ?? asset.audio ?? asset.videoEvidence?.audioAsset;
    if (rawAudio !== undefined && rawAudio !== null) {
      const audioAsset = normalizeMediaAsset(rawAudio, { pageOrigin: normalized.pageOrigin });
      if (audioAsset.kind !== MEDIA_KIND.AUDIO || audioAsset.source !== 'capture' || !audioAsset.handle || audioAsset.url) {
        throw new TypeError('Video audio evidence must be an extension-owned captured audio handle.');
      }
      normalized.audioAsset = audioAsset;
    }
  }

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
    elementRef: asset.elementRef ?? null,
    captureBinding: asset.captureBinding ?? null,
    keyframes: Array.isArray(asset.keyframes)
      ? asset.keyframes.map((frame) => ({ fingerprint: frame.fingerprint ?? mediaAssetFingerprint(frame), timeMs: frame.timeMs ?? 0 }))
      : [],
    audioAsset: asset.audioAsset
      ? { fingerprint: asset.audioAsset.fingerprint ?? mediaAssetFingerprint(asset.audioAsset) }
      : null,
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
