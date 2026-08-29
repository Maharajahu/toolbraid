import {
  DEFAULT_MEDIA_LIMITS,
  MEDIA_KIND,
  mergeMediaLimits,
  normalizeMediaAsset,
} from './media.js';
import { sha256Hex } from '../engine/approval.js';

/**
 * Browser capture is deliberately a small, dependency-injected boundary. It
 * can be used from an MV3 content/service runtime, but it never needs host
 * permissions, privileged inspection, or a model/network adapter of its own.
 */
export const DEFAULT_BROWSER_CAPTURE_LIMITS = Object.freeze({
  maxAssets: DEFAULT_MEDIA_LIMITS.maxAssets,
  maxCaptionTracks: 24,
  maxCaptionBytes: 512 * 1024,
  maxStoredBytes: 64 * 1024 * 1024,
  maxHandles: 24,
  handleTtlMs: 2 * 60 * 1000,
  requestTimeoutMs: 15 * 1000,
  image: DEFAULT_MEDIA_LIMITS.image,
  audio: DEFAULT_MEDIA_LIMITS.audio,
  video: DEFAULT_MEDIA_LIMITS.video,
});

const HTTP_PROTOCOLS = new Set(['http:', 'https:']);
const MEDIA_TAGS = new Set(['img', 'image', 'audio', 'video']);
const CAPTION_KINDS = new Set(['captions', 'subtitles', 'caption', 'subtitle']);
const SAFE_CAPTION_TYPES = new Set([
  'application/ttml+xml',
  'application/xml',
  'application/x-subrip',
  'text/plain',
  'text/srt',
  'text/vtt',
  'text/xml',
]);
const SAFE_MEDIA_MIME_PREFIX = Object.freeze({
  image: 'image/',
  audio: 'audio/',
  video: 'video/',
});

