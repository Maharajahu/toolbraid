import {
  createOpenAiCompatibleAudioAdapter,
  createOpenAiCompatibleVisionAdapter,
} from '../src/multimodal/index.js';

export const MULTIMODAL_CONFIG_KEY = 'toolbraid.universal.multimodal.config.v1';
export const MULTIMODAL_SECRET_KEY = 'toolbraid.universal.multimodal.secret.v1';
export const MULTIMODAL_PROVIDER_VERSION = 1;

const MAX_ENDPOINT = 2048;
const MAX_MODEL = 256;
const MAX_SECRET = 8192;
const MAX_MEDIA_BYTES = Object.freeze({
  image: 15 * 1024 * 1024,
  audio: 25 * 1024 * 1024,
});
const HANDLE_PATTERN = /^tb-media-[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_ANALYSIS_TEXT = 32_768;
const MAX_LIST_ITEMS = 256;

export class MultimodalProviderError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'MultimodalProviderError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details = {}) {
  return new MultimodalProviderError(code, message, details);
}

function plainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function own(value, key) {
  try {
    return Object.prototype.hasOwnProperty.call(value, key);
  } catch {
    return false;
  }
}

function cleanText(value, field, maxLength, { required = false } = {}) {
  if (value === undefined || value === null) {
    if (required) throw fail('MULTIMODAL_CONFIG_INVALID', `${field} is required.`, { field });
    return '';
  }
  if (typeof value !== 'string') throw fail('MULTIMODAL_CONFIG_INVALID', `${field} must be a string.`, { field });
  const result = value.trim();
  if (required && !result) throw fail('MULTIMODAL_CONFIG_INVALID', `${field} is required.`, { field });
  if (result.length > maxLength) throw fail('MULTIMODAL_CONFIG_INVALID', `${field} is too long.`, { field, maxLength });
  return result;
}

function cleanSecret(value) {
  const secret = cleanText(value, 'apiKey', MAX_SECRET);
  if (/\r|\n/.test(secret)) throw fail('MULTIMODAL_CONFIG_INVALID', 'apiKey contains unsupported control characters.', { field: 'apiKey' });
  return secret;
}

function hostWithoutBrackets(hostname) {
  const value = String(hostname ?? '').toLowerCase();
  return value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value;
}

function ipv4Parts(hostname) {
  if (!/^\d+(?:\.\d+){3}$/.test(hostname)) return null;
  const parts = hostname.split('.').map((part) => Number(part));
  return parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255) ? parts : null;
}

function privateIpv4(parts) {
  if (!parts) return false;
  const [a, b, c] = parts;
  return a === 0 || a === 10 || a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 198 && b === 18) ||
    (a === 198 && b === 19) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224;
}

function privateIpv6(hostname) {
  const value = hostWithoutBrackets(hostname);
  if (!value.includes(':')) return false;
  const groups = value.split('::');
  if (groups.length > 2) return true;
  const expand = (part) => {
    if (!part) return [];
    const tokens = part.split(':');
    const expanded = [];
    for (const token of tokens) {
      if (token.includes('.')) {
        const mapped = ipv4Parts(token);
        if (!mapped) return null;
        expanded.push(((mapped[0] << 8) | mapped[1]).toString(16), ((mapped[2] << 8) | mapped[3]).toString(16));
      } else if (/^[0-9a-f]{1,4}$/i.test(token)) {
        expanded.push(token);
      } else {
        return null;
      }
    }
    return expanded;
  };
  const left = expand(groups[0]);
  const right = expand(groups[1] ?? '');
  if (!left || !right) return true;
  const words = groups.length === 2 ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right] : [...left];
  if (words.length !== 8) return true;
  const numeric = words.map((word) => Number.parseInt(word, 16));
  const first = numeric[0];
  if (first === 0 || first === 0xffff || (first >= 0xfc00 && first <= 0xfdff) ||
      (first >= 0xfe80 && first <= 0xfebf) || (first >= 0xff00 && first <= 0xffff)) return true;
  if (numeric.slice(0, 6).every((word) => word === 0) && numeric[6] === 0xffff) {
    return privateIpv4([numeric[7] >> 8, numeric[7] & 0xff, 0, 0]);
  }
  return numeric.slice(0, 6).every((word) => word === 0) && privateIpv4([numeric[6] >> 8, numeric[6] & 0xff, numeric[7] >> 8, numeric[7] & 0xff]);
}

