import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MULTIMODAL_CONFIG_KEY,
  MULTIMODAL_SECRET_KEY,
  createConfiguredMultimodalAdapter,
  createMultimodalSettingsStore,
  normalizeMultimodalConfig,
  permissionOriginForBaseUrl,
} from '../../extension/multimodal-provider.js';

function memoryArea() {
  const values = {};
  return {
    values,
    async get(key) { return { [key]: values[key] }; },
    async set(input) { Object.assign(values, structuredClone(input)); },
    async remove(key) { delete values[key]; },
  };
}

function volatileEntry(handle = 'tb-media-shot', {
  bytes = new Uint8Array([1, 2, 3]),
  mimeType = 'image/png',
  expiresAt = 2_000,
} = {}) {
  return {
    handle,
    bytes,
    byteLength: bytes.byteLength,
    expiresAt,
    metadata: { mimeType },
  };
}

function configuredSettings(overrides = {}) {
  return {
    async read() {
      return {
        enabled: true,
        baseUrl: 'https://api.example.test/v1/',
        visionModel: 'vision-model',
        audioModel: '',
        apiKey: 'secret',
        ...overrides,
      };
    },
  };
}

function adapterFixture({ settings = configuredSettings(), entry = volatileEntry(), fetchImpl, now = () => 1_000 } = {}) {
  let handleReads = 0;
  const adapter = createConfiguredMultimodalAdapter({
    settings,
    handleStore: {
      get(handle) {
        handleReads += 1;
        assert.equal(handle, entry.handle);
        return entry;
      },
    },
    fetchImpl: fetchImpl ?? (async () => ({
      ok: true,
      async json() {
        return {
          model: 'vision-model',
          choices: [{ message: { content: JSON.stringify({ summary: 'ok' }) } }],
        };
      },
    })),
    now,
  });
  return { adapter, getHandleReads: () => handleReads };
}

test('normalizes only HTTPS or loopback OpenAI-compatible endpoints and derives one exact permission origin', () => {
  const config = normalizeMultimodalConfig({
    enabled: true,
    baseUrl: 'https://vision.example.test/v1',
    visionModel: 'vision-large',
    audioModel: 'whisper-1',
  });
  assert.equal(config.baseUrl, 'https://vision.example.test/v1/');
  assert.equal(config.permissionOrigin, 'https://vision.example.test/*');
  assert.equal(permissionOriginForBaseUrl('http://127.0.0.1:11434/v1/'), 'http://127.0.0.1:11434/*');
  assert.throws(
    () => normalizeMultimodalConfig({ enabled: true, baseUrl: 'http://remote.example/v1/', visionModel: 'vision' }),
    (error) => error.code === 'MULTIMODAL_ENDPOINT_INVALID',
  );
  assert.throws(
    () => normalizeMultimodalConfig({ enabled: true, baseUrl: 'https://key@api.example/v1/', visionModel: 'vision' }),
    (error) => error.code === 'MULTIMODAL_ENDPOINT_INVALID',
  );
});

test('rejects HTTPS SSRF targets and hostname tricks while retaining public HTTPS and loopback HTTP', () => {
  for (const baseUrl of [
    'https://127.0.0.1/v1/',
    'https://localhost/v1/',
    'https://169.254.169.254/latest/',
    'https://2130706433/v1/',
    'https://[::1]/v1/',
    'https://metadata.google.internal/v1/',
    'https://api.example.test./v1/',
    'ftp://api.example.test/v1/',
    'http://remote.example/v1/',
  ]) {
    assert.throws(
      () => normalizeMultimodalConfig({ enabled: true, baseUrl, visionModel: 'vision' }),
      (error) => error.code === 'MULTIMODAL_ENDPOINT_INVALID',
      baseUrl,
    );
  }
  assert.equal(
    normalizeMultimodalConfig({ enabled: true, baseUrl: 'http://[::1]:11434/v1/', visionModel: 'vision' }).permissionOrigin,
    'http://[::1]:11434/*',
  );
});