function own(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function cloneJson(value) {
  if (value === undefined) return undefined;
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function cleanText(value, maxLength = 4096) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') return null;
  const normalized = value.normalize('NFC').trim();
  return normalized ? normalized.slice(0, maxLength) : null;
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function nonNegativeNumber(value) {
  const number = finiteNumber(value);
  return number === null || number < 0 ? null : number;
}

function nowMilliseconds(now) {
  const value = typeof now === 'function' ? now() : now;
  if (value instanceof Date) return value.getTime();
  const number = Number(value);
  if (!Number.isFinite(number)) throw new TypeError('now must return a finite timestamp.');
  return number;
}

function abortError(reason = null) {
  if (reason instanceof Error) return reason;
  if (typeof DOMException === 'function') return new DOMException('Browser media capture aborted.', 'AbortError');
  const error = new Error('Browser media capture aborted.');
  error.name = 'AbortError';
  error.code = 'CAPTURE_ABORTED';
  return error;
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError(signal.reason);
}

function timeoutError() {
  const error = new BrowserMediaCaptureError('CAPTURE_TIMEOUT', 'Browser media capture timed out.');
  error.name = 'TimeoutError';
  return error;
}

function normalizeOrigin(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (!HTTP_PROTOCOLS.has(parsed.protocol) || parsed.username || parsed.password) return null;
  return parsed.origin;
}

function resolvePageLocation(documentRef, locationRef) {
  const candidate = locationRef ?? documentRef?.location ?? globalThis.location;
  const href = typeof candidate === 'string' ? candidate : candidate?.href;
  const origin = normalizeOrigin(candidate?.origin ?? href);
  if (!origin || typeof href !== 'string') {
    throw new BrowserMediaCaptureError('PAGE_ORIGIN_UNAVAILABLE', 'A canonical HTTP(S) page origin is required.');
  }
  let parsed;
  try {
    parsed = new URL(href);
  } catch {
    throw new BrowserMediaCaptureError('PAGE_URL_INVALID', 'The active page URL is invalid.');
  }
  if (!HTTP_PROTOCOLS.has(parsed.protocol) || parsed.origin !== origin) {
    throw new BrowserMediaCaptureError('PAGE_ORIGIN_UNAVAILABLE', 'The active page must use a canonical HTTP(S) origin.');
  }
  return Object.freeze({ href: parsed.href, origin });
}

function resolveUrl(value, baseHref) {
  if (typeof value !== 'string' || !value.trim()) return null;
  let parsed;
  try {
    parsed = new URL(value.trim(), baseHref);
  } catch {
    return null;
  }
  if (!HTTP_PROTOCOLS.has(parsed.protocol) || parsed.username || parsed.password) return null;
  return parsed;
}

function normalizeAllowedOrigins(allowedOrigins) {
  if (allowedOrigins === undefined || allowedOrigins === null) return new Set();
  if (!Array.isArray(allowedOrigins) && !(allowedOrigins instanceof Set)) {
    throw new TypeError('allowedOrigins must be an array or Set of HTTP(S) origins.');
  }
  const origins = new Set();
  for (const value of allowedOrigins) {
    const origin = normalizeOrigin(value);
    if (!origin) throw new TypeError('allowedOrigins contains an invalid origin.');
    origins.add(origin);
  }
  return origins;
}

function originDecision(url, pageOrigin, allowedOrigins, originPolicy, context = {}) {
  if (!url || !HTTP_PROTOCOLS.has(url.protocol)) {
    return Object.freeze({ allowed: false, code: 'MEDIA_URL_PROTOCOL_BLOCKED' });
  }
  if (url.username || url.password) {
    return Object.freeze({ allowed: false, code: 'MEDIA_URL_CREDENTIALS_BLOCKED' });
  }
  if (url.origin === pageOrigin) {
    return Object.freeze({ allowed: true, crossOrigin: false, mode: 'same-origin' });
  }
  let explicitlyAllowed = allowedOrigins.has(url.origin);
  if (typeof originPolicy === 'function') {
    let result;
    try {
      result = originPolicy(url.origin, { ...context, pageOrigin, url: url.href });
    } catch {
      result = false;
    }
    explicitlyAllowed = result === true || (isRecord(result) && result.allowed === true);
  }
  if (!explicitlyAllowed) {
    return Object.freeze({ allowed: false, code: 'MEDIA_CROSS_ORIGIN_BLOCKED', crossOrigin: true });
  }
  return Object.freeze({ allowed: true, crossOrigin: true, mode: 'cors' });
}

function readAttribute(element, name) {
  if (!element) return null;
  try {
    if (typeof element.getAttribute === 'function') {
      const value = element.getAttribute(name);
      if (value !== null && value !== undefined) return String(value);
    }
  } catch {
    return null;
  }
  const value = element[name];
  return value === undefined || value === null ? null : String(value);
}

function toArray(value) {
  if (!value) return [];
  try {
    return Array.from(value);
  } catch {
    return [];
  }
}

function elementTagName(element) {
  return String(element?.localName ?? element?.tagName ?? '').toLowerCase();
}

function childElements(element) {
  if (!element) return [];
  if (element.children) return toArray(element.children);
  if (typeof element.querySelectorAll === 'function') {
    try {
      return toArray(element.querySelectorAll(':scope > *'));
    } catch {
      return [];
    }
  }
  return [];
}

function descendants(element, selector) {
  if (!element || typeof element.querySelectorAll !== 'function') return [];
  try {
    return toArray(element.querySelectorAll(selector));
  } catch {
    return [];
  }
}

function firstFiniteDimension(element, names) {
  for (const name of names) {
    const value = nonNegativeNumber(element?.[name]);
    if (value !== null) return value;
  }
  return null;
}

function figureCaption(element) {
  let current = element;
  for (let depth = 0; current && depth < 8; depth += 1) {
    if (elementTagName(current) === 'figure') {
      const caption = descendants(current, 'figcaption')[0];
      return cleanText(caption?.textContent, 2048);
    }
    current = current.parentElement ?? null;
  }
  return null;
}

function mediaMime(element, sourceElement = null) {
  return cleanText(
    readAttribute(sourceElement ?? element, 'type')
      || element?.type
      || null,
    256,
  )?.toLowerCase() ?? null;
}

function mediaDurationMs(element) {
  const seconds = nonNegativeNumber(element?.duration);
  if (seconds === null || !Number.isFinite(seconds) || seconds === Infinity) return null;
  const milliseconds = seconds * 1000;
  return Number.isSafeInteger(milliseconds) ? milliseconds : null;
}

function sourceCandidates(element, baseHref) {
  const candidates = [];
  const direct = readAttribute(element, 'currentSrc') || readAttribute(element, 'src');
  if (direct) candidates.push({ raw: direct, type: mediaMime(element), element });
  for (const source of childElements(element)) {
    if (elementTagName(source) !== 'source') continue;
    const raw = readAttribute(source, 'src');
    if (raw) candidates.push({ raw, type: mediaMime(element, source), element: source });
  }
  return candidates.map((candidate) => {
    const url = resolveUrl(candidate.raw, baseHref);
    return Object.freeze({
      url: url?.href ?? null,
      origin: url?.origin ?? null,
      type: candidate.type,
      element: candidate.element,
    });
  });
}

function trackRecords(element, baseHref, pageOrigin, allowedOrigins, originPolicy) {
  return descendants(element, 'track').map((track) => {
    const rawKind = cleanText(readAttribute(track, 'kind'), 64)?.toLowerCase() ?? '';
    const raw = readAttribute(track, 'src');
    const url = resolveUrl(raw, baseHref);
    const decision = url
      ? originDecision(url, pageOrigin, allowedOrigins, originPolicy, { kind: 'caption' })
      : { allowed: false, code: 'CAPTION_URL_INVALID' };
    return Object.freeze({
      kind: rawKind || 'subtitles',
      url: url?.href ?? null,
      origin: url?.origin ?? null,
      language: cleanText(readAttribute(track, 'srclang'), 64),
      label: cleanText(readAttribute(track, 'label'), 256),
      allowed: decision.allowed,
      blockedReason: decision.allowed ? null : decision.code,
      crossOrigin: Boolean(url && url.origin !== pageOrigin),
    });
  }).filter((track) => CAPTION_KINDS.has(track.kind) || track.kind === '');
}

function normalizeLimits(supplied = {}) {
  if (!isRecord(supplied)) throw new TypeError('Browser capture limits must be an object.');
  const mediaLimits = mergeMediaLimits(supplied.media ?? supplied);
  const integer = (name, fallback, min, max) => {
    const value = supplied[name] ?? fallback;
    if (!Number.isInteger(value) || value < min || value > max) {
      throw new RangeError(`${name} must be an integer between ${min} and ${max}.`);
    }
    return value;
  };
  const positive = (name, fallback, max) => {
    const value = supplied[name] ?? fallback;
    if (!Number.isFinite(value) || value <= 0 || value > max) {
      throw new RangeError(`${name} must be a finite positive number no greater than ${max}.`);
    }
    return value;
  };
  const maxAssets = integer('maxAssets', mediaLimits.maxAssets, 1, 256);
  return Object.freeze({
    ...mediaLimits,
    maxAssets,
    maxCaptionTracks: integer('maxCaptionTracks', DEFAULT_BROWSER_CAPTURE_LIMITS.maxCaptionTracks, 1, 256),
    maxCaptionBytes: positive('maxCaptionBytes', DEFAULT_BROWSER_CAPTURE_LIMITS.maxCaptionBytes, 16 * 1024 * 1024),
    maxStoredBytes: positive('maxStoredBytes', DEFAULT_BROWSER_CAPTURE_LIMITS.maxStoredBytes, 512 * 1024 * 1024),
    maxHandles: integer('maxHandles', DEFAULT_BROWSER_CAPTURE_LIMITS.maxHandles, 1, 256),
    handleTtlMs: positive('handleTtlMs', DEFAULT_BROWSER_CAPTURE_LIMITS.handleTtlMs, 24 * 60 * 60 * 1000),
    requestTimeoutMs: positive('requestTimeoutMs', DEFAULT_BROWSER_CAPTURE_LIMITS.requestTimeoutMs, 10 * 60 * 1000),
  });
}

function randomHandle(randomSource) {
  if (randomSource && typeof randomSource.randomUUID === 'function') {
    return `tb-media-${randomSource.randomUUID()}`;
  }
  if (!randomSource || typeof randomSource.getRandomValues !== 'function') {
    throw new BrowserMediaCaptureError('SECURE_RANDOM_UNAVAILABLE', 'Secure randomness is required for media handles.');
  }
  const bytes = new Uint8Array(24);
  randomSource.getRandomValues(bytes);
  const value = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `tb-media-${value}`;
}

function asBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  throw new TypeError('Media bytes must be an ArrayBuffer or typed array.');
}

/**
 * Extension-owned volatile media bytes. The store intentionally has no
 * persistence dependency and zeroes its own byte arrays when entries leave.
 */
export class InMemoryMediaHandleStore {
  constructor({
    maxBytes = DEFAULT_BROWSER_CAPTURE_LIMITS.maxStoredBytes,
    maxHandles = DEFAULT_BROWSER_CAPTURE_LIMITS.maxHandles,
    ttlMs = DEFAULT_BROWSER_CAPTURE_LIMITS.handleTtlMs,
    now = () => Date.now(),
    randomSource = globalThis.crypto,
  } = {}) {
    if (!Number.isFinite(maxBytes) || maxBytes <= 0) throw new RangeError('maxBytes must be positive.');
    if (!Number.isInteger(maxHandles) || maxHandles < 1) throw new RangeError('maxHandles must be a positive integer.');
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new RangeError('ttlMs must be positive.');
    if (typeof now !== 'function') throw new TypeError('now must be a function.');
    this.maxBytes = maxBytes;
    this.maxHandles = maxHandles;
    this.ttlMs = ttlMs;
    this.now = now;
    this.randomSource = randomSource;
    this.entries = new Map();
    this.totalBytes = 0;
  }

  purgeExpired() {
    const current = nowMilliseconds(this.now);
    for (const [handle, entry] of this.entries) {
      if (current >= entry.expiresAt) this.delete(handle);
    }
    return this;
  }

  put(bytes, metadata = {}) {
    const source = asBytes(bytes);
    const length = source.byteLength;
    if (length > this.maxBytes) {
      throw new BrowserMediaCaptureError('MEDIA_HANDLE_BYTES_EXCEEDED', 'Media bytes exceed the in-memory store limit.', {
        observed: length,
        allowed: this.maxBytes,
      });
    }
    if (!isRecord(metadata)) throw new TypeError('Media handle metadata must be a plain object.');
    this.purgeExpired();
    if (this.entries.size >= this.maxHandles || this.totalBytes + length > this.maxBytes) {
      throw new BrowserMediaCaptureError('MEDIA_HANDLE_LIMIT', 'The in-memory media handle limit has been reached.', {
        maxHandles: this.maxHandles,
        maxBytes: this.maxBytes,
      });
    }
    let handle = null;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const candidate = randomHandle(this.randomSource);
      if (!this.entries.has(candidate)) {
        handle = candidate;
        break;
      }
    }
    if (!handle) {
      throw new BrowserMediaCaptureError('MEDIA_HANDLE_COLLISION', 'A unique media handle could not be allocated.');
    }
    const copy = new Uint8Array(length);
    copy.set(source);
    const createdAt = nowMilliseconds(this.now);
    const entry = {
      handle,
      bytes: copy,
      metadata: cloneJson(metadata),
      byteLength: length,
      createdAt,
      expiresAt: createdAt + this.ttlMs,
    };
    this.entries.set(handle, entry);
    this.totalBytes += length;
    return Object.freeze({
      handle,
      byteLength: length,
      createdAt,
      expiresAt: entry.expiresAt,
      metadata: cloneJson(entry.metadata),
    });
  }

  get(handle) {
    if (typeof handle !== 'string' || !handle.startsWith('tb-media-')) return null;
    this.purgeExpired();
    const entry = this.entries.get(handle);
    if (!entry) return null;
    return Object.freeze({
      handle,
      bytes: new Uint8Array(entry.bytes),
      byteLength: entry.byteLength,
      createdAt: entry.createdAt,
      expiresAt: entry.expiresAt,
      metadata: cloneJson(entry.metadata),
    });
  }

  has(handle) {
    return this.get(handle) !== null;
  }

  delete(handle) {
    const entry = this.entries.get(handle);
    if (!entry) return false;
    entry.bytes.fill(0);
    this.entries.delete(handle);
    this.totalBytes -= entry.byteLength;
    return true;
  }

  release(handle) {
    return this.delete(handle);
  }

  resolve(handle) {
    return this.get(handle);
  }

  clear() {
    for (const handle of [...this.entries.keys()]) this.delete(handle);
    return this;
  }

  stats() {
    this.purgeExpired();
    return Object.freeze({ handles: this.entries.size, bytes: this.totalBytes, maxHandles: this.maxHandles, maxBytes: this.maxBytes });
  }
}