function privateOrLocalHost(hostname) {
  const value = hostWithoutBrackets(hostname);
  if (!value || value.endsWith('.') || value === 'localhost' || value.endsWith('.localhost') ||
      value.endsWith('.local') || value.endsWith('.lan') || value.endsWith('.home.arpa') ||
      value.endsWith('.internal') || value.endsWith('.intranet') || value.endsWith('.corp') ||
      value.endsWith('.nip.io') || value.endsWith('.sslip.io') || value.endsWith('.localtest.me') ||
      value.endsWith('.lvh.me') || value.endsWith('.xip.io') || value.endsWith('.xip.name')) return true;
  return privateIpv4(ipv4Parts(value)) || privateIpv6(value);
}

function loopback(hostname) {
  const value = hostWithoutBrackets(hostname);
  return value === 'localhost' || value === '127.0.0.1' || value === '::1';
}

function normalizeBaseUrl(value) {
  const raw = cleanText(value, 'baseUrl', MAX_ENDPOINT, { required: true });
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw fail('MULTIMODAL_ENDPOINT_INVALID', 'The analysis endpoint must be an absolute URL.');
  }
  if (url.username || url.password || url.hash || url.search) {
    throw fail('MULTIMODAL_ENDPOINT_INVALID', 'The analysis endpoint cannot contain credentials, query parameters, or a fragment.');
  }
  const hostname = hostWithoutBrackets(url.hostname);
  if (url.protocol === 'https:' && privateOrLocalHost(hostname)) {
    throw fail('MULTIMODAL_ENDPOINT_INVALID', 'The analysis endpoint cannot target a private or local network address.');
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback(hostname))) {
    throw fail('MULTIMODAL_ENDPOINT_INVALID', 'The analysis endpoint must use HTTPS or loopback HTTP.');
  }
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return url.href;
}

export function permissionOriginForBaseUrl(baseUrl) {
  const url = new URL(normalizeBaseUrl(baseUrl));
  return `${url.protocol}//${url.host}/*`;
}

export function normalizeMultimodalConfig(input = {}) {
  if (!plainObject(input)) throw fail('MULTIMODAL_CONFIG_INVALID', 'Multimodal configuration must be a plain object.');
  if (own(input, 'version') && input.version !== undefined && input.version !== MULTIMODAL_PROVIDER_VERSION) {
    throw fail('MULTIMODAL_CONFIG_INVALID', 'Unsupported multimodal configuration version.');
  }
  const enabled = own(input, 'enabled') && input.enabled === true;
  if (!enabled) {
    return Object.freeze({
      version: MULTIMODAL_PROVIDER_VERSION,
      enabled: false,
      baseUrl: '',
      visionModel: '',
      audioModel: '',
      permissionOrigin: '',
    });
  }
  const baseUrl = normalizeBaseUrl(input.baseUrl);
  const visionModel = cleanText(input.visionModel, 'visionModel', MAX_MODEL, { required: true });
  const audioModel = cleanText(input.audioModel, 'audioModel', MAX_MODEL);
  return Object.freeze({
    version: MULTIMODAL_PROVIDER_VERSION,
    enabled: true,
    baseUrl,
    visionModel,
    audioModel,
    permissionOrigin: permissionOriginForBaseUrl(baseUrl),
  });
}

function runtimeLastError() {
  try {
    return globalThis.chrome?.runtime?.lastError ?? null;
  } catch {
    return null;
  }
}

function storageFailure(code) {
  return fail(code, code === 'MULTIMODAL_STORAGE_READ_FAILED'
    ? 'Extension storage could not be read.'
    : 'Extension storage could not be updated.');
}

function storageValue(value) {
  if (value === undefined || value === null) return {};
  if (!plainObject(value)) throw storageFailure('MULTIMODAL_STORAGE_READ_FAILED');
  return value;
}

