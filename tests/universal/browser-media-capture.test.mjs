import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BrowserMediaCaptureError,
  createBrowserMediaCapture,
  createMediaHandleStore,
} from '../../src/multimodal/index.js';

const pageLocation = Object.freeze({
  href: 'https://page.example/article',
  origin: 'https://page.example',
});

function makeElement(tagName, attributes = {}, properties = {}, children = []) {
  const element = {
    localName: tagName,
    tagName: tagName.toUpperCase(),
    ...properties,
    children,
    parentElement: null,
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(attributes, name) ? attributes[name] : null;
    },
    querySelectorAll(selector) {
      const wanted = selector === 'track' ? 'track' : selector === 'source' ? 'source' : null;
      if (!wanted) return [];
      const found = [];
      const visit = (candidate) => {
        for (const child of candidate.children ?? []) {
          if (child.localName === wanted) found.push(child);
          visit(child);
        }
      };
      visit(element);
      return found;
    },
  };
  for (const child of children) child.parentElement = element;
  return element;
}

function makeDocument(elements) {
  return {
    location: pageLocation,
    querySelectorAll(selector) {
      assert.equal(selector, 'img, audio, video');
      return elements;
    },
  };
}

function response({ body = new Uint8Array([1, 2, 3]), url = 'https://page.example/image.png', type = 'image/png', status = 200 } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    url,
    headers: { get(name) { return name.toLowerCase() === 'content-type' ? type : null; } },
    arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
  };
}

test('inventories normalizable DOM media assets, records captions, and enforces the asset cap', () => {
  const image = makeElement('img', { src: '/hero.png', alt: 'A hero image' }, { naturalWidth: 640, naturalHeight: 360 });
  const video = makeElement('video', { src: '/demo.mp4', controls: '' }, { duration: 12.5 }, [
    makeElement('track', { kind: 'captions', src: '/captions.vtt', srclang: 'en', label: 'English' }),
  ]);
  const capture = createBrowserMediaCapture({
    documentRef: makeDocument([image, video]),
    locationRef: pageLocation,
    limits: { maxAssets: 1 },
    cryptoRef: { randomUUID: () => 'inventory-test' },
  });

  const inventory = capture.inventory();
  assert.equal(inventory.assets.length, 1);
  assert.equal(inventory.assets[0].url, 'https://page.example/hero.png');
  assert.equal(inventory.assets[0].kind, 'image');
  assert.equal(inventory.assets[0].altText, 'A hero image');
  assert.equal(inventory.tracks.length, 0, 'tracks outside the capped asset set are not collected');
  assert.equal(inventory.truncated, true);
});

test('fails closed for cross-origin inventory URLs unless an explicit origin is allowed', () => {
  const crossOrigin = makeElement('img', { src: 'https://cdn.example/image.png' });
  const denied = createBrowserMediaCapture({
    documentRef: makeDocument([crossOrigin]),
    locationRef: pageLocation,
    cryptoRef: { randomUUID: () => 'cross-origin-denied' },
  }).inventory();
  assert.equal(denied.assets.length, 0);
  assert.equal(denied.rejected[0].reason, 'MEDIA_ORIGIN_BLOCKED');

  const allowed = createBrowserMediaCapture({
    documentRef: makeDocument([crossOrigin]),
    locationRef: pageLocation,
    allowedOrigins: ['https://cdn.example'],
    cryptoRef: { randomUUID: () => 'cross-origin-allowed' },
  }).inventory();
  assert.equal(allowed.assets.length, 1);
  assert.equal(allowed.assets[0].crossOrigin, true);
});

test('captures a visible tab through the injected chrome API and stores only a volatile handle', async () => {
  const calls = [];
  const capture = createBrowserMediaCapture({
    documentRef: makeDocument([]),
    locationRef: pageLocation,
    captureVisibleTab: async (windowId, options) => {
      calls.push({ windowId, options });
      return 'data:image/png;base64,AAECAw==';
    },
    cryptoRef: { randomUUID: () => 'screenshot-test' },
  });

  const screenshot = await capture.captureVisibleScreenshot({ windowId: 7 });
  assert.equal(screenshot.kind, 'image');
  assert.equal(screenshot.source, 'capture');
  assert.equal(screenshot.capture, 'visible-tab');
  assert.match(screenshot.handle, /^tb-media-/);
  assert.equal(screenshot.asset.handle, screenshot.handle);
  assert.deepEqual([...capture.handleStore.get(screenshot.handle).bytes], [0, 1, 2, 3]);
  assert.deepEqual(calls, [{ windowId: 7, options: { format: 'png' } }]);
});

