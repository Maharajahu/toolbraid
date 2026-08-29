import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createDeterministicMultimodalAdapter,
  createMultimodalPipeline,
  normalizeMediaAsset,
} from '../../src/multimodal/index.js';

test('normalizes and fingerprints bounded media assets without URL credentials', () => {
  const asset = normalizeMediaAsset({
    kind: 'image',
    url: 'https://example.test/hero.png',
    mimeType: 'image/png',
    width: 1280,
    height: 720,
    altText: 'Checkout status',
  }, { pageOrigin: 'https://example.test' });

  assert.match(asset.id, /^media-[a-f0-9]{16}$/);
  assert.match(asset.fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(asset.kind, 'image');
  assert.throws(() => normalizeMediaAsset({ kind: 'image', url: 'https://user:pass@example.test/a.png' }), /credentials/i);
});

test('preserves only extension-owned bound video evidence through normalization', () => {
  const binding = {
    pageOrigin: 'https://example.test',
    frameId: '0',
    sessionId: 'session-video',
    pageFingerprint: 'a'.repeat(64),
    elementRef: 'id:video',
  };
  const video = normalizeMediaAsset({
    id: 'video',
    kind: 'video',
    url: 'https://example.test/video.mp4',
    pageOrigin: binding.pageOrigin,
    frameId: binding.frameId,
    elementRef: binding.elementRef,
    captureBinding: binding,
    keyframes: [{
      id: 'frame',
      kind: 'image',
      source: 'capture',
      handle: 'tb-media-frame',
      mimeType: 'image/png',
      byteLength: 3,
      pageOrigin: binding.pageOrigin,
      frameId: binding.frameId,
      captureBinding: binding,
      timeMs: 1_000,
    }],
  });

  assert.equal(video.keyframes.length, 1);
  assert.equal(video.keyframes[0].handle, 'tb-media-frame');
  assert.equal(video.keyframes[0].timeMs, 1_000);
  assert.deepEqual(video.captureBinding, binding);
  assert.throws(() => normalizeMediaAsset({
    ...video,
    captureBinding: binding,
    pageFingerprint: 'b'.repeat(64),
  }), /conflicts/i);
  assert.throws(() => normalizeMediaAsset({
    kind: 'video',
    url: 'https://example.test/video.mp4',
    keyframes: [{ kind: 'image', source: 'dom', url: 'https://evil.test/frame.png' }],
  }), /extension-owned/i);
});

test('runs a supported adapter and marks model-derived content as untrusted', async () => {
  const pipeline = createMultimodalPipeline({
    adapters: [createDeterministicMultimodalAdapter()],
    now: () => new Date('2026-08-28T12:00:00.000Z'),
  });
  const report = await pipeline.analyzeAssets([{
    kind: 'image',
    url: 'https://example.test/hero.png',
    altText: 'Current deployment is healthy',
  }]);

  assert.equal(report.stats.completed, 1);
  assert.equal(report.results[0].text, 'Current deployment is healthy');
  assert.equal(report.results[0].untrustedContent, true);
  assert.equal(report.results[0].provider.id, 'deterministic');
  assert.match(report.results[0].fingerprint, /^[a-f0-9]{64}$/);
});

test('falls back across adapters and caches the successful normalized result', async () => {
  let successfulCalls = 0;
  const failing = {
    id: 'primary', version: '1', priority: 10,
    supports: () => true,
    analyze: async () => { throw new Error('provider unavailable'); },
  };
  const fallback = createDeterministicMultimodalAdapter({
    id: 'fallback', priority: 1,
    analyze: async () => {
      successfulCalls += 1;
      return { summary: 'fallback result', confidence: 0.8 };
    },
  });
  const pipeline = createMultimodalPipeline({ adapters: [failing, fallback] });
  const asset = { kind: 'image', url: 'https://example.test/image.png' };

  const first = await pipeline.analyzeAssets([asset]);
  const second = await pipeline.analyzeAssets([asset]);
  assert.equal(first.results[0].provider.id, 'fallback');
  assert.equal(second.results[0].cache.hit, true);
  assert.equal(successfulCalls, 1);
});

test('blocks oversized assets, degrades unsupported modalities, and honors cancellation', async () => {
  const pipeline = createMultimodalPipeline({ adapters: [], limits: { image: { maxBytes: 10 } } });
  const report = await pipeline.analyzeAssets([
    { kind: 'image', url: 'https://example.test/large.png', byteLength: 11 },
    { kind: 'audio', url: 'https://example.test/voice.wav' },
  ]);
  assert.equal(report.results[0].status, 'blocked');
  assert.equal(report.results[1].status, 'degraded');

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    pipeline.analyzeAssets([{ kind: 'image', url: 'https://example.test/a.png' }], { signal: controller.signal }),
    /abort/i,
  );
});

test('redaction can block media before an adapter receives it', async () => {
  let called = false;
  const adapter = createDeterministicMultimodalAdapter({ analyze: async () => { called = true; return {}; } });
  const pipeline = createMultimodalPipeline({
    adapters: [adapter],
    redact: async () => ({ allowed: false, reason: 'USER_PRIVATE_MEDIA' }),
  });
  const report = await pipeline.analyzeAssets([{ kind: 'image', url: 'https://example.test/private.png' }]);
  assert.equal(report.results[0].status, 'blocked');
  assert.equal(report.results[0].reason, 'USER_PRIVATE_MEDIA');
  assert.equal(called, false);
});
