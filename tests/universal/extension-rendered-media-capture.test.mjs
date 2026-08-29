import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../../extension/rendered-media-capture.js', import.meta.url), 'utf8');

class FakeTrack {
  constructor(kind = 'audio') {
    this.kind = kind;
    this.stopCalls = 0;
    this.readyState = 'live';
  }

  stop() {
    this.stopCalls += 1;
    this.readyState = 'ended';
  }
}

class FakeElement {
  constructor(tag, ref, { tracks = [], textTracks = [] } = {}) {
    this.localName = tag;
    this.ref = ref;
    this.textTracks = textTracks;
    this.stream = {
      getTracks: () => tracks,
      getAudioTracks: () => tracks.filter((track) => track.kind === 'audio'),
    };
    this.captureCalls = 0;
  }

  captureStream() {
    this.captureCalls += 1;
    return this.stream;
  }
}

class EmittingRecorder {
  static isTypeSupported(type) {
    return type === 'audio/webm;codecs=opus' || type === 'audio/webm';
  }

  constructor(stream, options) {
    this.stream = stream;
    this.mimeType = options.mimeType;
    this.state = 'inactive';
    this.stopCalls = 0;
  }

  start() {
    this.state = 'recording';
  }

  stop() {
    this.stopCalls += 1;
    this.state = 'inactive';
    this.ondataavailable?.({ data: new Uint8Array([1, 2, 3, 4]) });
    this.onstop?.();
  }
}

class OversizedRecorder extends EmittingRecorder {
  stop() {
    this.stopCalls += 1;
    this.state = 'inactive';
    this.ondataavailable?.({ data: new Uint8Array([1, 2, 3, 4, 5]) });
    this.onstop?.();
  }
}

class HangingRecorder extends EmittingRecorder {
  stop() {
    this.stopCalls += 1;
    this.state = 'inactive';
  }
}

class DelayedChunkRecorder extends EmittingRecorder {
  static readStarted = null;
  static resolveBuffer = null;

  stop() {
    this.stopCalls += 1;
    this.state = 'inactive';
    this.ondataavailable?.({
      data: {
        size: 4,
        arrayBuffer() {
          DelayedChunkRecorder.readStarted?.();
          return new Promise((resolve) => { DelayedChunkRecorder.resolveBuffer = resolve; });
        },
      },
    });
    this.onstop?.();
  }
}

function cue(startTime, endTime, text) {
  return { startTime, endTime, text };
}

function load({
  elements,
  recorder = EmittingRecorder,
  fetchImpl = () => { throw new Error('fetch must not be called'); },
  locationHref = 'https://example.test/watch',
} = {}) {
  const elementByRef = new Map(elements.map((element) => [element.ref, element]));
  const location = new URL(locationHref);
  const documentRef = {
    location: { href: location.href, origin: location.origin },
    querySelectorAll(selector) {
      assert.equal(selector, 'audio,video');
      return elements;
    },
  };
  const extractor = {
    getStableElementRef(_document, element) {
      return elementByRef.has(element.ref) ? element.ref : null;
    },
  };
  const context = vm.createContext({
    Array,
    ArrayBuffer,
    Date,
    Map,
    Object,
    Promise,
    Set,
    TextEncoder,
    Uint8Array,
    URL,
    clearTimeout,
    console,
    document: documentRef,
    fetch: fetchImpl,
    setTimeout,
    MediaRecorder: recorder,
    ToolBraidUniversalPageExtractor: extractor,
  });
  vm.runInContext(source, context, { filename: 'rendered-media-capture.js' });
  return { api: context.ToolBraidRenderedMediaCapture, elements, context };
}

function request(fields = {}) {
  return Object.assign(Object.create(null), fields);
}