test('rejects forged versions, inherited configuration, and prototype-shaped values', async () => {
  assert.throws(
    () => normalizeMultimodalConfig({ enabled: true, version: 99, baseUrl: 'https://api.example.test/v1/', visionModel: 'vision' }),
    (error) => error.code === 'MULTIMODAL_CONFIG_INVALID',
  );
  const inherited = Object.create({
    enabled: true,
    baseUrl: 'https://api.example.test/v1/',
    visionModel: 'vision',
  });
  assert.throws(
    () => normalizeMultimodalConfig(inherited),
    (error) => error.code === 'MULTIMODAL_CONFIG_INVALID',
  );

  const localArea = { async get(key) { return { [key]: inherited }; } };
  const sessionArea = { async get() { return {}; } };
  const store = createMultimodalSettingsStore({ localArea, sessionArea, permissionsApi: { async request() { return true; } } });
  const state = await store.read();
  assert.equal(state.enabled, false);
  assert.equal(state.apiKey, '');
  assert.equal((await store.publicState()).hasApiKey, false);
});

test('stores public provider settings locally, keeps the key in session storage, and requests only the exact origin', async () => {
  const localArea = memoryArea();
  const sessionArea = memoryArea();
  const requests = [];
  const store = createMultimodalSettingsStore({
    localArea,
    sessionArea,
    permissionsApi: {
      async request(input) { requests.push(input); return true; },
    },
  });
  const publicState = await store.save({
    baseUrl: 'https://api.example.test/v1/',
    visionModel: 'vision',
    audioModel: 'asr',
    apiKey: 'session-secret',
  });
  assert.deepEqual(requests, [{ origins: ['https://api.example.test/*'] }]);
  assert.equal(localArea.values[MULTIMODAL_CONFIG_KEY].apiKey, undefined);
  assert.equal(sessionArea.values[MULTIMODAL_SECRET_KEY], 'session-secret');
  assert.equal(publicState.hasApiKey, true);
  assert.equal('apiKey' in publicState, false);
  assert.equal((await store.read()).apiKey, 'session-secret');

  const disabled = await store.disable();
  assert.equal(disabled.enabled, false);
  assert.equal(sessionArea.values[MULTIMODAL_SECRET_KEY], undefined);
});

test('does not persist provider configuration when optional host permission is denied', async () => {
  const localArea = memoryArea();
  const store = createMultimodalSettingsStore({
    localArea,
    sessionArea: memoryArea(),
    permissionsApi: { async request() { return false; } },
  });
  await assert.rejects(
    store.save({ baseUrl: 'https://api.example.test/v1/', visionModel: 'vision' }),
    (error) => error.code === 'MULTIMODAL_PERMISSION_DENIED',
  );
  assert.equal(localArea.values[MULTIMODAL_CONFIG_KEY], undefined);
});

test('configured vision adapter resolves only an extension-owned volatile handle and sends bounded provider input', async () => {
  const calls = [];
  const adapter = createConfiguredMultimodalAdapter({
    settings: {
      async read() {
        return {
          enabled: true,
          baseUrl: 'https://api.example.test/v1/',
          visionModel: 'vision-model',
          audioModel: '',
          apiKey: 'secret',
        };
      },
    },
    handleStore: {
      get(handle) {
        assert.equal(handle, 'tb-media-shot');
        return volatileEntry();
      },
    },
    now: () => 1_000,
    async fetchImpl(url, options) {
      calls.push({ url, options });
      return {
        ok: true,
        async json() {
          return {
            model: 'vision-model',
            choices: [{ message: { content: JSON.stringify({ summary: 'A release dashboard', text: 'Ready', confidence: 0.9 }) } }],
          };
        },
      };
    },
  });
  const result = await adapter.analyze({
    id: 'shot',
    kind: 'image',
    handle: 'tb-media-shot',
    mimeType: 'image/png',
    byteLength: 3,
  });
  assert.equal(result.summary, 'A release dashboard');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.example.test/v1/chat/completions');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer secret');
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.model, 'vision-model');
  assert.match(body.messages[1].content[1].image_url.url, /^data:image\/png;base64,/);
});

