import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createCompositeVideoAdapter,
  createOpenAiCompatibleAudioAdapter,
  createOpenAiCompatibleVisionAdapter,
} from '../../src/multimodal/index.js';

test('vision adapter sends a bounded JSON-only analysis request to an HTTPS endpoint', async () => {
  let request;
  const adapter = createOpenAiCompatibleVisionAdapter({
    baseUrl: 'https://models.example.test/v1',
    model: 'vision-model',
    getApiKey: async () => 'secret-test-key',
    resolveImage: async () => 'data:image/png;base64,AAAA',
    fetchImpl: async (url, init) => {
      request = { url, init };
      return new Response(JSON.stringify({
        model: 'vision-model-2026',
        choices: [{ message: { content: '{"summary":"A release dashboard","text":"Healthy","labels":["dashboard"],"confidence":0.9}' } }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    },
  });

  const result = await adapter.analyze({ id: 'image-1', kind: 'image' });
  assert.equal(request.url, 'https://models.example.test/v1/chat/completions');
  assert.equal(request.init.headers.Authorization, 'Bearer secret-test-key');
  const body = JSON.parse(request.init.body);
  assert.match(body.messages[0].content, /untrusted web page/i);
  assert.equal(body.response_format.type, 'json_object');
  assert.equal(result.summary, 'A release dashboard');
  assert.equal(result.model, 'vision-model-2026');
});

test('multimodal endpoints reject insecure non-loopback HTTP and URL credentials', () => {
  const common = { model: 'm', resolveImage: async () => 'data:image/png;base64,AA==' };
  assert.throws(() => createOpenAiCompatibleVisionAdapter({ ...common, baseUrl: 'http://models.example.test/v1' }), /HTTPS|loopback/i);
  assert.throws(() => createOpenAiCompatibleVisionAdapter({ ...common, baseUrl: 'https://user:pass@example.test/v1' }), /credentials/i);
  assert.doesNotThrow(() => createOpenAiCompatibleVisionAdapter({ ...common, baseUrl: 'http://127.0.0.1:11434/v1' }));
});

test('audio adapter uploads a resolved Blob and normalizes verbose transcription', async () => {
  let form;
  const adapter = createOpenAiCompatibleAudioAdapter({
    baseUrl: 'http://localhost:8000/v1/',
    model: 'whisper-compatible',
    resolveAudio: async () => ({ blob: new Blob(['audio'], { type: 'audio/wav' }), name: 'clip.wav' }),
    fetchImpl: async (_url, init) => {
      form = init.body;
      return new Response(JSON.stringify({ text: 'Deployment recovered.', language: 'en', segments: [{ start: 0, end: 1 }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    },
  });
  const result = await adapter.analyze({ id: 'audio-1', kind: 'audio', mimeType: 'audio/wav' });
  assert.equal(form.get('model'), 'whisper-compatible');
  assert.equal(form.get('file').name, 'clip.wav');
  assert.equal(result.transcript, 'Deployment recovered.');
  assert.equal(result.language, 'en');
});

test('composite video adapter combines keyframe evidence and optional transcript', async () => {
  const visionAdapter = {
    id: 'vision',
    analyze: async (asset) => ({ summary: `frame ${asset.id}`, text: 'Checkout', labels: ['ui'] }),
  };
  const audioAdapter = {
    id: 'asr',
    analyze: async () => ({ transcript: 'The checkout recovered.', language: 'en', segments: [] }),
  };
  const adapter = createCompositeVideoAdapter({
    visionAdapter,
    audioAdapter,
    extractVideo: async () => ({
      frames: [
        { id: 'f1', url: 'data:image/png;base64,AA==', timeMs: 0 },
        { id: 'f2', url: 'data:image/png;base64,AA==', timeMs: 1000 },
      ],
      audioAsset: { id: 'a1', handle: 'audio-handle' },
    }),
  });
  const result = await adapter.analyze({ id: 'video-1', kind: 'video' });
  assert.equal(result.keyframes.length, 2);
  assert.equal(result.transcript, 'The checkout recovered.');
  assert.equal(result.model, 'vision+asr');
});