function storageGet(area, key) {
  if (!area || typeof area.get !== 'function') return Promise.resolve({});
  if (area.get.length >= 2) {
    return new Promise((resolve, reject) => {
      try {
        area.get(key, (value) => {
          const error = runtimeLastError();
          if (error) reject(storageFailure('MULTIMODAL_STORAGE_READ_FAILED'));
          else {
            try { resolve(storageValue(value)); } catch { reject(storageFailure('MULTIMODAL_STORAGE_READ_FAILED')); }
          }
        });
      } catch { reject(storageFailure('MULTIMODAL_STORAGE_READ_FAILED')); }
    });
  }
  try {
    const result = area.get(key);
    if (result && typeof result.then === 'function') {
      return Promise.resolve(result).then(storageValue, () => { throw storageFailure('MULTIMODAL_STORAGE_READ_FAILED'); });
    }
    return Promise.resolve(storageValue(result));
  } catch {
    return Promise.reject(storageFailure('MULTIMODAL_STORAGE_READ_FAILED'));
  }
}

function storageSet(area, value) {
  if (!area || typeof area.set !== 'function') return Promise.reject(fail('MULTIMODAL_STORAGE_UNAVAILABLE', 'Extension storage is unavailable.'));
  if (area.set.length >= 2) {
    return new Promise((resolve, reject) => {
      try {
        area.set(value, () => {
          const error = runtimeLastError();
          if (error) reject(storageFailure('MULTIMODAL_STORAGE_WRITE_FAILED'));
          else resolve();
        });
      } catch { reject(storageFailure('MULTIMODAL_STORAGE_WRITE_FAILED')); }
    });
  }
  try {
    const result = area.set(value);
    return result && typeof result.then === 'function'
      ? Promise.resolve(result).catch(() => { throw storageFailure('MULTIMODAL_STORAGE_WRITE_FAILED'); })
      : Promise.resolve();
  } catch {
    return Promise.reject(storageFailure('MULTIMODAL_STORAGE_WRITE_FAILED'));
  }
}

function storageRemove(area, key) {
  if (!area || typeof area.remove !== 'function') return Promise.resolve();
  if (area.remove.length >= 2) {
    return new Promise((resolve, reject) => {
      try {
        area.remove(key, () => {
          const error = runtimeLastError();
          if (error) reject(storageFailure('MULTIMODAL_STORAGE_WRITE_FAILED'));
          else resolve();
        });
      } catch { reject(storageFailure('MULTIMODAL_STORAGE_WRITE_FAILED')); }
    });
  }
  try {
    const result = area.remove(key);
    return result && typeof result.then === 'function'
      ? Promise.resolve(result).catch(() => { throw storageFailure('MULTIMODAL_STORAGE_WRITE_FAILED'); })
      : Promise.resolve();
  } catch {
    return Promise.reject(storageFailure('MULTIMODAL_STORAGE_WRITE_FAILED'));
  }
}

function requestOrigins(permissionsApi, origins) {
  if (!permissionsApi || typeof permissionsApi.request !== 'function') {
    return Promise.reject(fail('MULTIMODAL_PERMISSION_UNAVAILABLE', 'Optional host permission API is unavailable.'));
  }
  const request = { origins };
  if (permissionsApi.request.length >= 2) {
    return new Promise((resolve, reject) => {
      try {
        permissionsApi.request(request, (granted) => {
          const error = runtimeLastError();
          if (error) reject(fail('MULTIMODAL_PERMISSION_FAILED', 'The optional host permission request failed.'));
          else resolve(granted === true);
        });
      } catch { reject(fail('MULTIMODAL_PERMISSION_FAILED', 'The optional host permission request failed.')); }
    });
  }
  try {
    const result = permissionsApi.request(request);
    return result && typeof result.then === 'function'
      ? Promise.resolve(result).then((granted) => granted === true, () => { throw fail('MULTIMODAL_PERMISSION_FAILED', 'The optional host permission request failed.'); })
      : Promise.resolve(result === true);
  } catch {
    return Promise.reject(fail('MULTIMODAL_PERMISSION_FAILED', 'The optional host permission request failed.'));
  }
}