test('supports callback-style Chrome APIs and never leaks runtime.lastError text', async () => {
  const previousChrome = globalThis.chrome;
  globalThis.chrome = { runtime: { lastError: null } };
  const values = {};
  const localArea = {
    get(key, callback) { callback({ [key]: values[key] }); },
    set(input, callback) { Object.assign(values, input); callback(); },
  };
  const sessionArea = {
    get(key, callback) { callback({ [key]: values[key] }); },
    set(input, callback) { Object.assign(values, input); callback(); },
    remove(key, callback) { delete values[key]; callback(); },
  };
  const requests = [];
  try {
    const store = createMultimodalSettingsStore({
      localArea,
      sessionArea,
      permissionsApi: { request(input, callback) { requests.push(input); callback(true); } },
    });
    await store.save({ baseUrl: 'https://api.example.test/v1/', visionModel: 'vision', apiKey: 'secret' });
    assert.deepEqual(requests, [{ origins: ['https://api.example.test/*'] }]);
    assert.equal(values[MULTIMODAL_SECRET_KEY], 'secret');

    localArea.get = (key, callback) => {
      globalThis.chrome.runtime.lastError = { message: 'secret storage failure: secret' };
      callback();
      globalThis.chrome.runtime.lastError = null;
    };
    await assert.rejects(store.read(), (error) => {
      assert.equal(error.code, 'MULTIMODAL_STORAGE_READ_FAILED');
      return !error.message.includes('secret');
    });
  } finally {
    globalThis.chrome = previousChrome;
  }
});

test('converts promise-style Chrome failures to stable non-sensitive provider errors', async () => {
  const store = createMultimodalSettingsStore({
    localArea: { async get() { throw new Error('local key secret'); } },
    sessionArea: { async get() { return {}; } },
    permissionsApi: { async request() { throw new Error('permission secret'); } },
  });
  await assert.rejects(store.read(), (error) => {
    assert.equal(error.code, 'MULTIMODAL_STORAGE_READ_FAILED');
    return !error.message.includes('secret');
  });

  const denied = createMultimodalSettingsStore({
    localArea: memoryArea(),
    sessionArea: memoryArea(),
    permissionsApi: { async request() { throw new Error('permission secret'); } },
  });
  await assert.rejects(
    denied.save({ baseUrl: 'https://api.example.test/v1/', visionModel: 'vision' }),
    (error) => error.code === 'MULTIMODAL_PERMISSION_FAILED' && !error.message.includes('secret'),
  );
});

test('requires separate session storage before accepting a provider key', async () => {
  const area = memoryArea();
  const store = createMultimodalSettingsStore({
    localArea: area,
    sessionArea: area,
    permissionsApi: { async request() { throw new Error('permission must not be requested'); } },
  });
  await assert.rejects(
    store.save({ baseUrl: 'https://api.example.test/v1/', visionModel: 'vision', apiKey: 'secret' }),
    (error) => error.code === 'MULTIMODAL_STORAGE_UNAVAILABLE' && !error.message.includes('secret'),
  );
  assert.equal(area.values[MULTIMODAL_CONFIG_KEY], undefined);
});

test('fails closed for expired, mismatched, malformed, and oversized volatile handles', async () => {
  for (const entry of [
    volatileEntry('tb-media-shot', { expiresAt: 999 }),
    { ...volatileEntry('tb-media-other'), handle: 'tb-media-other' },
    { ...volatileEntry(), bytes: new ArrayBuffer(3), byteLength: 3 },
    { ...volatileEntry(), byteLength: 2 },
    volatileEntry('tb-media-shot', { bytes: new Uint8Array(15 * 1024 * 1024 + 1) }),
  ]) {
    let fetched = false;
    const { adapter } = adapterFixture({
      entry,
      fetchImpl: async () => { fetched = true; throw new Error('must not fetch'); },
    });
    const result = await adapter.analyze({ kind: 'image', handle: 'tb-media-shot', mimeType: 'image/png' });
    assert.equal(result.model, 'toolbraid-metadata-only');
    assert.equal(fetched, false);
  }

  let fetched = false;
  const { adapter } = adapterFixture({
    entry: volatileEntry('tb-media-shot'),
    fetchImpl: async () => { fetched = true; throw new Error('must not fetch'); },
  });
  const unsafe = await adapter.analyze({ kind: 'image', handle: 'tb-media-../../secret', mimeType: 'image/png' });
  assert.equal(unsafe.model, 'toolbraid-metadata-only');
  assert.equal(fetched, false);
});