export function createMediaHandleStore(options = {}) {
  return new InMemoryMediaHandleStore(options);
}

function makeLinkedSignal(externalSignal, timeoutMs, setTimeoutRef, clearTimeoutRef) {
  const controller = new AbortController();
  let timeoutId = null;
  let removeExternal = null;
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort(externalSignal.reason);
    else {
      const onAbort = () => controller.abort(externalSignal.reason);
      externalSignal.addEventListener?.('abort', onAbort, { once: true });
      removeExternal = () => externalSignal.removeEventListener?.('abort', onAbort);
    }
  }
  if (!controller.signal.aborted) {
    timeoutId = setTimeoutRef(() => controller.abort(timeoutError()), timeoutMs);
  }
  return {
    signal: controller.signal,
    dispose() {
      if (timeoutId !== null) clearTimeoutRef(timeoutId);
      removeExternal?.();
    },
  };
}

function responseHeader(response, name) {
  try {
    return response?.headers?.get?.(name) ?? null;
  } catch {
    return null;
  }
}

function responseOk(response) {
  return response && (response.ok === true || (response.status >= 200 && response.status < 300));
}

function responseUrl(response, requestedUrl) {
  const value = typeof response?.url === 'string' && response.url ? response.url : requestedUrl;
  return resolveUrl(value, requestedUrl);
}

