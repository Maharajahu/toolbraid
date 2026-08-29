import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createExtensionHandoffRuntime,
} from '../../extension/handoff-runtime.js';
import {
  HANDOFF_STATES,
  syntheticUiIntent,
} from '../../src/runtime/handoff-broker.js';

const PERSISTENCE_KEY = 'toolbraid-extension-handoff-test-key-2026-08-29';
const ORIGIN = 'https://example.test';
const RAW_PAGE_URL = 'https://example.test/login?next=%2Fdashboard#fragment-secret';
const RAW_CREDENTIAL_URL = 'https://alice:password-secret@example.test/login?otp=otp-secret#fragment-secret';
let requestSequence = 0;

const BINDING = Object.freeze({
  missionId: 'mission-handoff',
  memberId: 'member-handoff',
  tabId: 7,
  frameId: 0,
  windowId: 19,
  sessionId: 'tab-7-session-handoff',
  documentId: 'document-handoff-0123456789abcdef',
  pageInstanceId: 'page-instance-handoff-0123456789abcdef',
  origin: ORIGIN,
  pageFingerprint: 'page-handoff-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  targetFingerprint: 'target-login-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  purpose: 'authenticate at example.test',
  safeOrigin: ORIGIN,
});

function clone(value) {
  return structuredClone(value);
}

function makeStorage({ failSet = false, delayMs = 0 } = {}) {
  const data = {};
  const calls = [];
  let activeWrites = 0;
  let maxConcurrentWrites = 0;
  return {
    data,
    calls,
    get maxConcurrentWrites() { return maxConcurrentWrites; },
    async get(key) {
      calls.push({ method: 'get', key });
      return { [key]: data[key] };
    },
    async set(values) {
      calls.push({ method: 'set', values: clone(values) });
      activeWrites += 1;
      maxConcurrentWrites = Math.max(maxConcurrentWrites, activeWrites);
      try {
        if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
        if (failSet) throw new Error('password-secret storage failure');
        Object.assign(data, clone(values));
      } finally {
        activeWrites -= 1;
      }
    },
    async remove(key) {
      calls.push({ method: 'remove', key });
      delete data[key];
    },
  };
}

function makeChrome(storage) {
  const calls = {
    tabsCreate: [],
    windowsCreate: [],
    tabsUpdate: [],
    tabsQuery: [],
    tabsSendMessage: [],
    scriptInjection: [],
    screenshots: [],
  };
  const chromeApi = {
    runtime: { id: 'toolbraid-handoff-extension-test' },
    storage: { local: storage, session: storage },
    tabs: {
      async create(input) {
        calls.tabsCreate.push(clone(input));
        throw new Error('worker must not create the human surface');
      },
      async update(tabId, input) {
        calls.tabsUpdate.push({ tabId, input: clone(input) });
        throw new Error('worker must not navigate the human surface');
      },
      async query(input) {
        calls.tabsQuery.push(clone(input));
        return [{ id: BINDING.tabId, windowId: BINDING.windowId, url: RAW_PAGE_URL }];
      },
      async sendMessage(tabId, message, options) {
        calls.tabsSendMessage.push({ tabId, message: clone(message), options: clone(options) });
        throw new Error('handoff runtime must not message the surface');
      },
      async captureVisibleTab(windowId, options) {
        calls.screenshots.push({ windowId, options: clone(options) });
        throw new Error('handoff runtime must not capture the surface');
      },
    },
    windows: {
      async create(input) {
        calls.windowsCreate.push(clone(input));
        throw new Error('worker must not create the human surface window');
      },
    },
    scripting: {
      async executeScript(input) {
        calls.scriptInjection.push(clone(input));
        throw new Error('handoff runtime must not inject into the surface');
      },
    },
  };
  return { chromeApi, calls };
}

function sameBinding(candidate) {
  if (!candidate || typeof candidate !== 'object') return false;
  return Object.entries(BINDING).every(([field, value]) => candidate[field] === value);
}

function makeMission() {
  return {
    validateBinding: (binding) => sameBinding(binding),
    validateMissionBinding: (binding) => sameBinding(binding),
    isBindingCurrent: (binding) => sameBinding(binding),
    getBinding: () => clone(BINDING),
  };
}