test('captures rendered audio bytes, reads loaded cues, and stops recorder tracks', async () => {
  const track = new FakeTrack();
  const video = new FakeElement('video', 'id:video', {
    tracks: [track],
    textTracks: [{
      kind: 'captions',
      language: 'en',
      label: 'English',
      cues: [cue(1, 2.5, 'Hello <b>world</b>')],
    }],
  });
  const { api } = load({ elements: [video] });
  const result = await api.capture(request({
    elementRef: 'id:video',
    kind: 'video',
    durationMs: 5,
    stopTimeoutMs: 20,
  }));

  assert.equal(result.ok, true);
  assert.equal(result.code, 'CAPTURE_OK');
  assert.deepEqual([...result.bytes], [1, 2, 3, 4]);
  assert.equal(result.metadata.sourceKind, 'video');
  assert.equal(result.metadata.captureKind, 'audio');
  assert.equal(result.captions[0].cues[0].startMs, 1000);
  assert.equal(result.captions[0].cues[0].endMs, 2500);
  assert.equal(result.captions[0].cues[0].text, 'Hello <b>world</b>');
  assert.equal(track.stopCalls, 1);
  assert.equal(video.captureCalls, 1);
});

test('requires an exact extractor reference and exact media kind', async () => {
  const audio = new FakeElement('audio', 'id:audio', { tracks: [new FakeTrack()] });
  const { api } = load({ elements: [audio] });
  const missing = await api.capture(request({ elementRef: 'id:missing', kind: 'audio', durationMs: 5 }));
  const wrongKind = await api.capture(request({ elementRef: 'id:audio', kind: 'video', durationMs: 5 }));

  assert.equal(missing.code, 'MEDIA_ELEMENT_NOT_FOUND');
  assert.equal(wrongKind.code, 'MEDIA_KIND_MISMATCH');
  assert.equal(missing.bytes.byteLength, 0);
});

test('fails closed when recorder data exceeds maxBytes and cleans up', async () => {
  const track = new FakeTrack();
  const audio = new FakeElement('audio', 'id:audio', { tracks: [track] });
  const { api } = load({ elements: [audio], recorder: OversizedRecorder });
  const result = await api.capture(request({
    elementRef: 'id:audio',
    kind: 'audio',
    durationMs: 5,
    maxBytes: 4,
    stopTimeoutMs: 20,
  }));

  assert.equal(result.code, 'CAPTURE_OVERSIZED');
  assert.equal(track.stopCalls, 1);
  assert.equal(result.bytes.byteLength, 0);
});

test('aborts in flight capture and stops the active track', async () => {
  const track = new FakeTrack();
  const audio = new FakeElement('audio', 'id:audio', { tracks: [track] });
  const { api } = load({ elements: [audio], recorder: HangingRecorder });
  const controller = new AbortController();
  const pending = api.capture(request({
    elementRef: 'id:audio',
    kind: 'audio',
    durationMs: 1000,
    stopTimeoutMs: 100,
    signal: controller.signal,
  }));
  await Promise.resolve();
  controller.abort();
  const result = await pending;

  assert.equal(result.code, 'CAPTURE_ABORTED');
  assert.equal(track.stopCalls, 1);
});

test('zeroes a recorder chunk that resolves after capture abort cleanup', async () => {
  const track = new FakeTrack();
  const audio = new FakeElement('audio', 'id:audio', { tracks: [track] });
  const { api } = load({ elements: [audio], recorder: DelayedChunkRecorder });
  let markReadStarted;
  const readStarted = new Promise((resolve) => { markReadStarted = resolve; });
  DelayedChunkRecorder.readStarted = markReadStarted;
  DelayedChunkRecorder.resolveBuffer = null;
  const controller = new AbortController();
  const pending = api.capture(request({
    elementRef: 'id:audio',
    kind: 'audio',
    durationMs: 5,
    stopTimeoutMs: 100,
    signal: controller.signal,
  }));
  await readStarted;
  controller.abort();
  const result = await pending;
  const lateBytes = new Uint8Array([9, 8, 7, 6]);
  DelayedChunkRecorder.resolveBuffer(lateBytes.buffer);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(result.code, 'CAPTURE_ABORTED');
  assert.deepEqual([...lateBytes], [0, 0, 0, 0]);
  assert.equal(track.stopCalls, 1);
});

test('reports a bounded stop timeout while cleaning recorder and tracks', async () => {
  const track = new FakeTrack();
  const audio = new FakeElement('audio', 'id:audio', { tracks: [track] });
  const { api } = load({ elements: [audio], recorder: HangingRecorder });
  const result = await api.capture(request({
    elementRef: 'id:audio',
    kind: 'audio',
    durationMs: 5,
    stopTimeoutMs: 5,
  }));

  assert.equal(result.code, 'CAPTURE_TIMEOUT');
  assert.equal(track.stopCalls, 1);
});