function assertResponseOrigin(response, requestedUrl, pageOrigin, allowedOrigins, originPolicy, context) {
  const finalUrl = responseUrl(response, requestedUrl);
  const decision = originDecision(finalUrl, pageOrigin, allowedOrigins, originPolicy, context);
  if (!decision.allowed) {
    throw new BrowserMediaCaptureError('MEDIA_REDIRECT_ORIGIN_BLOCKED', 'The media response origin is not allowed.', {
      requestedUrl,
      responseUrl: finalUrl?.href ?? null,
      reason: decision.code,
    });
  }
  return { finalUrl, decision };
}

function assertContentLength(response, maxBytes) {
  const value = responseHeader(response, 'content-length');
  if (value === null || value === '') return null;
  const length = Number(value);
  if (!Number.isSafeInteger(length) || length < 0) {
    throw new BrowserMediaCaptureError('MEDIA_LENGTH_INVALID', 'The media response declared an invalid content length.');
  }
  if (length > maxBytes) {
    throw new BrowserMediaCaptureError('MEDIA_BYTES_EXCEEDED', 'The media response exceeds its bounded byte limit.', {
      observed: length,
      allowed: maxBytes,
    });
  }
  return length;
}

function assertMime(response, kind, suppliedMime = null) {
  const header = cleanText(responseHeader(response, 'content-type'), 256)?.split(';', 1)[0].toLowerCase() ?? null;
  const mimeType = header || cleanText(suppliedMime, 256)?.toLowerCase() || null;
  if (header && !header.startsWith(SAFE_MEDIA_MIME_PREFIX[kind])) {
    throw new BrowserMediaCaptureError('MEDIA_MIME_BLOCKED', 'The media response MIME type is not allowed.', { kind, mimeType: header });
  }
  if (mimeType && !mimeType.startsWith(SAFE_MEDIA_MIME_PREFIX[kind])) {
    throw new BrowserMediaCaptureError('MEDIA_MIME_MISMATCH', 'The media MIME type does not match its media kind.', { kind, mimeType });
  }
  return mimeType;
}