function normalizeRuntimeConfiguration(value) {
  if (!plainObject(value)) throw fail('MULTIMODAL_CONFIG_INVALID', 'Multimodal configuration must be a plain object.');
  const config = normalizeMultimodalConfig(value);
  const apiKey = config.enabled && own(value, 'apiKey') ? cleanSecret(value.apiKey) : '';
  return Object.freeze({ ...config, apiKey });
}

export function createMultimodalSettingsStore({
  localArea = globalThis.chrome?.storage?.local,
  sessionArea = globalThis.chrome?.storage?.session,
  permissionsApi = globalThis.chrome?.permissions,
} = {}) {
  async function read() {
    const [local, session] = await Promise.all([
      storageGet(localArea, MULTIMODAL_CONFIG_KEY),
      storageGet(sessionArea, MULTIMODAL_SECRET_KEY),
    ]);
    let config;
    try {
      const stored = own(local, MULTIMODAL_CONFIG_KEY) ? local[MULTIMODAL_CONFIG_KEY] : { enabled: false };
      config = normalizeMultimodalConfig(stored);
    } catch {
      config = normalizeMultimodalConfig({ enabled: false });
    }
    let apiKey = '';
    try {
      const rawSecret = own(session, MULTIMODAL_SECRET_KEY) ? session[MULTIMODAL_SECRET_KEY] : '';
      apiKey = typeof rawSecret === 'string' && rawSecret.length <= MAX_SECRET ? cleanSecret(rawSecret) : '';
    } catch {
      apiKey = '';
    }
    return Object.freeze({ ...config, apiKey });
  }

  async function publicState() {
    const value = await read();
    const { apiKey, ...config } = value;
    return Object.freeze({ ...config, hasApiKey: Boolean(apiKey) });
  }

  async function save(input = {}) {
    if (!plainObject(input)) throw fail('MULTIMODAL_CONFIG_INVALID', 'Multimodal configuration must be a plain object.');
    const config = normalizeMultimodalConfig({ ...input, enabled: true });
    const hasApiKey = own(input, 'apiKey');
    const apiKey = hasApiKey ? cleanSecret(input.apiKey) : '';
    const clearApiKey = own(input, 'clearApiKey') && input.clearApiKey === true;
    if ((apiKey || (hasApiKey && clearApiKey)) && (!sessionArea || sessionArea === localArea)) {
      throw fail('MULTIMODAL_STORAGE_UNAVAILABLE', 'A separate session storage area is required for provider credentials.');
    }
    const granted = await requestOrigins(permissionsApi, [config.permissionOrigin]);
    if (!granted) throw fail('MULTIMODAL_PERMISSION_DENIED', 'Host permission for the exact analysis endpoint was not granted.', { origin: config.permissionOrigin });
    if (apiKey) await storageSet(sessionArea, { [MULTIMODAL_SECRET_KEY]: apiKey });
    else if (hasApiKey && clearApiKey) await storageRemove(sessionArea, MULTIMODAL_SECRET_KEY);
    await storageSet(localArea, { [MULTIMODAL_CONFIG_KEY]: config });
    return publicState();
  }

  async function disable() {
    await Promise.all([
      storageSet(localArea, { [MULTIMODAL_CONFIG_KEY]: normalizeMultimodalConfig({ enabled: false }) }),
      storageRemove(sessionArea, MULTIMODAL_SECRET_KEY),
    ]);
    return publicState();
  }

  return Object.freeze({ read, publicState, save, disable });
}

function bytesToBase64(bytes, maxBytes) {
  if (!(bytes instanceof Uint8Array)) throw fail('MULTIMODAL_MEDIA_UNAVAILABLE', 'Captured media bytes are unavailable.');
  if (bytes.byteLength > maxBytes) throw fail('MULTIMODAL_MEDIA_UNAVAILABLE', 'Captured media exceeds the provider input limit.');
  if (typeof globalThis.btoa !== 'function') throw fail('MULTIMODAL_ENCODER_UNAVAILABLE', 'The extension base64 encoder is unavailable.');
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(bytes.length, offset + chunkSize)));
  }
  return globalThis.btoa(binary);
}