test('returns explicit unsupported and option-cap codes without touching the DOM', async () => {
  const audio = new FakeElement('audio', 'id:audio', { tracks: [new FakeTrack()] });
  const unsupported = load({ elements: [audio], recorder: null });
  const unsupportedResult = await unsupported.api.capture(request({ elementRef: 'id:audio', kind: 'audio', durationMs: 5 }));
  const { api } = load({ elements: [audio] });
  const capped = await api.capture(request({
    elementRef: 'id:audio',
    kind: 'audio',
    durationMs: api.hardCaps.durationMs + 1,
  }));

  assert.equal(unsupportedResult.code, 'CAPTURE_UNSUPPORTED');
  assert.equal(capped.code, 'CAPTURE_OPTIONS_INVALID');
  assert.equal(audio.captureCalls, 0);
});

test('caption reads never resolve or fetch track URLs and remain bounded', async () => {
  let fetchCalls = 0;
  const video = new FakeElement('video', 'id:video', {
    tracks: [new FakeTrack()],
    textTracks: [{
      kind: 'subtitles',
      language: 'ro',
      label: 'Romanian',
      src: 'https://evil.example/subtitles.vtt',
      cues: [cue(0, 1, 'Loaded locally')],
    }],
  });
  const { api } = load({ elements: [video], fetchImpl: () => { fetchCalls += 1; } });
  const result = api.readCaptions(request({ elementRef: 'id:video', kind: 'video', maxCaptionBytes: 64 }));

  assert.equal(result.code, 'CAPTIONS_READY');
  assert.equal(result.captions[0].language, 'ro');
  assert.equal(fetchCalls, 0);
  assert.equal(video.captureCalls, 0);
});

test('rejects paused and encrypted media explicitly before captureStream', async () => {
  const paused = new FakeElement('video', 'id:paused', { tracks: [new FakeTrack()] });
  paused.paused = true;
  const encrypted = new FakeElement('video', 'id:encrypted', { tracks: [new FakeTrack()] });
  encrypted.mediaKeys = {};
  const { api } = load({ elements: [paused, encrypted] });

  const pausedResult = await api.capture(request({ elementRef: 'id:paused', kind: 'video', durationMs: 5 }));
  const encryptedResult = await api.capture(request({ elementRef: 'id:encrypted', kind: 'video', durationMs: 5 }));

  assert.equal(pausedResult.code, 'MEDIA_NOT_PLAYING');
  assert.equal(encryptedResult.code, 'DRM_MEDIA_UNSUPPORTED');
  assert.equal(paused.captureCalls, 0);
  assert.equal(encrypted.captureCalls, 0);
});

test('captures bounded visible video keyframes without resolving the media URL', async () => {
  const video = new FakeElement('video', 'id:video', { textTracks: [] });
  video.videoWidth = 640;
  video.videoHeight = 360;
  video.currentTime = 1.25;
  video.getBoundingClientRect = () => ({ width: 640, height: 360 });
  video.requestVideoFrameCallback = (callback) => {
    callback(0, { mediaTime: video.currentTime });
    return 1;
  };
  let frame = 0;
  const canvases = [];
  const canvasFactory = () => {
    const canvas = {
    width: 0,
    height: 0,
    getContext() {
      return { drawImage() { frame += 1; }, clearRect() {} };
    },
    toBlob(callback) {
      callback(new Uint8Array([frame, frame + 1]));
    },
    };
    canvases.push(canvas);
    return canvas;
  };
  let resolvedUrl = false;
  const { api } = load({
    elements: [video],
    locationHref: 'https://example.test/watch?token=SUPERSECRET#private',
    fetchImpl: () => { resolvedUrl = true; throw new Error('must not fetch'); },
  });
  const result = await api.captureFrames(request({
    elementRef: 'id:video',
    kind: 'video',
    maxFrames: 2,
    frameIntervalMs: 1,
    maxFrameBytes: 8,
    maxTotalFrameBytes: 8,
    canvasFactory,
  }));

  assert.equal(result.ok, true);
  assert.equal(result.code, 'CAPTURE_FRAMES_OK');
  assert.equal(result.metadata.captureKind, 'frames');
  assert.equal(result.frames.length, 2);
  assert.deepEqual([...result.frames[0].bytes], [1, 2]);
  assert.deepEqual([...result.frames[1].bytes], [2, 3]);
  assert.equal(result.frames[0].timeMs, 1250);
  assert.equal(resolvedUrl, false);
  assert.equal(Object.hasOwn(result.metadata, 'pageUrl'), false);
  assert.equal(JSON.stringify(result).includes('SUPERSECRET'), false);
  assert.ok(canvases.every((canvas) => canvas.width === 0 && canvas.height === 0));
});