test('fetches only bounded same-origin media and rejects oversized or incorrect MIME responses', async () => {
  const calls = [];
  const capture = createBrowserMediaCapture({
    documentRef: makeDocument([]),
    locationRef: pageLocation,
    limits: { image: { maxBytes: 4 } },
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return response({ body: new Uint8Array([5, 6, 7, 8]) });
    },
    cryptoRef: { randomUUID: () => 'fetch-test' },
  });
  const asset = await capture.fetchAsset({ kind: 'image', url: '/photo.png' });
  assert.equal(asset.byteLength, 4);
  assert.deepEqual([...capture.handleStore.get(asset.handle).bytes], [5, 6, 7, 8]);
  assert.equal(calls[0].options.credentials, 'omit');
  assert.equal(calls[0].options.mode, 'same-origin');
  assert.equal(calls[0].options.cache, 'no-store');

  const oversized = createBrowserMediaCapture({
    documentRef: makeDocument([]),
    locationRef: pageLocation,
    limits: { image: { maxBytes: 3 } },
    fetchImpl: async () => response({ body: new Uint8Array([1, 2, 3, 4]) }),
    cryptoRef: { randomUUID: () => 'oversized-test' },
  });
  await assert.rejects(oversized.fetchAsset({ kind: 'image', url: '/too-large.png' }), (error) => {
    assert.ok(error instanceof BrowserMediaCaptureError);
    return error.code === 'MEDIA_BYTES_EXCEEDED';
  });

  const wrongMime = createBrowserMediaCapture({
    documentRef: makeDocument([]),
    locationRef: pageLocation,
    fetchImpl: async () => response({ type: 'text/html' }),
    cryptoRef: { randomUUID: () => 'mime-test' },
  });
  await assert.rejects(wrongMime.fetchAsset({ kind: 'image', url: '/not-image' }), /MIME/i);
});

test('requires explicit cross-origin policy for media fetches and then uses CORS mode', async () => {
  let called = false;
  const denied = createBrowserMediaCapture({
    documentRef: makeDocument([]),
    locationRef: pageLocation,
    fetchImpl: async () => { called = true; return response({ url: 'https://cdn.example/photo.png' }); },
    cryptoRef: { randomUUID: () => 'fetch-cross-denied' },
  });
  await assert.rejects(denied.fetchAsset({ kind: 'image', url: 'https://cdn.example/photo.png' }), /origin/i);
  assert.equal(called, false);

  let request;
  const allowed = createBrowserMediaCapture({
    documentRef: makeDocument([]),
    locationRef: pageLocation,
    allowedOrigins: ['https://cdn.example'],
    fetchImpl: async (url, options) => {
      request = { url, options };
      return response({ url, body: new Uint8Array([9]), type: 'image/png' });
    },
    cryptoRef: { randomUUID: () => 'fetch-cross-allowed' },
  });
  await allowed.fetchAsset({ kind: 'image', url: 'https://cdn.example/photo.png' });
  assert.equal(request.options.mode, 'cors');
  assert.equal(request.options.credentials, 'omit');
});

test('reads same-origin caption tracks as bounded, untrusted VTT cues', async () => {
  const track = makeElement('track', { kind: 'captions', src: '/captions.vtt', srclang: 'en', label: 'English' });
  const video = makeElement('video', { src: '/demo.mp4' }, {}, [track]);
  const capture = createBrowserMediaCapture({
    documentRef: makeDocument([video]),
    locationRef: pageLocation,
    fetchImpl: async () => response({
      url: 'https://page.example/captions.vtt',
      type: 'text/vtt',
      body: new TextEncoder().encode('WEBVTT\n\n00:00:01.000 --> 00:00:02.500\nHello <b>world</b>\n'),
    }),
    cryptoRef: { randomUUID: () => 'caption-test' },
  });
  const inventory = capture.inventory();
  const captions = await capture.readCaptions(inventory.tracks);
  assert.equal(captions.length, 1);
  assert.equal(captions[0].language, 'en');
  assert.equal(captions[0].cues[0].startMs, 1000);
  assert.equal(captions[0].cues[0].endMs, 2500);
  assert.equal(captions[0].cues[0].text, 'Hello <b>world</b>');
});

test('honors cancellation before any browser or network operation', async () => {
  const controller = new AbortController();
  controller.abort();
  let screenshotCalled = false;
  const capture = createBrowserMediaCapture({
    documentRef: makeDocument([]),
    locationRef: pageLocation,
    captureVisibleTab: async () => { screenshotCalled = true; return 'data:image/png;base64,AA=='; },
    fetchImpl: async () => { throw new Error('must not fetch'); },
    cryptoRef: { randomUUID: () => 'abort-test' },
  });
  await assert.rejects(capture.captureVisibleScreenshot({ signal: controller.signal }), /abort/i);
  await assert.rejects(capture.fetchAsset({ kind: 'image', url: '/x.png' }, { signal: controller.signal }), /abort/i);
  assert.equal(screenshotCalled, false);
});