function safeUntrustedText(value, maxLength = MAX_ANALYSIS_TEXT, secret = '') {
  if (typeof value !== 'string') return null;
  let text;
  try {
    text = value.normalize('NFC').trim().slice(0, maxLength);
  } catch {
    return null;
  }
  if (secret) text = text.split(secret).join('[redacted]');
  return text || null;
}

function safeRead(value, key) {
  try {
    return value && typeof value === 'object' ? value[key] : undefined;
  } catch {
    return undefined;
  }
}

function metadataEvidence(asset, warning = null, secret = '') {
  const source = asset && typeof asset === 'object' ? asset : {};
  const kind = typeof source.kind === 'string' ? source.kind : 'unknown';
  const altText = safeUntrustedText(safeRead(source, 'altText'), MAX_ANALYSIS_TEXT, secret);
  const caption = safeUntrustedText(safeRead(source, 'caption'), MAX_ANALYSIS_TEXT, secret);
  const summary = altText || caption || `${kind} media discovered on the current page.`;
  return {
    summary,
    text: altText || caption || null,
    transcript: kind === 'audio' || kind === 'video' ? caption : null,
    confidence: altText || caption ? 0.45 : 0,
    warnings: warning ? [warning] : [],
    model: 'toolbraid-metadata-only',
    untrustedContent: true,
  };
}

function abortError() {
  try {
    return new DOMException('The multimodal analysis was cancelled.', 'AbortError');
  } catch {
    const error = new Error('The multimodal analysis was cancelled.');
    error.name = 'AbortError';
    return error;
  }
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError();
}

function isAbortError(error, signal) {
  return Boolean(signal?.aborted || error?.name === 'AbortError' || error?.code === 'ABORT_ERR');
}

function awaitAbortable(thunk, signal) {
  throwIfAborted(signal);
  let result;
  try {
    result = thunk();
  } catch (error) {
    if (isAbortError(error, signal)) throw abortError();
    throw error;
  }
  if (!signal || typeof signal.addEventListener !== 'function') return Promise.resolve(result);
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      try { signal.removeEventListener?.('abort', onAbort); } catch { /* best effort */ }
    };
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(abortError());
    };
    try {
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) {
        onAbort();
        return;
      }
    } catch {
      // A non-standard signal is treated as non-cancellable after the initial check.
    }
    Promise.resolve(result).then((value) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    }, (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    });
  });
}

function validMimeType(value, kind) {
  if (typeof value !== 'string') return false;
  const mimeType = value.trim().toLowerCase();
  if (!/^[a-z]+\/[a-z0-9!#$&^_.+-]+$/.test(mimeType)) return false;
  return mimeType.startsWith(`${kind}/`);
}

function mediaMimeType(asset, entry, kind) {
  const assetMime = safeRead(asset, 'mimeType');
  const entryMetadata = safeRead(entry, 'metadata');
  const entryMime = safeRead(entryMetadata, 'mimeType');
  const supplied = assetMime || entryMime;
  if (supplied !== undefined && supplied !== null && supplied !== '' && !validMimeType(supplied, kind)) return null;
  if (typeof supplied === 'string' && supplied.trim()) return supplied.trim().toLowerCase();
  return kind === 'image' ? 'image/png' : 'audio/webm';
}

function safeHandleEntry(asset, entry, now) {
  if (!plainObject(entry)) return null;
  const kind = safeRead(asset, 'kind');
  const maxBytes = MAX_MEDIA_BYTES[kind];
  if (!maxBytes) return null;
  const handle = safeRead(asset, 'handle');
  if (typeof handle !== 'string' || !HANDLE_PATTERN.test(handle)) return null;
  if (!own(entry, 'handle')) return null;
  const entryHandle = safeRead(entry, 'handle');
  if (entryHandle !== handle) return null;
  const bytes = safeRead(entry, 'bytes');
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > maxBytes) return null;
  const byteLength = safeRead(entry, 'byteLength');
  if (!Number.isInteger(byteLength) || byteLength !== bytes.byteLength) return null;
  const assetByteLength = safeRead(asset, 'byteLength');
  if (assetByteLength !== undefined && assetByteLength !== null &&
      (!Number.isInteger(assetByteLength) || assetByteLength !== bytes.byteLength)) return null;
  const expiresAt = safeRead(entry, 'expiresAt');
  if (!Number.isFinite(expiresAt) || expiresAt <= now) return null;
  return { bytes, metadata: safeRead(entry, 'metadata'), byteLength, expiresAt };
}

function safeStringList(value, secret) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, MAX_LIST_ITEMS)
    .map((item) => safeUntrustedText(item, 2048, secret))
    .filter(Boolean);
}

