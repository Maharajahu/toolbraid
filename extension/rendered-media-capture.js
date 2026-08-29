/*
 * ToolBraid rendered media capture.
 *
 * This file is intentionally a classic isolated-world script. It only reads
 * the current document, uses the page extractor's stable element references,
 * and records already-rendered audio or visible video frames. It never resolves
 * a media URL, fetches a resource, persists bytes, or crosses a frame boundary.
 */
(function installToolBraidRenderedMediaCapture(global) {
  if (!global || global.ToolBraidRenderedMediaCapture) return;

  const VERSION = 1;
  const DEFAULTS = Object.freeze({
    maxMediaElements: 32,
    maxTracks: 8,
    maxCues: 256,
    maxCaptionBytes: 256 * 1024,
    maxCueTextCharacters: 4096,
    durationMs: 30_000,
    maxBytes: 10 * 1024 * 1024,
    stopTimeoutMs: 500,
    mimeType: 'audio/webm;codecs=opus',
    maxFrames: 3,
    maxFrameBytes: 2 * 1024 * 1024,
    maxTotalFrameBytes: 6 * 1024 * 1024,
    frameIntervalMs: 500,
    frameMimeType: 'image/png',
  });
  const HARD_CAPS = Object.freeze({
    maxMediaElements: 128,
    maxTracks: 32,
    maxCues: 2048,
    maxCaptionBytes: 1024 * 1024,
    maxCueTextCharacters: 16 * 1024,
    durationMs: 15 * 60 * 1000,
    maxBytes: 25 * 1024 * 1024,
    stopTimeoutMs: 5000,
    maxFrames: 12,
    maxFrameBytes: 4 * 1024 * 1024,
    maxTotalFrameBytes: 12 * 1024 * 1024,
    frameIntervalMs: 30_000,
  });
  const MEDIA_KINDS = new Set(['audio', 'video']);
  const CAPTION_KINDS = new Set(['captions', 'subtitles', 'caption', 'subtitle']);
  const HTTP_PROTOCOLS = new Set(['http:', 'https:']);

  function own(value, key) {
    try { return Object.prototype.hasOwnProperty.call(value, key); } catch { return false; }
  }

  function plain(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    try {
      const prototype = Object.getPrototypeOf(value);
      return prototype === Object.prototype || prototype === null;
    } catch {
      return false;
    }
  }

  function safeRead(target, key, fallback = undefined) {
    try {
      const value = target?.[key];
      return value === undefined || value === null ? fallback : value;
    } catch {
      return fallback;
    }
  }

  function safeCall(target, key, args = [], fallback = undefined) {
    try {
      if (typeof target?.[key] !== 'function') return fallback;
      const value = target[key](...args);
      return value === undefined || value === null ? fallback : value;
    } catch {
      return fallback;
    }
  }

  function boundedText(value, max = 512) {
    if (typeof value !== 'string') return '';
    return value
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ')
      .trim()
      .slice(0, max);
  }

  function jsonSafe(value, fallback = null) {
    if (value === null || value === undefined) return value ?? fallback;
    if (typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    return fallback;
  }

  function errorDetails(details = {}) {
    if (!plain(details)) return {};
    const output = {};
    for (const [key, value] of Object.entries(details).slice(0, 12)) {
      if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key)) continue;
      const safe = jsonSafe(value, undefined);
      if (safe !== undefined) output[key] = safe;
    }
    return output;
  }

  function failure(code, message, details = {}, metadata = {}) {
    return {
      ok: false,
      status: 'failed',
      code,
      message: boundedText(message, 256),
      details: errorDetails(details),
      metadata: { version: VERSION, ...metadata },
      captions: [],
      bytes: new Uint8Array(0),
    };
  }

  function normalizeInteger(value, field, fallback, cap) {
    const candidate = value === undefined ? fallback : value;
    if (!Number.isInteger(candidate) || candidate < 1 || candidate > cap) {
      const error = new Error(`${field} is outside its hard bound.`);
      error.code = 'CAPTURE_OPTIONS_INVALID';
      error.field = field;
      throw error;
    }
    return candidate;
  }

  function normalizeRequest(input = {}, { requireRef = true, mimePrefix = 'audio/', mimeTypeOverride } = {}) {
    if (!plain(input)) {
      const error = new Error('Capture options must be a plain object.');
      error.code = 'CAPTURE_OPTIONS_INVALID';
      throw error;
    }
    const ref = input.elementRef ?? input.ref;
    if (requireRef && (typeof ref !== 'string' || !ref.trim() || ref.length > 256 || /[\u0000-\u001f\u007f]/.test(ref))) {
      const error = new Error('A stable media element reference is required.');
      error.code = 'MEDIA_REF_INVALID';
      throw error;
    }
    if (input.elementRef !== undefined && input.ref !== undefined && input.elementRef !== input.ref) {
      const error = new Error('elementRef and ref must identify the same element.');
      error.code = 'MEDIA_REF_INVALID';
      throw error;
    }
    const kind = input.kind ?? input.sourceKind;
    if (typeof kind !== 'string' || !MEDIA_KINDS.has(kind.toLowerCase())) {
      const error = new Error('kind must be audio or video.');
      error.code = 'MEDIA_KIND_INVALID';
      throw error;
    }
    if (input.kind !== undefined && input.sourceKind !== undefined && input.kind !== input.sourceKind) {
      const error = new Error('kind and sourceKind must identify the same element kind.');
      error.code = 'MEDIA_KIND_INVALID';
      throw error;
    }
    const durationMs = normalizeInteger(input.durationMs ?? input.duration, 'durationMs', DEFAULTS.durationMs, HARD_CAPS.durationMs);
    const maxBytes = normalizeInteger(input.maxBytes, 'maxBytes', DEFAULTS.maxBytes, HARD_CAPS.maxBytes);
    const maxMediaElements = normalizeInteger(input.maxMediaElements, 'maxMediaElements', DEFAULTS.maxMediaElements, HARD_CAPS.maxMediaElements);
    const maxTracks = normalizeInteger(input.maxTracks, 'maxTracks', DEFAULTS.maxTracks, HARD_CAPS.maxTracks);
    const maxCues = normalizeInteger(input.maxCues, 'maxCues', DEFAULTS.maxCues, HARD_CAPS.maxCues);
    const maxCaptionBytes = normalizeInteger(input.maxCaptionBytes, 'maxCaptionBytes', DEFAULTS.maxCaptionBytes, HARD_CAPS.maxCaptionBytes);
    const maxCueTextCharacters = normalizeInteger(input.maxCueTextCharacters, 'maxCueTextCharacters', DEFAULTS.maxCueTextCharacters, HARD_CAPS.maxCueTextCharacters);
    const stopTimeoutMs = normalizeInteger(input.stopTimeoutMs ?? input.stopTimeout, 'stopTimeoutMs', DEFAULTS.stopTimeoutMs, HARD_CAPS.stopTimeoutMs);
    const defaultMimeType = mimePrefix === 'image/' ? DEFAULTS.frameMimeType : DEFAULTS.mimeType;
    const mimeType = mimeTypeOverride ?? (input.mimeType === undefined ? defaultMimeType : input.mimeType);
    if (typeof mimeType !== 'string' || mimeType.length < 3 || mimeType.length > 128 || !mimeType.toLowerCase().startsWith(mimePrefix)) {
      const error = new Error(`mimeType must be a bounded ${mimePrefix.slice(0, -1)} MIME type.`);
      error.code = 'CAPTURE_OPTIONS_INVALID';
      error.field = 'mimeType';
      throw error;
    }
    const signal = input.signal;
    if (signal !== undefined && (signal === null || typeof signal !== 'object')) {
      const error = new Error('signal must be an AbortSignal-like object.');
      error.code = 'CAPTURE_OPTIONS_INVALID';
      error.field = 'signal';
      throw error;
    }
    return Object.freeze({
      ref: String(ref ?? ''),
      kind: kind.toLowerCase(),
      durationMs,
      maxBytes,
      maxMediaElements,
      maxTracks,
      maxCues,
      maxCaptionBytes,
      maxCueTextCharacters,
      stopTimeoutMs,
      mimeType,
      maxFrames: normalizeInteger(input.maxFrames, 'maxFrames', DEFAULTS.maxFrames, HARD_CAPS.maxFrames),
      maxFrameBytes: normalizeInteger(input.maxFrameBytes, 'maxFrameBytes', DEFAULTS.maxFrameBytes, HARD_CAPS.maxFrameBytes),
      maxTotalFrameBytes: normalizeInteger(input.maxTotalFrameBytes, 'maxTotalFrameBytes', DEFAULTS.maxTotalFrameBytes, HARD_CAPS.maxTotalFrameBytes),
      frameIntervalMs: normalizeInteger(input.frameIntervalMs, 'frameIntervalMs', DEFAULTS.frameIntervalMs, HARD_CAPS.frameIntervalMs),
      frameMimeType: typeof input.frameMimeType === 'string'
        ? input.frameMimeType
        : mimePrefix === 'image/' ? mimeType : DEFAULTS.frameMimeType,
      canvasFactory: input.canvasFactory ?? input.createCanvas ?? input.canvas ?? null,
      pageFingerprint: input.pageFingerprint ?? null,
      extractorPageFingerprint: input.extractorPageFingerprint ?? null,
      signal: signal ?? null,
      documentRef: input.documentRef ?? global.document,
      extractor: input.extractor ?? global.ToolBraidUniversalPageExtractor,
      mediaRecorder: input.mediaRecorder ?? input.MediaRecorder ?? global.MediaRecorder,
      setTimeoutRef: input.setTimeoutRef ?? ((callback, delay) => global.setTimeout(callback, delay)),
      clearTimeoutRef: input.clearTimeoutRef ?? ((timer) => global.clearTimeout(timer)),
    });
  }

  function normalizeFrameRequest(input = {}) {
    if (!plain(input)) {
      const error = new Error('Capture options must be a plain object.');
      error.code = 'CAPTURE_OPTIONS_INVALID';
      throw error;
    }
    const frameMimeType = input.frameMimeType ?? input.mimeType ?? DEFAULTS.frameMimeType;
    const normalized = normalizeRequest(input, { mimePrefix: 'image/', mimeTypeOverride: frameMimeType });
    if (normalized.kind !== 'video') {
      const error = new Error('Video keyframe capture requires kind video.');
      error.code = 'MEDIA_KIND_INVALID';
      throw error;
    }
    if (typeof normalized.frameMimeType !== 'string' || normalized.frameMimeType.length < 3
      || normalized.frameMimeType.length > 128 || !/^[a-z]+\/[a-z0-9!#$&^_.+-]+$/i.test(normalized.frameMimeType)
      || !normalized.frameMimeType.toLowerCase().startsWith('image/')) {
      const error = new Error('frameMimeType must be a bounded image MIME type.');
      error.code = 'CAPTURE_OPTIONS_INVALID';
      error.field = 'frameMimeType';
      throw error;
    }
    return normalized;
  }

  function pageMetadata(documentRef) {
    const location = safeRead(documentRef, 'location', null) ?? safeRead(global, 'location', null);
    const href = boundedText(safeRead(location, 'href', ''), 2048);
    const suppliedOrigin = boundedText(safeRead(location, 'origin', ''), 256);
    let origin = '';
    try {
      const parsed = new URL(href || suppliedOrigin);
      if (HTTP_PROTOCOLS.has(parsed.protocol) && !parsed.username && !parsed.password) {
        origin = parsed.origin;
      }
    } catch {
      // Metadata is optional; media capture does not need to resolve URLs.
    }
    return { origin: origin || null };
  }

  function elementTag(element) {
    const value = safeRead(element, 'localName', safeRead(element, 'tagName', ''));
    return String(value || '').toLowerCase();
  }

  function boundedList(value, limit) {
    const result = [];
    let length = 0;
    try { length = Math.min(Number(value?.length) || 0, limit); } catch { return result; }
    for (let index = 0; index < length; index += 1) {
      let item = null;
      try { item = value[index] ?? (typeof value.item === 'function' ? value.item(index) : null); } catch { item = null; }
      if (item) result.push(item);
    }
    return result;
  }

  function mediaElements(documentRef, limit) {
    if (!documentRef || typeof documentRef.querySelectorAll !== 'function') return null;
    try {
      return boundedList(documentRef.querySelectorAll('audio,video'), limit);
    } catch {
      try {
        return boundedList(documentRef.querySelectorAll('audio'), limit)
          .concat(boundedList(documentRef.querySelectorAll('video'), limit));
      } catch {
        return null;
      }
    }
  }

  function stableRef(extractor, documentRef, element) {
    const method = extractor?.getStableElementRef ?? extractor?.stableElementRef;
    if (typeof method !== 'function') return null;
    try {
      const value = method.call(extractor, documentRef, element);
      return typeof value === 'string' && value.length > 0 && value.length <= 256 ? value : null;
    } catch {
      return null;
    }
  }

  function resolveElement(request) {
    const elements = mediaElements(request.documentRef, request.maxMediaElements);
    if (!elements) return { error: failure('CAPTURE_UNSUPPORTED', 'The page media list is unavailable.') };
    const extractor = request.extractor;
    if (!extractor || typeof (extractor.getStableElementRef ?? extractor.stableElementRef) !== 'function') {
      return { error: failure('CAPTURE_UNSUPPORTED', 'The page extractor stable reference API is unavailable.') };
    }
    const matches = [];
    let sawReference = false;
    for (const element of elements) {
      const tag = elementTag(element);
      if (!MEDIA_KINDS.has(tag)) continue;
      const ref = stableRef(extractor, request.documentRef, element);
      if (!ref) continue;
      sawReference = true;
      if (ref === request.ref) matches.push({ element, tag, ref });
    }
    if (matches.length > 1) {
      return { error: failure('MEDIA_REF_AMBIGUOUS', 'The stable media reference resolved to more than one element.') };
    }
    if (matches.length === 0) {
      return { error: failure(sawReference ? 'MEDIA_ELEMENT_NOT_FOUND' : 'MEDIA_REF_UNAVAILABLE', 'The stable media element reference was not found.') };
    }
    const match = matches[0];
    if (match.tag !== request.kind) {
      return { error: failure('MEDIA_KIND_MISMATCH', 'The stable reference does not identify the requested media kind.', { expected: request.kind, actual: match.tag }) };
    }
    return match;
  }

  function encodedByteLength(text) {
    try {
      if (typeof TextEncoder === 'function') return new TextEncoder().encode(text).byteLength;
    } catch {
      // Fall through to a conservative character count.
    }
    return text.length;
  }

  function clipUtf8(text, maxBytes) {
    if (encodedByteLength(text) <= maxBytes) return text;
    let output = '';
    let bytes = 0;
    for (const character of text) {
      const size = encodedByteLength(character);
      if (bytes + size > maxBytes) break;
      output += character;
      bytes += size;
    }
    return output;
  }

  function boundedCaptionText(value, limit) {
    if (typeof value !== 'string') return '';
    return value
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ')
      .trim()
      .slice(0, limit);
  }

  function loadedCaptions(element, request) {
    const tracksValue = safeRead(element, 'textTracks', null);
    if (tracksValue === null) return { captions: [], status: 'unsupported', truncated: false, byteLength: 0 };
    const tracks = boundedList(tracksValue, request.maxTracks);
    let truncated = false;
    try { truncated = Number(tracksValue.length) > request.maxTracks; } catch { /* boundedList already failed closed */ }
    const captions = [];
    let totalBytes = 0;
    for (const track of tracks) {
      const kind = boundedCaptionText(safeRead(track, 'kind', ''), 64).toLowerCase();
      if (kind && !CAPTION_KINDS.has(kind)) continue;
      const cuesValue = safeRead(track, 'cues', null);
      if (cuesValue === null) continue;
      const cues = boundedList(cuesValue, request.maxCues);
      try { if (Number(cuesValue.length) > request.maxCues) truncated = true; } catch { /* ignore malformed lists */ }
      const cueRecords = [];
      for (const cue of cues) {
        const text = boundedCaptionText(safeRead(cue, 'text', ''), request.maxCueTextCharacters);
        if (!text) continue;
        const byteLength = encodedByteLength(text);
        if (totalBytes + byteLength > request.maxCaptionBytes) {
          truncated = true;
          break;
        }
        const startSeconds = Number(safeRead(cue, 'startTime', NaN));
        const endSeconds = Number(safeRead(cue, 'endTime', NaN));
        const startMs = Number.isFinite(startSeconds) && startSeconds >= 0 ? Math.min(Math.round(startSeconds * 1000), 86_400_000) : null;
        const endMs = Number.isFinite(endSeconds) && endSeconds >= 0 ? Math.min(Math.round(endSeconds * 1000), 86_400_000) : null;
        cueRecords.push({ startMs, endMs, text });
        totalBytes += byteLength;
      }
      if (!cueRecords.length) continue;
      captions.push({
        kind: kind || 'captions',
        language: boundedCaptionText(safeRead(track, 'language', safeRead(track, 'srclang', '')), 64) || null,
        label: boundedCaptionText(safeRead(track, 'label', ''), 256) || null,
        cues: cueRecords,
        text: clipUtf8(cueRecords.map((cue) => cue.text).join('\n'), request.maxCaptionBytes),
        byteLength: cueRecords.reduce((sum, cue) => sum + encodedByteLength(cue.text), 0),
      });
      if (captions.length >= request.maxTracks) {
        truncated = true;
        break;
      }
    }
    return { captions, status: captions.length ? 'ready' : 'empty', truncated, byteLength: totalBytes };
  }

  function captionResult(request) {
    try {
      const normalized = normalizeRequest(request);
      const resolved = resolveElement(normalized);
      if (resolved.error) return resolved.error;
      const info = loadedCaptions(resolved.element, normalized);
      const page = pageMetadata(normalized.documentRef);
      return {
        ok: true,
        status: info.status === 'ready' ? 'ok' : 'degraded',
        code: info.status === 'ready' ? 'CAPTIONS_READY' : info.status === 'unsupported' ? 'CAPTIONS_UNAVAILABLE' : 'CAPTIONS_EMPTY',
        metadata: {
          version: VERSION,
          elementRef: resolved.ref,
          sourceKind: resolved.tag,
          captionStatus: info.status,
          captionCount: info.captions.length,
          captionByteLength: info.byteLength,
          captionTruncated: info.truncated,
          pageOrigin: page.origin,
        },
        captions: info.captions,
        bytes: new Uint8Array(0),
      };
    } catch (error) {
      return failure(error?.code || 'CAPTURE_OPTIONS_INVALID', 'The caption request was rejected.', { field: error?.field });
    }
  }

  function frameError(code, message, details = {}) {
    const error = new Error(message);
    error.code = code;
    error.details = details;
    return error;
  }

  function frameDimensions(element) {
    const width = ['videoWidth', 'naturalWidth', 'clientWidth', 'width']
      .map((key) => Number(safeRead(element, key, NaN)))
      .find((value) => Number.isFinite(value) && value > 0);
    const height = ['videoHeight', 'naturalHeight', 'clientHeight', 'height']
      .map((key) => Number(safeRead(element, key, NaN)))
      .find((value) => Number.isFinite(value) && value > 0);
    if (!width || !height) return null;
    const maxDimension = 4096;
    const scale = Math.min(1, maxDimension / width, maxDimension / height);
    return {
      width: Math.max(1, Math.floor(width * scale)),
      height: Math.max(1, Math.floor(height * scale)),
    };
  }

  function isVisibleMedia(element, documentRef) {
    const visibility = safeRead(documentRef, 'visibilityState', 'visible');
    if (visibility === 'hidden') return false;
    const rect = safeCall(element, 'getBoundingClientRect', [], null);
    if (rect && (Number(rect.width) <= 0 || Number(rect.height) <= 0)) return false;
    return true;
  }

  function currentMediaTimeMs(element) {
    const seconds = Number(safeRead(element, 'currentTime', 0));
    return Number.isFinite(seconds) && seconds >= 0 ? Math.min(Math.round(seconds * 1000), 86_400_000) : 0;
  }

  function pageFingerprintFor(request) {
    const extractor = request.extractor;
    const method = extractor?.extractPageSnapshot ?? extractor?.extract;
    if (typeof method !== 'function') return null;
    let snapshot = null;
    try { snapshot = method.call(extractor, { documentRef: request.documentRef }); } catch {
      try { snapshot = method.call(extractor, request.documentRef); } catch { return null; }
    }
    const value = safeRead(snapshot, 'pageFingerprint', null);
    return typeof value === 'string' && value.length <= 256 ? value : null;
  }

  function assertFrameBinding(request, resolved) {
    if (request.extractorPageFingerprint) {
      const actual = pageFingerprintFor(request);
      if (!actual) {
        throw frameError('CAPTURE_BINDING_UNAVAILABLE', 'The page binding could not be verified during video keyframe capture.');
      }
      if (actual !== request.extractorPageFingerprint) {
        throw frameError('CAPTURE_PAGE_DRIFT', 'The page changed during video keyframe capture.');
      }
    }
    const rebound = resolveElement(request);
    if (rebound.error || rebound.element !== resolved.element || rebound.ref !== resolved.ref) {
      throw frameError('CAPTURE_PAGE_DRIFT', 'The video target changed during keyframe capture.');
    }
  }

  function canvasFor(request) {
    const candidate = request.canvasFactory;
    try {
      if (typeof candidate === 'function') return candidate();
      if (candidate && typeof candidate === 'object') return candidate;
      if (request.documentRef && typeof request.documentRef.createElement === 'function') {
        return request.documentRef.createElement('canvas');
      }
    } catch {
      return null;
    }
    return null;
  }

  function canvasBytes(canvas, request) {
    if (!canvas || typeof canvas.toBlob !== 'function') {
      return Promise.reject(frameError('CAPTURE_FRAME_UNSUPPORTED', 'Canvas frame encoding is unavailable.'));
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      let timer = null;
      let listener = null;
      const cleanup = () => {
        if (timer !== null) request.clearTimeoutRef(timer);
        try { request.signal?.removeEventListener?.('abort', listener); } catch { /* best effort */ }
      };
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) reject(error);
        else resolve(value);
      };
      listener = () => finish(frameError('CAPTURE_ABORTED', 'Rendered video keyframe capture was aborted.'));
      try { request.signal?.addEventListener?.('abort', listener, { once: true }); } catch { /* optional signal */ }
      timer = request.setTimeoutRef(() => finish(frameError('CAPTURE_FRAME_TIMEOUT', 'The video keyframe encoder exceeded its bounded timeout.')), request.stopTimeoutMs);
      if (request.signal?.aborted) {
        listener();
        return;
      }
      try {
        canvas.toBlob((blob) => {
          if (settled) return;
          let announcedSize = null;
          try {
            const candidate = Number(blob?.size ?? blob?.byteLength);
            announcedSize = Number.isFinite(candidate) && candidate >= 0 ? candidate : null;
          } catch { announcedSize = null; }
          if (announcedSize !== null && announcedSize > request.maxFrameBytes) {
            finish(frameError('CAPTURE_FRAME_OVERSIZED', 'The video keyframe exceeded maxFrameBytes.', { maxFrameBytes: request.maxFrameBytes }));
            return;
          }
          arrayBufferBytes(blob).then((bytes) => {
            if (settled) {
              bytes.fill(0);
              return;
            }
            if (bytes.byteLength > request.maxFrameBytes) {
              bytes.fill(0);
              finish(frameError('CAPTURE_FRAME_OVERSIZED', 'The video keyframe exceeded maxFrameBytes.', { maxFrameBytes: request.maxFrameBytes }));
              return;
            }
            finish(null, bytes);
          }, () => finish(frameError('CAPTURE_FRAME_ENCODING_FAILED', 'The video keyframe could not be read.')));
        }, request.frameMimeType);
      } catch {
        finish(frameError('CAPTURE_FRAME_ENCODING_FAILED', 'The video keyframe encoder failed.'));
      }
    });
  }

  function captureFrame(element, request, index, timeMs) {
    if (safeRead(element, 'mediaKeys', null) !== null) {
      return Promise.reject(frameError('DRM_MEDIA_UNSUPPORTED', 'Encrypted media cannot be captured by ToolBraid.'));
    }
    if (!isVisibleMedia(element, request.documentRef)) {
      return Promise.reject(frameError('MEDIA_NOT_VISIBLE', 'The video element is not visibly rendered.'));
    }
    const dimensions = frameDimensions(element);
    if (!dimensions) return Promise.reject(frameError('CAPTURE_FRAME_SIZE_INVALID', 'The rendered video dimensions are unavailable.'));
    const canvas = canvasFor(request);
    if (!canvas || typeof canvas.getContext !== 'function') {
      return Promise.reject(frameError('CAPTURE_FRAME_UNSUPPORTED', 'A canvas frame encoder is unavailable.'));
    }
    let context;
    try {
      canvas.width = dimensions.width;
      canvas.height = dimensions.height;
      context = canvas.getContext('2d', { alpha: false, desynchronized: true });
      if (!context || typeof context.drawImage !== 'function') throw new Error('2D canvas is unavailable.');
      context.drawImage(element, 0, 0, dimensions.width, dimensions.height);
    } catch {
      return Promise.reject(frameError('CAPTURE_FRAME_FAILED', 'The rendered video frame could not be drawn.'));
    }
    const clearCanvas = () => {
      try {
        context?.clearRect?.(0, 0, dimensions.width, dimensions.height);
        canvas.width = 0;
        canvas.height = 0;
      } catch { /* best effort */ }
    };
    return canvasBytes(canvas, request).then((bytes) => {
      clearCanvas();
      return {
        index,
        timeMs,
        mimeType: request.frameMimeType.toLowerCase(),
        width: dimensions.width,
        height: dimensions.height,
        byteLength: bytes.byteLength,
        bytes,
      };
    }, (error) => {
      clearCanvas();
      throw error;
    });
  }

  function waitForRenderedFrame(element, request) {
    if (typeof element?.requestVideoFrameCallback !== 'function') {
      return new Promise((resolve, reject) => {
        let timer = null;
        let listener = null;
        const cleanup = () => {
          if (timer !== null) request.clearTimeoutRef(timer);
          try { request.signal?.removeEventListener?.('abort', listener); } catch { /* best effort */ }
        };
        listener = () => { cleanup(); reject(frameError('CAPTURE_ABORTED', 'Rendered video keyframe capture was aborted.')); };
        try { request.signal?.addEventListener?.('abort', listener, { once: true }); } catch { /* optional signal */ }
        timer = request.setTimeoutRef(() => { cleanup(); resolve({ timeMs: currentMediaTimeMs(element) }); }, request.frameIntervalMs);
        if (request.signal?.aborted) listener();
      });
    }
    return new Promise((resolve, reject) => {
      let timer = null;
      let callbackId = null;
      let settled = false;
      let listener = null;
      const cleanup = () => {
        if (timer !== null) request.clearTimeoutRef(timer);
        try { request.signal?.removeEventListener?.('abort', listener); } catch { /* best effort */ }
        if (callbackId !== null) {
          try { element.cancelVideoFrameCallback?.(callbackId); } catch { /* best effort */ }
        }
      };
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) reject(error);
        else resolve(value);
      };
      listener = () => finish(frameError('CAPTURE_ABORTED', 'Rendered video keyframe capture was aborted.'));
      try { request.signal?.addEventListener?.('abort', listener, { once: true }); } catch { /* optional signal */ }
      timer = request.setTimeoutRef(() => finish(null, { timeMs: currentMediaTimeMs(element) }), request.frameIntervalMs);
      try {
        callbackId = element.requestVideoFrameCallback((_now, metadata) => {
          const seconds = Number(metadata?.mediaTime);
          finish(null, { timeMs: Number.isFinite(seconds) && seconds >= 0 ? Math.min(Math.round(seconds * 1000), 86_400_000) : currentMediaTimeMs(element) });
        });
      } catch {
        // The bounded timer fallback above remains authoritative.
      }
      if (request.signal?.aborted) listener();
    });
  }

  async function captureFrames(request = {}) {
    let normalized;
    try {
      normalized = normalizeFrameRequest(request);
      if (normalized.signal?.aborted) return failure('CAPTURE_ABORTED', 'Rendered video keyframe capture was aborted.');
    } catch (error) {
      return failure(error?.code || 'CAPTURE_OPTIONS_INVALID', 'The rendered video keyframe request was rejected.', { field: error?.field });
    }
    const resolved = resolveElement(normalized);
    if (resolved.error) return resolved.error;
    const captionsInfo = loadedCaptions(resolved.element, normalized);
    const page = pageMetadata(normalized.documentRef);
    const metadataBase = {
      version: VERSION,
      elementRef: normalized.ref,
      sourceKind: 'video',
      captureKind: 'frames',
      requestedFrameCount: normalized.maxFrames,
      requestedFrameBytes: normalized.maxFrameBytes,
      requestedTotalFrameBytes: normalized.maxTotalFrameBytes,
      captionStatus: captionsInfo.status,
      captionCount: captionsInfo.captions.length,
      captionByteLength: captionsInfo.byteLength,
      captionTruncated: captionsInfo.truncated,
      pageOrigin: page.origin,
      ...(normalized.extractorPageFingerprint ? { extractorPageFingerprint: normalized.extractorPageFingerprint } : {}),
    };
    const frames = [];
    const clearFrames = () => {
      for (const frame of frames) {
        try { frame.bytes?.fill?.(0); } catch { /* best effort */ }
      }
      frames.length = 0;
    };
    const failed = (error) => {
      clearFrames();
      return failure(error?.code || 'CAPTURE_FRAME_FAILED', error?.message || 'Rendered video keyframe capture failed.', error?.details ?? {}, {
        ...metadataBase,
        frameCount: 0,
        frameByteLength: 0,
      });
    };
    try {
      assertFrameBinding(normalized, resolved);
      for (let index = 0; index < normalized.maxFrames; index += 1) {
        if (normalized.signal?.aborted) throw frameError('CAPTURE_ABORTED', 'Rendered video keyframe capture was aborted.');
        assertFrameBinding(normalized, resolved);
        let timeMs = currentMediaTimeMs(resolved.element);
        if (index > 0) timeMs = (await waitForRenderedFrame(resolved.element, normalized)).timeMs;
        const frame = await captureFrame(resolved.element, normalized, index, timeMs);
        try {
          if (frames.reduce((sum, item) => sum + item.byteLength, 0) + frame.byteLength > normalized.maxTotalFrameBytes) {
            throw frameError('CAPTURE_FRAMES_OVERSIZED', 'The rendered video frames exceeded maxTotalFrameBytes.', { maxTotalFrameBytes: normalized.maxTotalFrameBytes });
          }
          assertFrameBinding(normalized, resolved);
          frames.push(frame);
        } catch (error) {
          frame.bytes.fill(0);
          throw error;
        }
      }
      const frameByteLength = frames.reduce((sum, frame) => sum + frame.byteLength, 0);
      return {
        ok: true,
        status: captionsInfo.status === 'ready' ? 'ok' : 'degraded',
        code: 'CAPTURE_FRAMES_OK',
        degradedCode: captionsInfo.status === 'ready' ? null : captionsInfo.status === 'unsupported' ? 'CAPTIONS_UNAVAILABLE' : 'CAPTIONS_EMPTY',
        message: captionsInfo.status === 'ready' ? 'Rendered video keyframes captured.' : 'Rendered video keyframes captured without loaded captions.',
        details: {},
        metadata: { ...metadataBase, frameCount: frames.length, frameByteLength },
        captions: captionsInfo.captions,
        frames,
        bytes: new Uint8Array(0),
      };
    } catch (error) {
      return failed(error);
    }
  }

  function recorderType(ctor, preferred) {
    const candidates = [preferred, 'audio/webm', 'audio/ogg'];
    for (const candidate of candidates) {
      try {
        if (typeof ctor.isTypeSupported === 'function' && !ctor.isTypeSupported(candidate)) continue;
      } catch {
        continue;
      }
      return candidate;
    }
    return null;
  }

  function arrayBufferBytes(value) {
    if (value instanceof Uint8Array) return Promise.resolve(new Uint8Array(value));
    if (value instanceof ArrayBuffer) return Promise.resolve(new Uint8Array(value.slice(0)));
    if (ArrayBuffer.isView(value)) return Promise.resolve(new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)));
    if (value && typeof value.arrayBuffer === 'function') {
      return Promise.resolve().then(() => value.arrayBuffer()).then((buffer) => {
        if (!(buffer instanceof ArrayBuffer)) throw new Error('Recorder data is not an ArrayBuffer.');
        return new Uint8Array(buffer);
      });
    }
    return Promise.reject(new Error('Recorder data is not byte-backed.'));
  }

  function tracksFor(stream) {
    const all = [];
    const add = (value) => {
      for (const item of boundedList(value, 256)) if (!all.includes(item)) all.push(item);
    };
    add(safeCall(stream, 'getTracks', [], []));
    const audio = safeCall(stream, 'getAudioTracks', [], null);
    if (audio !== null) add(audio);
    const audioTracks = audio !== null
      ? boundedList(audio, 256)
      : all.filter((track) => safeRead(track, 'kind', 'audio') !== 'video');
    return { all, audio: audioTracks };
  }

  function stopTracks(tracks) {
    for (const track of tracks) {
      try { if (typeof track?.stop === 'function') track.stop(); } catch { /* cleanup is best effort */ }
    }
  }

  function recordRendered(element, request, captionsInfo) {
    const metadataBase = {
      version: VERSION,
      elementRef: request.ref,
      sourceKind: request.kind,
      captureKind: 'audio',
      requestedDurationMs: request.durationMs,
      captionStatus: captionsInfo.status,
      captionCount: captionsInfo.captions.length,
      captionByteLength: captionsInfo.byteLength,
      captionTruncated: captionsInfo.truncated,
      ...(() => {
        const page = pageMetadata(request.documentRef);
        return { pageOrigin: page.origin };
      })(),
    };
    if (safeRead(element, 'mediaKeys', null) !== null) {
      return Promise.resolve(failure('DRM_MEDIA_UNSUPPORTED', 'Encrypted media cannot be captured by ToolBraid.', {}, metadataBase));
    }
    if (safeRead(element, 'paused', null) === true || safeRead(element, 'ended', false) === true) {
      return Promise.resolve(failure('MEDIA_NOT_PLAYING', 'Start media playback before requesting rendered audio capture.', {}, metadataBase));
    }
    const ctor = request.mediaRecorder;
    if (typeof ctor !== 'function' || typeof element?.captureStream !== 'function') {
      return Promise.resolve(failure('CAPTURE_UNSUPPORTED', 'Rendered captureStream or MediaRecorder is unavailable.', {}, metadataBase));
    }
    const mimeType = recorderType(ctor, request.mimeType);
    if (!mimeType) return Promise.resolve(failure('CAPTURE_UNSUPPORTED', 'No supported audio recording MIME type is available.', {}, metadataBase));
    let stream;
    try {
      stream = element.captureStream();
    } catch {
      return Promise.resolve(failure('CAPTURE_UNSUPPORTED', 'The media element did not expose a rendered capture stream.', {}, metadataBase));
    }
    const trackSet = tracksFor(stream);
    if (!trackSet.all.length || !trackSet.audio.length) {
      stopTracks(trackSet.all);
      return Promise.resolve(failure('CAPTURE_EMPTY', 'The rendered stream has no usable audio track.', {}, metadataBase));
    }
    let recorder;
    try {
      recorder = new ctor(stream, { mimeType });
    } catch {
      stopTracks(trackSet.all);
      return Promise.resolve(failure('CAPTURE_UNSUPPORTED', 'The MediaRecorder could not be created.', {}, metadataBase));
    }
    const setTimer = request.setTimeoutRef;
    const clearTimer = request.clearTimeoutRef;
    if (typeof setTimer !== 'function' || typeof clearTimer !== 'function') {
      stopTracks(trackSet.all);
      return Promise.resolve(failure('CAPTURE_UNSUPPORTED', 'Capture timers are unavailable.', {}, metadataBase));
    }
    return new Promise((resolve) => {
      let settled = false;
      let finalizing = false;
      let stopRequested = false;
      let durationTimer = null;
      let stopTimer = null;
      let chunkQueue = Promise.resolve();
      let chunks = [];
      let totalBytes = 0;
      const startedAt = Date.now();
      const signal = request.signal;
      const abortListener = () => finish('CAPTURE_ABORTED', 'Rendered media capture was aborted.');

      function clearTimers() {
        if (durationTimer !== null) clearTimer(durationTimer);
        if (stopTimer !== null) clearTimer(stopTimer);
        durationTimer = null;
        stopTimer = null;
      }

      function detachAbort() {
        try { signal?.removeEventListener?.('abort', abortListener); } catch { /* ignore malformed signals */ }
      }

      function stopRecorder() {
        if (stopRequested) return;
        stopRequested = true;
        try {
          if (recorder.state !== 'inactive' && typeof recorder.stop === 'function') recorder.stop();
        } catch {
          finish('CAPTURE_TIMEOUT', 'The recorder could not be stopped cleanly.');
        }
      }

      function cleanup() {
        clearTimers();
        detachAbort();
        if (!stopRequested) {
          stopRequested = true;
          try {
            if (recorder.state !== 'inactive' && typeof recorder.stop === 'function') recorder.stop();
          } catch { /* best effort */ }
        }
        stopTracks(trackSet.all);
        for (const chunk of chunks) {
          try { chunk.fill(0); } catch { /* cleanup is best effort */ }
        }
        chunks = [];
      }

      function finish(code, message, details = {}) {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(failure(code, message, details, { ...metadataBase, mimeType }));
      }

      async function finishStopped() {
        if (settled || finalizing) return;
        finalizing = true;
        clearTimers();
        try {
          await chunkQueue;
          if (settled) return;
          if (signal?.aborted) {
            finish('CAPTURE_ABORTED', 'Rendered media capture was aborted.');
            return;
          }
          if (totalBytes < 1) {
            finish('CAPTURE_EMPTY', 'The rendered recorder produced no audio bytes.');
            return;
          }
          const output = new Uint8Array(totalBytes);
          let offset = 0;
          for (const chunk of chunks) {
            output.set(chunk, offset);
            offset += chunk.length;
          }
          const capturedDurationMs = Math.max(0, Math.min(request.durationMs, Date.now() - startedAt));
          settled = true;
          cleanup();
          resolve({
            ok: true,
            status: captionsInfo.status === 'ready' ? 'ok' : 'degraded',
            code: captionsInfo.status === 'ready' ? 'CAPTURE_OK' : 'CAPTURE_DEGRADED',
            degradedCode: captionsInfo.status === 'ready' ? null : captionsInfo.status === 'unsupported' ? 'CAPTIONS_UNAVAILABLE' : 'CAPTIONS_EMPTY',
            message: captionsInfo.status === 'ready' ? 'Rendered audio captured.' : 'Rendered audio captured without loaded captions.',
            details: {},
            metadata: {
              ...metadataBase,
              mimeType: boundedText(recorder.mimeType || mimeType, 128) || mimeType,
              byteLength: output.byteLength,
              capturedDurationMs,
            },
            captions: captionsInfo.captions,
            bytes: output,
          });
        } catch {
          finish('CAPTURE_RECORDER_FAILED', 'Recorder bytes could not be read.');
        }
      }

      function queueChunk(data) {
        let announcedSize = null;
        try {
          const value = Number(data?.size ?? data?.byteLength);
          announcedSize = Number.isFinite(value) && value >= 0 ? value : null;
        } catch { announcedSize = null; }
        if (announcedSize !== null && totalBytes + announcedSize > request.maxBytes) {
          finish('CAPTURE_OVERSIZED', 'The rendered recording exceeded maxBytes.', { maxBytes: request.maxBytes });
          return;
        }
        chunkQueue = chunkQueue.then(async () => {
          if (settled) return;
          const bytes = await arrayBufferBytes(data);
          if (settled) {
            bytes.fill(0);
            return;
          }
          if (totalBytes + bytes.byteLength > request.maxBytes) {
            bytes.fill(0);
            finish('CAPTURE_OVERSIZED', 'The rendered recording exceeded maxBytes.', { maxBytes: request.maxBytes });
            return;
          }
          chunks.push(bytes);
          totalBytes += bytes.byteLength;
        }).catch(() => finish('CAPTURE_RECORDER_FAILED', 'Recorder data could not be read.'));
      }

      function requestStop() {
        if (settled) return;
        stopRecorder();
        if (!settled) stopTimer = setTimer(() => finish('CAPTURE_TIMEOUT', 'The recorder did not finish within the bounded stop timeout.'), request.stopTimeoutMs);
      }

      recorder.ondataavailable = (event) => {
        if (settled) return;
        queueChunk(safeRead(event, 'data', null));
      };
      recorder.onerror = () => finish('CAPTURE_RECORDER_FAILED', 'The rendered recorder reported an error.');
      recorder.onstop = () => { void finishStopped(); };
      if (signal?.aborted) {
        finish('CAPTURE_ABORTED', 'Rendered media capture was aborted.');
        return;
      }
      try { signal?.addEventListener?.('abort', abortListener, { once: true }); } catch { /* optional signal */ }
      try {
        recorder.start();
      } catch {
        finish('CAPTURE_UNSUPPORTED', 'The rendered recorder could not start.');
        return;
      }
      durationTimer = setTimer(requestStop, request.durationMs);
    });
  }

  async function capture(request = {}) {
    const mode = safeRead(request, 'mode');
    const captureKind = safeRead(request, 'captureKind');
    if (mode === 'frames' || mode === 'keyframes' || captureKind === 'frames' || captureKind === 'keyframes') {
      return captureFrames(request);
    }
    let normalized;
    try {
      normalized = normalizeRequest(request);
      if (normalized.signal?.aborted) return failure('CAPTURE_ABORTED', 'Rendered media capture was aborted.');
    } catch (error) {
      return failure(error?.code || 'CAPTURE_OPTIONS_INVALID', 'The rendered media capture request was rejected.', { field: error?.field });
    }
    const resolved = resolveElement(normalized);
    if (resolved.error) return resolved.error;
    const captionsInfo = loadedCaptions(resolved.element, normalized);
    return recordRendered(resolved.element, normalized, captionsInfo);
  }

  const api = Object.freeze({
    version: VERSION,
    defaults: DEFAULTS,
    hardCaps: HARD_CAPS,
    capture,
    captureRenderedMedia: capture,
    captureFrames,
    captureKeyframes: captureFrames,
    captureRenderedFrames: captureFrames,
    readCaptions: captionResult,
    readLoadedCaptions: captionResult,
  });
  global.ToolBraidRenderedMediaCapture = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