test('normalizes forged settings before network use and redacts provider failures/results', async () => {
  let fetched = false;
  const forged = adapterFixture({
    settings: configuredSettings({ baseUrl: 'https://127.0.0.1/v1/' }),
    fetchImpl: async () => { fetched = true; throw new Error('secret'); },
  });
  const blocked = await forged.adapter.analyze({ kind: 'image', handle: 'tb-media-shot', mimeType: 'image/png' });
  assert.equal(blocked.model, 'toolbraid-metadata-only');
  assert.equal(fetched, false);

  const leaking = adapterFixture({
    fetchImpl: async () => ({
      ok: true,
      async json() {
        return {
          model: 'secret',
          choices: [{ message: { content: JSON.stringify({ summary: 'secret', text: 'safe' }) } }],
        };
      },
    }),
  });
  const sanitized = await leaking.adapter.analyze({ kind: 'image', handle: 'tb-media-shot', mimeType: 'image/png' });
  assert.equal(sanitized.summary, '[redacted]');
  assert.equal(sanitized.model, '[redacted]');
  assert.equal(JSON.stringify(sanitized).includes('secret'), false);

  const failed = adapterFixture({
    fetchImpl: async () => ({ ok: false, status: 502, async text() { return 'upstream leaked secret'; } }),
  });
  const fallback = await failed.adapter.analyze({ kind: 'image', handle: 'tb-media-shot', mimeType: 'image/png' });
  assert.equal(fallback.model, 'toolbraid-metadata-only');
  assert.equal(JSON.stringify(fallback).includes('secret'), false);
});

test('supports bounded audio transcription and keeps MIME-derived filenames inert', async () => {
  const calls = [];
  const { adapter } = adapterFixture({
    settings: configuredSettings({ audioModel: 'asr-model' }),
    entry: volatileEntry('tb-media-audio', { mimeType: 'audio/webm; codecs=opus' }),
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return {
        ok: true,
        async json() { return { text: 'hello', language: 'en', model: 'asr-model', segments: [{ start: 0, end: 1, text: 'hello' }] }; },
      };
    },
  });
  const result = await adapter.analyze({ kind: 'audio', handle: 'tb-media-audio', mimeType: 'audio/webm' });
  assert.equal(result.transcript, 'hello');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.example.test/v1/audio/transcriptions');
  const formEntries = [];
  for (const [key, value] of calls[0].options.body.entries()) formEntries.push([key, value]);
  assert.equal(formEntries.find(([key]) => key === 'model')[1], 'asr-model');
  const file = formEntries.find(([key]) => key === 'file')[1];
  assert.equal(file.name, 'toolbraid-audio.webm');
});

test('propagates cancellation before settings, handle resolution, and provider fetch', async () => {
  const controller = new AbortController();
  controller.abort();
  let settingsReads = 0;
  let handleReads = 0;
  const { adapter } = adapterFixture({
    settings: { async read() { settingsReads += 1; return configuredSettings(); } },
    fetchImpl: async () => { throw new Error('must not fetch'); },
  });
  adapter.analyze({ kind: 'image', handle: 'tb-media-shot', mimeType: 'image/png' }, { signal: controller.signal })
    .catch(() => undefined);
  await assert.rejects(
    adapter.analyze({ kind: 'image', handle: 'tb-media-shot', mimeType: 'image/png' }, { signal: controller.signal }),
    (error) => error.name === 'AbortError',
  );
  assert.equal(settingsReads, 0);
  assert.equal(handleReads, 0);

  const pending = adapterFixture({ settings: { read() { return new Promise(() => {}); } } });
  const active = new AbortController();
  const cancellation = pending.adapter.analyze({ kind: 'image', handle: 'tb-media-shot', mimeType: 'image/png' }, { signal: active.signal });
  active.abort();
  await assert.rejects(cancellation, (error) => error.name === 'AbortError');
});

test('propagates an abort raised by the provider fetch instead of claiming metadata success', async () => {
  const controller = new AbortController();
  const { adapter } = adapterFixture({
    fetchImpl: async (_url, { signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError')), { once: true });
    }),
  });
  const running = adapter.analyze({ kind: 'image', handle: 'tb-media-shot', mimeType: 'image/png' }, { signal: controller.signal });
  controller.abort();
  await assert.rejects(running, (error) => error.name === 'AbortError');
});

test('metadata-only mode still produces explicit evidence without network authority', async () => {
  let fetched = false;
  const adapter = createConfiguredMultimodalAdapter({
    settings: { async read() { return { enabled: false }; } },
    handleStore: { get() { throw new Error('must not resolve'); } },
    async fetchImpl() { fetched = true; throw new Error('must not fetch'); },
  });
  const result = await adapter.analyze({ id: 'image', kind: 'image', altText: 'Deployment graph' });
  assert.equal(result.summary, 'Deployment graph');
  assert.equal(result.model, 'toolbraid-metadata-only');
  assert.equal(fetched, false);
});