function makeLifecycle() {
  let sourceOpen = true;
  let surfaceOpen = true;
  return {
    get(tabId, frameId = 0) {
      if (tabId === BINDING.tabId && frameId === BINDING.frameId && sourceOpen) return clone(BINDING);
      if (tabId === SURFACE.tabId && frameId === SURFACE.frameId && surfaceOpen) return clone(SURFACE);
      return null;
    },
    current(tabId, frameId = 0) {
      return this.get(tabId, frameId);
    },
    getBinding(tabId = BINDING.tabId, frameId = BINDING.frameId) {
      return this.get(tabId, frameId);
    },
    isOpen(tabId) {
      if (tabId === BINDING.tabId) return sourceOpen;
      if (tabId === SURFACE.tabId) return surfaceOpen;
      return false;
    },
    closeSource() { sourceOpen = false; },
    closeSurface() { surfaceOpen = false; },
  };
}

const SURFACE = Object.freeze({
  kind: 'toolbraid.sidepanel-created-handoff-surface',
  createdBy: 'sidepanel',
  surfaceId: 'surface-handoff-1',
  tabId: 101,
  frameId: 0,
  windowId: BINDING.windowId,
  origin: ORIGIN,
  binding: clone(BINDING),
});

function makeUiIntent(state, intent) {
  return syntheticUiIntent({
    handoffId: state.handoffId,
    type: state.type,
    missionId: state.missionId,
    memberId: state.memberId,
    sessionId: state.sessionId,
    pageFingerprint: state.pageFingerprint,
    targetFingerprint: state.targetFingerprint,
    purpose: state.purpose,
    safeOrigin: state.safeOrigin,
    intent,
  });
}

function makeCompletionProof(state, overrides = {}) {
  return {
    kind: 'toolbraid.completion-proof',
    fresh: true,
    handoffId: state.handoffId,
    type: state.type,
    binding: {
      missionId: state.missionId,
      memberId: state.memberId,
      sessionId: state.sessionId,
      pageFingerprint: state.pageFingerprint,
      targetFingerprint: state.targetFingerprint,
      purpose: state.purpose,
      safeOrigin: state.safeOrigin,
      ...overrides,
    },
  };
}

function makeRuntimeOptions({ storage, chromeApi, mission, lifecycle, persistenceKey = PERSISTENCE_KEY } = {}) {
  const trustedMissionBinding = (binding) => {
    const candidate = {
      ...BINDING,
      ...binding,
    };
    return sameBinding(candidate);
  };
  const trustedUiIntent = (token, expected) => token?.kind === 'toolbraid.synthetic-ui-intent'
    && token?.handoffId === expected.handoffId
    && token?.type === expected.type
    && token?.intent === expected.intent
    && token?.missionId === expected.missionId
    && token?.memberId === expected.memberId
    && token?.sessionId === expected.sessionId
    && token?.pageFingerprint === expected.pageFingerprint
    && token?.targetFingerprint === expected.targetFingerprint
    && token?.purpose === expected.purpose
    && token?.safeOrigin === expected.safeOrigin;
  const trustedCompletionProof = (proof, expected) => proof?.kind === 'toolbraid.completion-proof'
    && proof?.fresh === true
    && proof?.handoffId === expected.handoffId
    && proof?.type === expected.type
    && proof?.binding?.missionId === expected.missionId
    && proof?.binding?.memberId === expected.memberId
    && proof?.binding?.sessionId === expected.sessionId
    && proof?.binding?.pageFingerprint === expected.pageFingerprint
    && proof?.binding?.targetFingerprint === expected.targetFingerprint
    && proof?.binding?.purpose === expected.purpose
    && proof?.binding?.safeOrigin === expected.safeOrigin;
  return {
    chromeApi,
    storage,
    storageArea: storage,
    mission,
    missionCoordinator: mission,
    lifecycle,
    persistenceKey,
    validateMissionBinding: trustedMissionBinding,
    validateUiIntent: trustedUiIntent,
    validateCompletionProof: trustedCompletionProof,
    now: () => new Date('2026-08-29T12:00:00.000Z'),
    idFactory: (prefix) => `${prefix}-handoff-test`,
  };
}