test('fails closed for DRM, hidden, and oversized video keyframe capture', async () => {
  const encrypted = new FakeElement('video', 'id:encrypted');
  encrypted.videoWidth = 320;
  encrypted.videoHeight = 180;
  encrypted.mediaKeys = {};
  const hidden = new FakeElement('video', 'id:hidden');
  hidden.videoWidth = 320;
  hidden.videoHeight = 180;
  hidden.getBoundingClientRect = () => ({ width: 0, height: 0 });
  const oversized = new FakeElement('video', 'id:oversized');
  oversized.videoWidth = 320;
  oversized.videoHeight = 180;
  const canvasFactory = () => ({
    getContext() { return { drawImage() {} }; },
    toBlob(callback) { callback(new Uint8Array([1, 2, 3, 4])); },
  });
  const { api } = load({ elements: [encrypted, hidden, oversized] });

  const encryptedResult = await api.captureFrames(request({ elementRef: 'id:encrypted', kind: 'video', canvasFactory }));
  const hiddenResult = await api.captureFrames(request({ elementRef: 'id:hidden', kind: 'video', canvasFactory }));
  const oversizedResult = await api.captureFrames(request({
    elementRef: 'id:oversized',
    kind: 'video',
    canvasFactory,
    maxFrameBytes: 3,
  }));

  assert.equal(encryptedResult.code, 'DRM_MEDIA_UNSUPPORTED');
  assert.equal(hiddenResult.code, 'MEDIA_NOT_VISIBLE');
  assert.equal(oversizedResult.code, 'CAPTURE_FRAME_OVERSIZED');
});

test('aborts pending frame encoding and rejects page binding drift', async () => {
  const video = new FakeElement('video', 'id:video');
  video.videoWidth = 320;
  video.videoHeight = 180;
  video.getBoundingClientRect = () => ({ width: 320, height: 180 });
  const controller = new AbortController();
  let encodeCallback;
  const { api } = load({ elements: [video] });
  const pending = api.capture(request({
    mode: 'frames',
    elementRef: 'id:video',
    kind: 'video',
    maxFrames: 1,
    signal: controller.signal,
    canvasFactory: () => ({
      getContext() { return { drawImage() {} }; },
      toBlob(callback) { encodeCallback = callback; },
    }),
  }));
  controller.abort();
  const aborted = await pending;
  assert.equal(aborted.code, 'CAPTURE_ABORTED');
  encodeCallback?.(new Uint8Array([1]));

  let pageFingerprint = 'initial';
  const driftingVideo = new FakeElement('video', 'id:drifting');
  driftingVideo.videoWidth = 320;
  driftingVideo.videoHeight = 180;
  driftingVideo.getBoundingClientRect = () => ({ width: 320, height: 180 });
  const extractor = {
    getStableElementRef(_document, element) { return element.ref; },
    extractPageSnapshot() { return { pageFingerprint }; },
  };
  const drifting = load({ elements: [driftingVideo] }).api;
  const drifted = await drifting.captureFrames(request({
    elementRef: 'id:drifting',
    kind: 'video',
    extractor,
    extractorPageFingerprint: 'initial',
    maxFrames: 1,
    canvasFactory: () => ({
      getContext() { return { drawImage() {} }; },
      toBlob(callback) {
        pageFingerprint = 'changed';
        callback(new Uint8Array([1]));
      },
    }),
  }));
  assert.equal(drifted.code, 'CAPTURE_PAGE_DRIFT');
  assert.equal(drifted.frames?.length ?? 0, 0);
});