async function readResponseBytes(response, maxBytes, signal) {
  throwIfAborted(signal);
  const declaredLength = assertContentLength(response, maxBytes);
  if (response?.body?.getReader) {
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    try {
      while (true) {
        throwIfAborted(signal);
        const result = await reader.read();
        if (result.done) break;
        const chunk = asBytes(result.value);
        total += chunk.byteLength;
        if (total > maxBytes) {
          await reader.cancel?.();
          throw new BrowserMediaCaptureError('MEDIA_BYTES_EXCEEDED', 'The media response exceeded its bounded byte limit.', {
            observed: total,
            allowed: maxBytes,
          });
        }
        chunks.push(new Uint8Array(chunk));
      }
    } finally {
      reader.releaseLock?.();
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    if (declaredLength !== null && total !== declaredLength) {
      bytes.fill(0);
      throw new BrowserMediaCaptureError('MEDIA_LENGTH_MISMATCH', 'The media response length did not match its declaration.');
    }
    return bytes;
  }
  if (typeof response?.arrayBuffer === 'function') {
    const buffer = await response.arrayBuffer();
    const bytes = asBytes(buffer);
    if (bytes.byteLength > maxBytes) {
      throw new BrowserMediaCaptureError('MEDIA_BYTES_EXCEEDED', 'The media response exceeded its bounded byte limit.', {
        observed: bytes.byteLength,
        allowed: maxBytes,
      });
    }
    if (declaredLength !== null && bytes.byteLength !== declaredLength) {
      throw new BrowserMediaCaptureError('MEDIA_LENGTH_MISMATCH', 'The media response length did not match its declaration.');
    }
    return new Uint8Array(bytes);
  }
  if (typeof response?.text === 'function') {
    const text = await response.text();
    const bytes = new TextEncoder().encode(String(text));
    if (bytes.byteLength > maxBytes) {
      bytes.fill(0);
      throw new BrowserMediaCaptureError('MEDIA_BYTES_EXCEEDED', 'The media response exceeded its bounded byte limit.', {
        observed: bytes.byteLength,
        allowed: maxBytes,
      });
    }
    if (declaredLength !== null && bytes.byteLength !== declaredLength) {
      bytes.fill(0);
      throw new BrowserMediaCaptureError('MEDIA_LENGTH_MISMATCH', 'The media response length did not match its declaration.');
    }
    return bytes;
  }
  throw new BrowserMediaCaptureError('MEDIA_BODY_UNAVAILABLE', 'The media response did not provide a readable body.');
}

async function readResponseText(response, maxBytes, signal) {
  const bytes = await readResponseBytes(response, maxBytes, signal);
  try {
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  } finally {
    bytes.fill(0);
  }
}

function decodeBase64(value) {
  const normalized = value.replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(normalized) || normalized.length % 4 === 1) {
    throw new BrowserMediaCaptureError('SCREENSHOT_DATA_INVALID', 'The screenshot data was not valid base64.');
  }
  if (typeof atob === 'function') {
    const binary = atob(normalized);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  }
  throw new BrowserMediaCaptureError('SCREENSHOT_DECODER_UNAVAILABLE', 'A base64 decoder is unavailable.');
}

function decodeDataUrl(dataUrl, maxBytes) {
  if (typeof dataUrl !== 'string') throw new BrowserMediaCaptureError('SCREENSHOT_DATA_INVALID', 'captureVisibleTab did not return a data URL.');
  const match = /^data:([^;,]+)(;base64)?,([\s\S]*)$/i.exec(dataUrl);
  if (!match || !match[1].toLowerCase().startsWith('image/')) {
    throw new BrowserMediaCaptureError('SCREENSHOT_DATA_INVALID', 'Only image data URLs are accepted for screenshots.');
  }
  const mimeType = match[1].toLowerCase();
  const encoded = match[3];
  let bytes;
  if (match[2]) {
    if (encoded.length > Math.ceil(maxBytes / 3) * 4 + 8) {
      throw new BrowserMediaCaptureError('MEDIA_BYTES_EXCEEDED', 'The screenshot exceeds its bounded byte limit.', { allowed: maxBytes });
    }
    bytes = decodeBase64(encoded);
  } else {
    let decoded;
    try {
      decoded = decodeURIComponent(encoded);
    } catch {
      throw new BrowserMediaCaptureError('SCREENSHOT_DATA_INVALID', 'The screenshot data URL encoding was invalid.');
    }
    bytes = new TextEncoder().encode(decoded);
  }
  if (bytes.byteLength > maxBytes) {
    throw new BrowserMediaCaptureError('MEDIA_BYTES_EXCEEDED', 'The screenshot exceeds its bounded byte limit.', {
      observed: bytes.byteLength,
      allowed: maxBytes,
    });
  }
  return { bytes, mimeType };
}

function parseTimestamp(value) {
  const normalized = String(value).trim().replace(',', '.');
  const parts = normalized.split(':');
  if (parts.length < 2 || parts.length > 3) return null;
  const secondsPart = Number(parts.pop());
  const minutes = Number(parts.pop());
  const hours = parts.length ? Number(parts.pop()) : 0;
  if (![hours, minutes, secondsPart].every(Number.isFinite) || hours < 0 || minutes < 0 || secondsPart < 0 || minutes >= 60 || secondsPart >= 60) return null;
  return Math.round((hours * 3600 + minutes * 60 + secondsPart) * 1000);
}

function parseWebVtt(text, maxCues = 4096) {
  const lines = String(text).replace(/^\uFEFF/, '').split(/\r?\n/);
  const cues = [];
  let index = 0;
  while (index < lines.length && !lines[index].includes('-->')) {
    index += 1;
  }
  while (index < lines.length && cues.length < maxCues) {
    let identifier = null;
    let timing = lines[index]?.trim() ?? '';
    if (!timing.includes('-->')) {
      identifier = cleanText(timing, 256);
      index += 1;
      timing = lines[index]?.trim() ?? '';
    }
    if (!timing.includes('-->')) {
      index += 1;
      continue;
    }
    const [startRaw, endRaw] = timing.split('-->', 2).map((entry) => entry.trim().split(/\s+/, 1)[0]);
    const startMs = parseTimestamp(startRaw);
    const endMs = parseTimestamp(endRaw);
    index += 1;
    const textLines = [];
    while (index < lines.length && lines[index].trim() !== '') {
      textLines.push(lines[index]);
      index += 1;
    }
    if (startMs !== null && endMs !== null && endMs > startMs) {
      cues.push(Object.freeze({
        ...(identifier ? { identifier } : {}),
        startMs,
        endMs,
        text: cleanText(textLines.join('\n'), 8192) ?? '',
      }));
    }
    while (index < lines.length && lines[index].trim() === '') index += 1;
  }
  return Object.freeze(cues);
}