async function makeHarness(options = {}) {
  const storage = options.storage ?? makeStorage(options.storageOptions);
  const { chromeApi, calls } = makeChrome(storage);
  const mission = options.mission ?? makeMission();
  const lifecycle = options.lifecycle ?? makeLifecycle();
  const runtime = await createExtensionHandoffRuntime(makeRuntimeOptions({
    storage,
    chromeApi,
    mission,
    lifecycle,
    persistenceKey: Object.prototype.hasOwnProperty.call(options, 'persistenceKey')
      ? options.persistenceKey
      : PERSISTENCE_KEY,
  }));
  return { runtime, storage, calls, mission, lifecycle };
}

async function requestHandoff(harness, overrides = {}) {
  return harness.runtime.request({
    handoffId: overrides.handoffId ?? `handoff-${++requestSequence}`,
    type: 'login',
    ...BINDING,
    safeOrigin: RAW_PAGE_URL,
    ...overrides,
  });
}

async function openHandoff(harness, state) {
  return harness.runtime.open({
    handoffId: state.handoffId,
    uiIntent: makeUiIntent(state, 'open'),
  });
}

async function commitHandoff(harness, state, surface = SURFACE) {
  return harness.runtime.commit({
    handoffId: state.handoffId,
    surface: clone(surface),
  });
}

async function openAndCommit(harness, overrides = {}) {
  const awaiting = await requestHandoff(harness, overrides);
  assert.equal(awaiting.state, HANDOFF_STATES.AWAITING_UI_GESTURE);
  const opening = await openHandoff(harness, awaiting);
  assert.equal(opening.state, HANDOFF_STATES.OPENING);
  const active = await commitHandoff(harness, opening);
  assert.equal(active.state, HANDOFF_STATES.HUMAN_ACTIVE);
  return { awaiting, opening, active };
}

function serializedHarness(harness) {
  return JSON.stringify({
    storage: harness.storage.data,
    calls: harness.calls,
  });
}

function assertNoSecretLeak(value, secrets = [
  'password-secret',
  'otp-secret',
  'fragment-secret',
  '/login',
  '?next=',
  'alice:',
]) {
  const serialized = typeof value === 'string' ? value : JSON.stringify(value);
  for (const secret of secrets) assert.equal(serialized.includes(secret), false, `handoff leaked ${secret}`);
}

test('request creates an awaiting-ui handoff and has no worker browser side effects', async () => {
  const harness = await makeHarness();
  const state = await requestHandoff(harness, { handoffId: 'handoff-request' });

  assert.equal(state.state, HANDOFF_STATES.AWAITING_UI_GESTURE);
  assert.equal(state.uiAuthority, null);
  assert.equal(state.surface, undefined);
  assert.equal(harness.calls.tabsCreate.length, 0);
  assert.equal(harness.calls.windowsCreate.length, 0);
  assert.equal(harness.calls.tabsUpdate.length, 0);
  assert.equal(harness.calls.scriptInjection.length, 0);
  assert.equal(harness.calls.tabsSendMessage.length, 0);
  assert.equal(harness.calls.screenshots.length, 0);
});

test('commit accepts only the canonical sidepanel-created surface with exact tab/frame/window/origin/binding', async () => {
  const harness = await makeHarness();
  const awaiting = await requestHandoff(harness, { handoffId: 'handoff-surface-exact' });
  const opening = await openHandoff(harness, awaiting);
  assert.equal(opening.state, HANDOFF_STATES.OPENING);

  for (const field of ['tabId', 'frameId', 'windowId', 'origin']) {
    const drifted = clone(SURFACE);
    drifted[field] = field === 'origin' ? 'https://other.example.test' : (SURFACE[field] + 1);
    await assert.rejects(
      () => harness.runtime.commit({ handoffId: opening.handoffId, surface: drifted }),
      (error) => typeof error?.code === 'string',
    );
    assert.equal(harness.runtime.state(opening.handoffId).state, HANDOFF_STATES.OPENING);
  }

  for (const field of ['tabId', 'frameId', 'windowId', 'origin', 'sessionId', 'pageFingerprint']) {
    const drifted = clone(SURFACE);
    drifted.binding[field] = field === 'origin' ? 'https://other.example.test' : `drift-${field}`;
    await assert.rejects(
      () => harness.runtime.commit({ handoffId: opening.handoffId, surface: drifted }),
      (error) => typeof error?.code === 'string',
    );
    assert.equal(harness.runtime.state(opening.handoffId).state, HANDOFF_STATES.OPENING);
  }

  const committed = await commitHandoff(harness, opening);
  assert.equal(committed.state, HANDOFF_STATES.HUMAN_ACTIVE);
  assert.equal(harness.calls.tabsCreate.length, 0);
  assert.equal(harness.calls.windowsCreate.length, 0);
});