function safeNumber(value, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  return typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum ? value : null;
}

function safeSegments(value, secret) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, MAX_LIST_ITEMS).map((segment) => {
    if (!plainObject(segment)) return null;
    const text = safeUntrustedText(safeRead(segment, 'text'), 8192, secret);
    return {
      start: safeNumber(safeRead(segment, 'start'), 0),
      end: safeNumber(safeRead(segment, 'end'), 0),
      text,
    };
  }).filter((segment) => segment && segment.text);
}

function safeRegions(value, secret) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, MAX_LIST_ITEMS).map((region) => {
    if (!plainObject(region)) return null;
    return {
      label: safeUntrustedText(safeRead(region, 'label'), 1024, secret),
      text: safeUntrustedText(safeRead(region, 'text'), 8192, secret),
      x: safeNumber(safeRead(region, 'x'), 0, 1),
      y: safeNumber(safeRead(region, 'y'), 0, 1),
      width: safeNumber(safeRead(region, 'width'), 0, 1),
      height: safeNumber(safeRead(region, 'height'), 0, 1),
    };
  }).filter((region) => region && (region.label || region.text));
}

function sanitizeAnalysis(value, asset, secret) {
  if (!plainObject(value)) return metadataEvidence(asset, 'The analysis provider returned an invalid result; metadata-only evidence is shown.');
  const summary = safeUntrustedText(safeRead(value, 'summary'), MAX_ANALYSIS_TEXT, secret);
  const text = safeUntrustedText(safeRead(value, 'text'), MAX_ANALYSIS_TEXT, secret);
  const transcript = safeUntrustedText(safeRead(value, 'transcript'), MAX_ANALYSIS_TEXT, secret);
  const language = safeUntrustedText(safeRead(value, 'language'), 128, secret);
  const labels = safeStringList(safeRead(value, 'labels'), secret);
  const segments = safeSegments(safeRead(value, 'segments'), secret);
  const regions = safeRegions(safeRead(value, 'regions'), secret);
  if (!summary && !text && !transcript && !language && labels.length === 0 && segments.length === 0 && regions.length === 0) {
    return metadataEvidence(asset, 'The analysis provider returned no usable evidence; metadata-only evidence is shown.');
  }
  const warnings = safeStringList(safeRead(value, 'warnings'), secret);
  const confidence = safeNumber(safeRead(value, 'confidence'), 0, 1);
  const model = safeUntrustedText(safeRead(value, 'model'), 256, secret) || 'configured-openai-compatible';
  return {
    summary,
    text,
    transcript,
    language,
    labels,
    segments,
    regions,
    confidence,
    warnings,
    model,
    untrustedContent: true,
  };
}