function trackFingerprint(track, text) {
  return sha256Hex(JSON.stringify({
    url: track.url,
    language: track.language,
    label: track.label,
    text,
  }));
}

export class BrowserMediaCaptureError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'BrowserMediaCaptureError';
    this.code = code;
    this.details = details;
  }
}

function makeAsset(raw, pageOrigin) {
  return normalizeMediaAsset(raw, { pageOrigin });
}

function assetResult(asset, extra = {}) {
  return Object.freeze({ ...asset, asset, ...extra });
}

/**
 * Creates a bounded activeTab capture facade. The default browser APIs are
 * resolved lazily so importing this module in Node never requires Chrome.
 */
export function createBrowserMediaCapture({
  documentRef = globalThis.document,
  locationRef = null,
  fetchImpl = globalThis.fetch?.bind(globalThis),
  captureVisibleTab = globalThis.chrome?.tabs?.captureVisibleTab?.bind(globalThis.chrome.tabs),
  handleStore = null,
  limits: suppliedLimits = {},
  allowedOrigins = [],
  originPolicy = null,
  now = () => Date.now(),
  cryptoRef = globalThis.crypto,
  setTimeoutRef = globalThis.setTimeout?.bind(globalThis),
  clearTimeoutRef = globalThis.clearTimeout?.bind(globalThis),
} = {}) {
  const limits = normalizeLimits(suppliedLimits);
  const originAllowlist = normalizeAllowedOrigins(allowedOrigins);
  if (typeof now !== 'function') throw new TypeError('now must be a function.');
  if (typeof setTimeoutRef !== 'function' || typeof clearTimeoutRef !== 'function') {
    throw new TypeError('Timer dependencies are required.');
  }
  if (fetchImpl !== undefined && typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function.');
  if (captureVisibleTab !== undefined && typeof captureVisibleTab !== 'function') throw new TypeError('captureVisibleTab must be a function.');
  const store = handleStore ?? createMediaHandleStore({
    maxBytes: limits.maxStoredBytes,
    maxHandles: limits.maxHandles,
    ttlMs: limits.handleTtlMs,
    now,
    randomSource: cryptoRef,
  });
  if (!store || typeof store.put !== 'function' || typeof store.get !== 'function') {
    throw new TypeError('handleStore must implement put() and get().');
  }

  function pageContext(options = {}) {
    const location = resolvePageLocation(documentRef, options.locationRef ?? locationRef);
    return location;
  }

  function inspectElements(options = {}) {
    const location = pageContext(options);
    if (!documentRef || typeof documentRef.querySelectorAll !== 'function') {
      throw new BrowserMediaCaptureError('DOCUMENT_UNAVAILABLE', 'A readable page document is required for media inventory.');
    }
    let elements;
    try {
      elements = [...documentRef.querySelectorAll('img, audio, video')];
    } catch {
      throw new BrowserMediaCaptureError('DOCUMENT_UNAVAILABLE', 'The page media inventory could not be read.');
    }
    const assets = [];
    const records = [];
    const rejected = [];
    const maxAssets = options.maxAssets ?? limits.maxAssets;
    if (!Number.isInteger(maxAssets) || maxAssets < 1 || maxAssets > limits.maxAssets) {
      throw new RangeError(`maxAssets must be an integer between 1 and ${limits.maxAssets}.`);
    }
    for (let index = 0; index < elements.length && assets.length < maxAssets; index += 1) {
      const element = elements[index];
      const tag = elementTagName(element);
      if (!MEDIA_TAGS.has(tag)) continue;
      const kind = tag === 'img' || tag === 'image' ? MEDIA_KIND.IMAGE : tag;
      const candidates = sourceCandidates(element, location.href);
      let selected = null;
      let selectedDecision = null;
      for (const candidate of candidates) {
        if (!candidate.url) continue;
        const url = new URL(candidate.url);
        const decision = originDecision(url, location.origin, originAllowlist, originPolicy, { kind, elementIndex: index });
        if (decision.allowed) {
          selected = candidate;
          selectedDecision = decision;
          break;
        }
      }
      const trackList = (kind === MEDIA_KIND.AUDIO || kind === MEDIA_KIND.VIDEO)
        ? trackRecords(element, location.href, location.origin, originAllowlist, originPolicy)
        : [];
      const details = {
        index,
        tag,
        candidates: candidates.map(({ url, origin, type }) => Object.freeze({ url, origin, type })),
        tracks: trackList,
        poster: kind === MEDIA_KIND.VIDEO ? resolveUrl(readAttribute(element, 'poster'), location.href)?.href ?? null : null,
      };
      if (!selected) {
        rejected.push(Object.freeze({ index, kind, reason: candidates.length ? 'MEDIA_ORIGIN_BLOCKED' : 'MEDIA_URL_MISSING' }));
        records.push(Object.freeze({ ...details, asset: null }));
        continue;
      }
      const assetRaw = {
        kind,
        source: 'dom',
        url: selected.url,
        mimeType: selected.type,
        width: kind === MEDIA_KIND.IMAGE ? firstFiniteDimension(element, ['naturalWidth', 'width']) : null,
        height: kind === MEDIA_KIND.IMAGE ? firstFiniteDimension(element, ['naturalHeight', 'height']) : null,
        durationMs: kind === MEDIA_KIND.IMAGE ? null : mediaDurationMs(element),
        altText: kind === MEDIA_KIND.IMAGE
          ? cleanText(readAttribute(element, 'alt') || readAttribute(element, 'aria-label'), 4096)
          : null,
        caption: figureCaption(element),
        pageOrigin: location.origin,
        crossOrigin: selectedDecision.crossOrigin,
        sensitive: false,
      };
      try {
        const asset = makeAsset(assetRaw, location.origin);
        assets.push(asset);
        records.push(Object.freeze({ ...details, asset, elementIndex: index }));
      } catch (error) {
        rejected.push(Object.freeze({ index, kind, reason: error?.code ?? 'MEDIA_ASSET_INVALID' }));
        records.push(Object.freeze({ ...details, asset: null, elementIndex: index }));
      }
    }
    return Object.freeze({
      version: 1,
      pageOrigin: location.origin,
      pageUrl: location.href,
      assets: Object.freeze(assets),
      mediaAssets: Object.freeze(assets),
      records: Object.freeze(records),
      tracks: Object.freeze(records.flatMap((record) => record.tracks ?? [])),
      rejected: Object.freeze(rejected),
      truncated: elements.length > maxAssets,
    });
  }

  async function fetchAsset(rawAsset, options = {}) {
    throwIfAborted(options.signal);
    if (typeof fetchImpl !== 'function') throw new BrowserMediaCaptureError('FETCH_UNAVAILABLE', 'A fetch implementation is required for media capture.');
    const location = pageContext(options);
    const source = typeof rawAsset === 'string' ? { url: rawAsset } : rawAsset;
    if (!isRecord(source)) throw new TypeError('A media asset or URL is required.');
    const kind = source.kind;
    if (![MEDIA_KIND.IMAGE, MEDIA_KIND.AUDIO, MEDIA_KIND.VIDEO].includes(kind)) {
      throw new BrowserMediaCaptureError('MEDIA_KIND_INVALID', 'A supported media kind is required.');
    }
    const url = resolveUrl(source.url ?? source.src, location.href);
    const decision = originDecision(url, location.origin, originAllowlist, originPolicy, { kind });
    if (!decision.allowed) throw new BrowserMediaCaptureError(decision.code, 'The media origin is not allowed.', { url: url?.href ?? null });
    const maxBytes = limits[kind].maxBytes;
    const linked = makeLinkedSignal(options.signal, limits.requestTimeoutMs, setTimeoutRef, clearTimeoutRef);
    let response;
    try {
      response = await fetchImpl(url.href, {
        method: 'GET',
        mode: decision.mode,
        credentials: 'omit',
        redirect: 'error',
        cache: 'no-store',
        referrerPolicy: 'no-referrer',
        signal: linked.signal,
      });
    } catch (error) {
      if (linked.signal.aborted) {
        if (options.signal?.aborted) throw abortError(options.signal.reason);
        if (linked.signal.reason?.code === 'CAPTURE_TIMEOUT') throw linked.signal.reason;
      }
      linked.dispose();
      throw new BrowserMediaCaptureError('MEDIA_FETCH_FAILED', 'The media request failed.', { cause: String(error?.message ?? error).slice(0, 512) });
    }
    try {
      throwIfAborted(linked.signal);
      if (!responseOk(response)) {
        throw new BrowserMediaCaptureError('MEDIA_FETCH_STATUS', 'The media request returned a non-success status.', { status: response?.status ?? null });
      }
      assertResponseOrigin(response, url, location.origin, originAllowlist, originPolicy, { kind });
      const mimeType = assertMime(response, kind, source.mimeType);
      const bytes = await readResponseBytes(response, maxBytes, linked.signal);
      try {
        const stored = store.put(bytes, {
          kind,
          mimeType,
          url: url.href,
          pageOrigin: location.origin,
          sensitive: true,
        });
        try {
          const asset = makeAsset({
            kind,
            source: 'capture',
            handle: stored.handle,
            mimeType,
            byteLength: stored.byteLength,
            pageOrigin: location.origin,
            crossOrigin: decision.crossOrigin,
            sensitive: true,
            altText: source.altText,
            caption: source.caption,
            width: source.width,
            height: source.height,
            durationMs: source.durationMs,
          }, location.origin);
          return assetResult(asset, { expiresAt: stored.expiresAt });
        } catch (error) {
          store.release?.(stored.handle);
          throw error;
        }
      } finally {
        bytes.fill(0);
      }
    } finally {
      linked.dispose();
    }
  }

  async function captureVisibleScreenshot(options = {}) {
    throwIfAborted(options.signal);
    if (typeof captureVisibleTab !== 'function') {
      throw new BrowserMediaCaptureError('SCREENSHOT_UNAVAILABLE', 'chrome.tabs.captureVisibleTab is unavailable.');
    }
    const location = pageContext(options);
    const maxBytes = limits.image.maxBytes;
    const captureOptions = Object.freeze({ format: 'png' });
    let dataUrl;
    try {
      dataUrl = await captureVisibleTab(options.windowId, captureOptions);
    } catch (error) {
      throw new BrowserMediaCaptureError('SCREENSHOT_FAILED', 'The visible-tab screenshot failed.', { cause: String(error?.message ?? error).slice(0, 512) });
    }
    throwIfAborted(options.signal);
    const decoded = decodeDataUrl(dataUrl, maxBytes);
    const stored = store.put(decoded.bytes, {
      kind: MEDIA_KIND.IMAGE,
      mimeType: decoded.mimeType,
      source: 'visible-screenshot',
      pageOrigin: location.origin,
      sensitive: true,
    });
    decoded.bytes.fill(0);
    const asset = makeAsset({
      kind: MEDIA_KIND.IMAGE,
      source: 'capture',
      handle: stored.handle,
      mimeType: decoded.mimeType,
      byteLength: stored.byteLength,
      pageOrigin: location.origin,
      sensitive: true,
    }, location.origin);
    return assetResult(asset, { expiresAt: stored.expiresAt, capture: 'visible-tab' });
  }

  async function readCaptionTracks(suppliedTracks = null, options = {}) {
    throwIfAborted(options.signal);
    const location = pageContext(options);
    const tracks = suppliedTracks === null
      ? inspectElements(options).tracks
      : (Array.isArray(suppliedTracks) ? suppliedTracks : [suppliedTracks]);
    if (tracks.length > limits.maxCaptionTracks) {
      throw new BrowserMediaCaptureError('CAPTION_LIMIT', 'The caption track count exceeds its bounded limit.', {
        observed: tracks.length,
        allowed: limits.maxCaptionTracks,
      });
    }
    const results = [];
    for (const rawTrack of tracks) {
      throwIfAborted(options.signal);
      const rawUrl = rawTrack?.url ?? rawTrack?.src;
      const url = resolveUrl(rawUrl, location.href);
      const decision = originDecision(url, location.origin, originAllowlist, originPolicy, { kind: 'caption' });
      if (!decision.allowed) {
        throw new BrowserMediaCaptureError(decision.code, 'The caption track origin is not allowed.', { url: url?.href ?? null });
      }
      if (typeof fetchImpl !== 'function') throw new BrowserMediaCaptureError('FETCH_UNAVAILABLE', 'A fetch implementation is required for caption capture.');
      const linked = makeLinkedSignal(options.signal, limits.requestTimeoutMs, setTimeoutRef, clearTimeoutRef);
      let response;
      try {
        response = await fetchImpl(url.href, {
          method: 'GET',
          mode: decision.mode,
          credentials: 'omit',
          redirect: 'error',
          cache: 'no-store',
          referrerPolicy: 'no-referrer',
          signal: linked.signal,
        });
      } catch (error) {
        if (linked.signal.aborted) {
          if (options.signal?.aborted) throw abortError(options.signal.reason);
          if (linked.signal.reason?.code === 'CAPTURE_TIMEOUT') throw linked.signal.reason;
        }
        linked.dispose();
        throw new BrowserMediaCaptureError('CAPTION_FETCH_FAILED', 'The caption request failed.', { cause: String(error?.message ?? error).slice(0, 512) });
      }
      try {
        throwIfAborted(linked.signal);
        if (!responseOk(response)) throw new BrowserMediaCaptureError('CAPTION_FETCH_STATUS', 'The caption request returned a non-success status.', { status: response?.status ?? null });
        assertResponseOrigin(response, url, location.origin, originAllowlist, originPolicy, { kind: 'caption' });
        const contentType = cleanText(responseHeader(response, 'content-type'), 256)?.split(';', 1)[0].toLowerCase() ?? null;
        if (contentType && !SAFE_CAPTION_TYPES.has(contentType)) {
          throw new BrowserMediaCaptureError('CAPTION_MIME_BLOCKED', 'The caption response MIME type is not allowed.', { contentType });
        }
        const text = await readResponseText(response, limits.maxCaptionBytes, linked.signal);
        const cues = parseWebVtt(text);
        results.push(Object.freeze({
          version: 1,
          url: url.href,
          origin: url.origin,
          language: cleanText(rawTrack?.language ?? rawTrack?.srclang, 64),
          label: cleanText(rawTrack?.label, 256),
          kind: cleanText(rawTrack?.kind, 64)?.toLowerCase() || 'subtitles',
          mimeType: contentType,
          byteLength: new TextEncoder().encode(text).byteLength,
          text: text.slice(0, limits.maxCaptionBytes),
          cues,
          fingerprint: trackFingerprint(rawTrack, text),
        }));
      } finally {
        linked.dispose();
      }
    }
    return Object.freeze(results);
  }

  async function capture(options = {}) {
    throwIfAborted(options.signal);
    const inventory = inspectElements(options);
    const assets = [];
    for (const asset of inventory.assets) {
      throwIfAborted(options.signal);
      assets.push(await fetchAsset(asset, options));
    }
    const captions = options.includeCaptions === false ? Object.freeze([]) : await readCaptionTracks(inventory.tracks, options);
    const screenshot = options.includeScreenshot ? await captureVisibleScreenshot(options) : null;
    return Object.freeze({ version: 1, inventory, assets: Object.freeze(assets), captions, screenshot });
  }

  const api = {
    limits,
    handleStore: store,
    inventory: inspectElements,
    inventoryMedia: inspectElements,
    listMediaAssets(options = {}) {
      return inspectElements(options).assets;
    },
    fetchAsset,
    fetchMediaAsset: fetchAsset,
    captureVisibleScreenshot,
    captureScreenshot: captureVisibleScreenshot,
    readCaptionTracks,
    readCaptions: readCaptionTracks,
    capture,
  };
  return Object.freeze(api);
}

export const createBrowserMediaCaptureService = createBrowserMediaCapture;
export const createMediaCapture = createBrowserMediaCapture;