test('credentials and raw path/query fragments never cross messages, storage, proofs, or errors', async () => {
  const harness = await makeHarness();
  const state = await requestHandoff(harness, {
    handoffId: 'handoff-redaction',
    credentials: { username: 'alice@example.test', password: 'password-secret', otp: 'otp-secret' },
    note: 'fragment-secret',
  });

  assert.equal(state.safeOrigin, ORIGIN);
  assert.equal(state.credentials, undefined);
  assertNoSecretLeak(state);
  assertNoSecretLeak(serializedHarness(harness));

  await assert.rejects(
    () => requestHandoff(harness, {
      handoffId: 'handoff-credential-url',
      safeOrigin: RAW_CREDENTIAL_URL,
    }),
    (error) => {
      assertNoSecretLeak(error);
      return typeof error?.code === 'string';
    },
  );
  assertNoSecretLeak(serializedHarness(harness));

  const { opening } = await openAndCommit(harness, { handoffId: 'handoff-proof-redaction' });
  const badProof = makeCompletionProof(opening, { safeOrigin: RAW_PAGE_URL });
  await assert.rejects(
    () => harness.runtime.return({
      handoffId: opening.handoffId,
      surface: clone(SURFACE),
      uiIntent: makeUiIntent(opening, 'complete'),
      completionProof: badProof,
    }),
    (error) => {
      assertNoSecretLeak(error);
      return typeof error?.code === 'string';
    },
  );
  assertNoSecretLeak(serializedHarness(harness));
});

test('the handoff worker never injects, snapshots, or sends content messages to the human surface', async () => {
  const harness = await makeHarness();
  const { active } = await openAndCommit(harness, { handoffId: 'handoff-no-content-io' });
  const completed = await harness.runtime.return({
    handoffId: active.handoffId,
    surface: clone(SURFACE),
    uiIntent: makeUiIntent(active, 'complete'),
    completionProof: makeCompletionProof(active),
  });
  assert.equal(completed.state, HANDOFF_STATES.COMPLETED);
  assert.equal(harness.calls.scriptInjection.length, 0);
  assert.equal(harness.calls.tabsSendMessage.length, 0);
  assert.equal(harness.calls.screenshots.length, 0);
});

test('surface closure and lifecycle drift fail closed before a handoff can complete', async () => {
  for (const drift of ['source', 'surface']) {
    const harness = await makeHarness();
    const { active } = await openAndCommit(harness, { handoffId: `handoff-closure-${drift}` });
    if (drift === 'source') harness.lifecycle.closeSource();
    else harness.lifecycle.closeSurface();

    await assert.rejects(
      () => harness.runtime.return({
        handoffId: active.handoffId,
        surface: clone(SURFACE),
        uiIntent: makeUiIntent(active, 'complete'),
        completionProof: makeCompletionProof(active),
      }),
      (error) => typeof error?.code === 'string',
    );
    assert.notEqual(harness.runtime.state(active.handoffId).state, HANDOFF_STATES.COMPLETED);
  }
});

test('CAPTCHA permits exactly one checkbox attempt and then keeps human authority in control', async () => {
  const harness = await makeHarness();
  const active = (await openAndCommit(harness, {
    handoffId: 'handoff-captcha',
    type: 'captcha',
    purpose: 'challenge checkbox',
  })).active;
  const checkboxIntent = makeUiIntent(active, 'captcha-checkbox');

  const attempted = await harness.runtime.captchaCheckboxAttempt({
    handoffId: active.handoffId,
    surface: clone(SURFACE),
    uiIntent: checkboxIntent,
  });
  assert.equal(attempted.captchaCheckboxAttempts, 1);
  assert.equal(attempted.state, HANDOFF_STATES.HUMAN_ACTIVE);

  await assert.rejects(
    () => harness.runtime.captchaCheckboxAttempt({
      handoffId: active.handoffId,
      surface: clone(SURFACE),
      uiIntent: makeUiIntent(attempted, 'captcha-checkbox'),
    }),
    (error) => error?.code === 'CAPTCHA_ATTEMPT_LIMIT',
  );
});