export function createConfiguredMultimodalAdapter({
  settings,
  handleStore,
  fetchImpl = globalThis.fetch?.bind(globalThis),
  priority = 100,
  now = () => Date.now(),
} = {}) {
  if (!settings || typeof settings.read !== 'function') throw new TypeError('settings.read is required.');
  if (!handleStore || typeof handleStore.get !== 'function') throw new TypeError('handleStore.get is required.');
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl is required.');
  if (typeof now !== 'function') throw new TypeError('now is required.');

  async function captured(asset, signal) {
    const handle = safeRead(asset, 'handle');
    if (typeof handle !== 'string' || !HANDLE_PATTERN.test(handle)) return null;
    const entry = await awaitAbortable(() => handleStore.get(handle), signal);
    let currentTime;
    try {
      currentTime = Number(now());
    } catch {
      return null;
    }
    if (!Number.isFinite(currentTime)) return null;
    return safeHandleEntry(asset, entry, currentTime);
  }

  return Object.freeze({
    id: 'toolbraid-configured-multimodal',
    version: String(MULTIMODAL_PROVIDER_VERSION),
    priority,
    supports(asset) {
      return ['image', 'audio', 'video'].includes(asset?.kind);
    },
    async analyze(asset, { signal, context } = {}) {
      throwIfAborted(signal);
      let configuration;
      try {
        configuration = normalizeRuntimeConfiguration(await awaitAbortable(() => settings.read(), signal));
      } catch (error) {
        if (isAbortError(error, signal)) throw abortError();
        return metadataEvidence(asset, 'Provider configuration is invalid; metadata-only evidence is shown.');
      }
      if (!configuration.enabled) return metadataEvidence(asset, 'No analysis provider is enabled; metadata-only evidence is shown.');
      if (safeRead(asset, 'kind') === 'video') return metadataEvidence(asset, 'Direct video decoding is not enabled; captions and page metadata are shown.');

      let entry;
      try {
        entry = await captured(asset, signal);
      } catch (error) {
        if (isAbortError(error, signal)) throw abortError();
        return metadataEvidence(asset, 'The volatile media handle could not be read; metadata-only evidence is shown.', configuration.apiKey);
      }
      if (!entry) return metadataEvidence(asset, 'This asset was not captured into an extension-owned volatile handle.', configuration.apiKey);

      try {
        throwIfAborted(signal);
        const kind = safeRead(asset, 'kind');
        const mimeType = mediaMimeType(asset, entry, kind);
        if (!mimeType) return metadataEvidence(asset, 'The captured media type is invalid; metadata-only evidence is shown.', configuration.apiKey);

        if (kind === 'image') {
          const vision = createOpenAiCompatibleVisionAdapter({
            id: 'configured-openai-compatible-vision',
            version: String(MULTIMODAL_PROVIDER_VERSION),
            baseUrl: configuration.baseUrl,
            model: configuration.visionModel,
            fetchImpl,
            getApiKey: async () => configuration.apiKey,
            resolveImage: async () => {
              throwIfAborted(signal);
              const bytes = new Uint8Array(entry.bytes);
              try {
                return { base64: bytesToBase64(bytes, MAX_MEDIA_BYTES.image), mimeType };
              } finally {
                bytes.fill(0);
              }
            },
          });
          const result = await vision.analyze(asset, { signal, context });
          throwIfAborted(signal);
          return sanitizeAnalysis(result, asset, configuration.apiKey);
        }

        if (!configuration.audioModel) return metadataEvidence(asset, 'No audio transcription model is configured.', configuration.apiKey);
        const audio = createOpenAiCompatibleAudioAdapter({
          id: 'configured-openai-compatible-asr',
          version: String(MULTIMODAL_PROVIDER_VERSION),
          baseUrl: configuration.baseUrl,
          model: configuration.audioModel,
          fetchImpl,
          getApiKey: async () => configuration.apiKey,
          resolveAudio: async () => {
            throwIfAborted(signal);
            const bytes = new Uint8Array(entry.bytes);
            try {
              const subtype = mimeType.slice(mimeType.indexOf('/') + 1).replace(/[^a-z0-9]+/gi, '').slice(0, 16) || 'bin';
              return { blob: new Blob([bytes], { type: mimeType }), name: `toolbraid-audio.${subtype}` };
            } finally {
              bytes.fill(0);
            }
          },
        });
        const result = await audio.analyze(asset, { signal, context });
        throwIfAborted(signal);
        return sanitizeAnalysis(result, asset, configuration.apiKey);
      } catch (error) {
        if (isAbortError(error, signal)) throw abortError();
        return metadataEvidence(asset, 'Analysis provider failed; metadata-only evidence is shown.', configuration.apiKey);
      }
    },
  });
}