test('return internally requires a fresh canonical proof and rejects stale or conflicting proof bindings', async () => {
  const harness = await makeHarness();
  const { active } = await openAndCommit(harness, { handoffId: 'handoff-return-proof' });

  await assert.rejects(
    () => harness.runtime.return({
      handoffId: active.handoffId,
      surface: clone(SURFACE),
      uiIntent: makeUiIntent(active, 'complete'),
      completionProof: makeCompletionProof(active, { sessionId: 'drift-session' }),
    }),
    (error) => typeof error?.code === 'string',
  );
  await assert.rejects(
    () => harness.runtime.return({
      handoffId: active.handoffId,
      surface: clone(SURFACE),
      uiIntent: makeUiIntent(active, 'complete'),
      completionProof: { ...makeCompletionProof(active), fresh: false },
    }),
    (error) => typeof error?.code === 'string',
  );

  const returned = await harness.runtime.return({
    handoffId: active.handoffId,
    surface: clone(SURFACE),
    uiIntent: makeUiIntent(active, 'complete'),
    completionProof: makeCompletionProof(active),
  });
  assert.equal(returned.state, HANDOFF_STATES.COMPLETED);
  assert.equal(returned.uiAuthority, null);
  assertNoSecretLeak(returned);
});

test('restart rehydrates only an awaiting handoff, never a surface or UI authority; key rotation and persistence failure fail closed', async () => {
  const storage = makeStorage();
  const first = await makeHarness({ storage });
  const { active } = await openAndCommit(first, { handoffId: 'handoff-restart' });
  assert.equal(active.state, HANDOFF_STATES.HUMAN_ACTIVE);
  assertNoSecretLeak(first.storage.data);

  const restarted = await makeHarness({ storage });
  const restored = restarted.runtime.state(active.handoffId);
  assert.equal(restored.state, HANDOFF_STATES.AWAITING_UI_GESTURE);
  assert.equal(restored.uiAuthority, null);
  assert.equal(restored.surface, undefined);
  assert.equal(restored.revalidationRequired, true);
  assert.equal(restarted.calls.tabsCreate.length, 0);
  assert.equal(restarted.calls.windowsCreate.length, 0);
  await assert.rejects(
    () => restarted.runtime.return({
      handoffId: active.handoffId,
      surface: clone(SURFACE),
      uiIntent: makeUiIntent(restored, 'complete'),
      completionProof: makeCompletionProof(restored),
    }),
    (error) => typeof error?.code === 'string',
  );

  await assert.rejects(
    () => makeHarness({ storage, persistenceKey: 'toolbraid-rotated-handoff-key-2026-08-29' }),
    (error) => typeof error?.code === 'string',
  );
  await assert.rejects(
    () => makeHarness({ storage, persistenceKey: null }),
    (error) => typeof error?.code === 'string',
  );

  const failingStorage = makeStorage({ failSet: true });
  const failing = await makeHarness({ storage: failingStorage });
  await assert.rejects(
    () => requestHandoff(failing, { handoffId: 'handoff-storage-failure' }),
    (error) => {
      assertNoSecretLeak(error);
      return typeof error?.code === 'string';
    },
  );
  assert.throws(
    () => failing.runtime.state('handoff-storage-failure'),
    (error) => typeof error?.code === 'string',
  );
});

test('concurrent operations are serialized and public state remains JSON-safe', async () => {
  const storage = makeStorage({ delayMs: 1 });
  const harness = await makeHarness({ storage });
  const states = await Promise.all([
    requestHandoff(harness, { handoffId: 'handoff-serial-a' }),
    requestHandoff(harness, { handoffId: 'handoff-serial-b' }),
    requestHandoff(harness, { handoffId: 'handoff-serial-c' }),
  ]);
  assert.deepEqual(states.map((state) => state.handoffId).sort(), [
    'handoff-serial-a',
    'handoff-serial-b',
    'handoff-serial-c',
  ]);
  assert.equal(storage.maxConcurrentWrites, 1);
  for (const state of states) {
    const publicState = harness.runtime.state(state.handoffId);
    assert.doesNotThrow(() => JSON.stringify(publicState));
    assertNoSecretLeak(publicState);
  }
});
