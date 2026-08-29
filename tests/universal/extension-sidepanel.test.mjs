import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { UI_MESSAGE_TYPES, createUiController, normalizeState, sendUiMessage } from '../../extension/sidepanel.js';
import { createApprovalStore, PROVENANCE, sha256Hex } from '../../extension/approval-store.js';

const manifest = JSON.parse(await readFile(new URL('../../extension/manifest.json', import.meta.url), 'utf8'));
const html = await readFile(new URL('../../extension/sidepanel.html', import.meta.url), 'utf8');
const js = await readFile(new URL('../../extension/sidepanel.js', import.meta.url), 'utf8');
const css = await readFile(new URL('../../extension/sidepanel.css', import.meta.url), 'utf8');

function memoryStorage() {
  const data = {};
  return {
    data,
    async get(key) { return { [key]: data[key] }; },
    async set(value) { Object.assign(data, value); },
    async remove(key) { delete data[key]; },
  };
}

function fakeCrypto() {
  let sequence = 0;
  return {
    randomUUID: () => `nonce-${String(++sequence).padStart(28, '0')}`,
    subtle: globalThis.crypto.subtle,
    getRandomValues(bytes) { bytes.fill(0x42); return bytes; },
  };
}

const trustedClick = { isTrusted: true };
const syntheticClick = { isTrusted: false };

test('side panel permission surface is explicit and points to its default document', () => {
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(new Set(manifest.permissions), new Set(['activeTab', 'scripting', 'storage', 'sidePanel']));
  assert.deepEqual(manifest.side_panel, { default_path: 'sidepanel.html' });
  assert.equal('host_permissions' in manifest, false);
  assert.equal('externally_connectable' in manifest, false);
});

test('side panel has extension CSP, no inline script, and renders through safe DOM APIs', () => {
  assert.match(html, /Content-Security-Policy/);
  assert.match(html, /script-src 'self'; style-src 'self'; object-src 'none'/);
  assert.match(html, /<script type="module" src="sidepanel\.js"><\/script>/);
  assert.doesNotMatch(html, /<script>[^<]+/i);
  assert.doesNotMatch(js, /\.innerHTML\s*=/);
  assert.match(js, /textContent/);
  assert.match(js, /isTrusted\s*===\s*true/);
  assert.match(html, /id="evidence-list"/);
  assert.match(html, /id="receipts-list"/);
  assert.match(html, /id="audit-list"/);
  assert.match(html, /id="missions-list"/);
  assert.match(html, /id="handoffs-list"/);
  assert.match(html, /id="workflow-now"/);
  assert.match(html, /<details id="tools-panel"/);
  assert.match(html, /<details id="evidence-panel"/);
  assert.match(html, /<details id="provider-panel"/);
  assert.match(html, /<details id="audit-panel"/);
  assert.match(html, /id="evidence-analyze"/);
  assert.match(html, /id="quarantine-list"/);
  assert.match(html, /id="sidepanel-announcer"[^>]+aria-live="polite"[^>]+aria-atomic="true"/);
  assert.equal((html.match(/aria-live="polite"/g) ?? []).length, 2);
  assert.doesNotMatch(js, /Execute approved action|Action executed\./);
  assert.match(js, /Dispatch approved action/);
  assert.match(js, /postcondition unverified/i);
  assert.match(js, /const memberStatus = activeMission\(mission\) \? member\.status : 'recorded'/);
  assert.match(js, /activeMission\(mission\) && mission\.activeMemberId === member\.memberId/);
  assert.ok(html.indexOf('id="toast"') < html.indexOf('<main'), 'toast should occupy layout space before main content');
  assert.doesNotMatch(css, /\.toast\s*\{[^}]*position:\s*fixed/s);
  assert.match(css, /\.toast-visible\s*\{[^}]*display:\s*block/s);
});

test('normalizes rich evidence, packs, quarantine, receipts, and audit proof as bounded display data', () => {
  const state = normalizeState({
    connection: 'ready',
    tab: { id: 2, url: 'https://example.test/' },
    multimodal: {
      stats: { total: 1, completed: 1, degraded: 0, blocked: 0 },
      results: [{
        assetId: 'asset-1',
        kind: 'video',
        status: 'completed',
        text: '<img onerror=attack()>',
        transcript: 'Bound transcript',
        language: 'en',
        labels: ['checkout'],
        segments: [{ start: 0, end: 1, text: 'Bound transcript', handle: 'tb-media-private', raw: 'base64-secret' }],
        regions: [{ label: 'button', x: 0.95, y: 0.3, width: 0.4, height: 0.1, url: 'https://private.test/raw' }],
        keyframes: [{ timestamp: 0.5, summary: 'Checkout frame', raw: 'private-frame-bytes' }],
        warnings: ['MODEL_DEGRADED'],
        provider: { id: 'vision-local' },
        confidence: 0.8,
        untrustedContent: true,
      }],
    },
    capture: { warnings: ['SCREENSHOT_UNAVAILABLE'] },
    capabilityPacks: {
      selected: [{ id: 'github', version: '1', objectiveScore: 0.9 }],
      activePacks: [{ id: 'github', version: '1', status: 'active', toolCount: 3, maxTools: 4 }],
      budget: { maxActiveTools: 8, usedTools: 3, remainingTools: 5 },
      quarantined: [{ code: 'PACK_TOOL_BUDGET', stage: 'budget', packId: 'overflow', version: '1' }],
    },
    receipts: [{
      actionId: 'action-1',
      mode: 'mutation',
      receipt: { operation: 'submit', ref: 'form-1', events: ['input', 'submit'] },
      approvalClaim: { fingerprint: 'f'.repeat(64) },
      verification: {
        status: 'verified-success',
        reasonCode: 'CONFIRMED',
        contractId: 'github.star.v1',
        beforePageFingerprint: 'b'.repeat(64),
        afterPageFingerprint: 'c'.repeat(64),
        checkedAt: '2026-08-29T12:00:00.000Z',
      },
    }],
    audit: { verified: true, count: 1, head: 'a'.repeat(64), entries: [{ sequence: 1, event: 'action.executed', timestamp: '2026-08-29T12:00:00.000Z', hash: 'a'.repeat(64) }] },
    quarantined: [{ descriptor: { name: 'hostile', sourceType: 'page' }, assessment: { reasonCode: 'TOOL_METADATA_QUARANTINED' } }],
  });
  assert.equal(state.evidence.items[0].summary, '<img onerror=attack()>');
  assert.deepEqual(state.evidence.warnings, ['SCREENSHOT_UNAVAILABLE']);
  assert.equal(state.evidence.items[0].transcript, 'Bound transcript');
  assert.equal(state.evidence.items[0].segments.length, 1);
  assert.equal(state.evidence.items[0].regions.length, 1);
  assert.equal(state.evidence.items[0].keyframes.length, 1);
  assert.ok(state.evidence.items[0].regions[0].x + state.evidence.items[0].regions[0].width <= 1);
  const evidenceJson = JSON.stringify(state.evidence);
  for (const secret of ['tb-media-private', 'base64-secret', 'private.test', 'private-frame-bytes']) {
    assert.equal(evidenceJson.includes(secret), false);
  }
  assert.equal(state.receipts[0].operation, 'submit');
  assert.equal(state.receipts[0].status, 'dispatched');
  assert.equal(state.receipts[0].outcome, 'postcondition-unverified');
  assert.equal(state.audit.verified, true);
  assert.equal(state.audit.entries[0].event, 'action.dispatched');
  assert.equal(state.audit.entries[0].timestamp, '2026-08-29T12:00:00.000Z');
  assert.equal(state.receipts[0].verification.reasonCode, 'CONFIRMED');
  assert.equal(state.capabilityPacks.active[0].id, 'github');
  assert.deepEqual(state.capabilityPacks.budget, { maxActiveTools: 8, usedTools: 3, remainingTools: 5 });
  assert.equal(state.quarantined[0].reason, 'TOOL_METADATA_QUARANTINED');
  assert.equal(state.quarantinedCount, 2);
});

test('normalizes mission and handoff state without exposing credentials, proofs, or raw URLs', () => {
  const state = normalizeState({
    connection: 'ready',
    missions: [{
      missionId: 'mission-1',
      phase: 'running',
      revision: 2,
      members: [{ memberId: 'member-1', tabId: 4, frameId: 0, origin: 'https://example.test', status: 'attached' }],
      credentials: { password: 'secret-password' },
    }],
    handoffs: [{
      handoffId: 'handoff-1',
      type: 'login',
      state: 'awaiting-ui-gesture',
      missionId: 'mission-1',
      memberId: 'member-1',
      purpose: '<img onerror=attack()>',
      safeOrigin: 'https://example.test/login?token=secret#fragment',
      credentials: { password: 'secret-password' },
      uiIntent: { token: 'secret-token' },
      completionProof: { token: 'secret-proof' },
      surface: { url: 'https://example.test/login?token=secret' },
    }],
  });
  assert.equal(state.missions[0].members[0].origin, 'https://example.test');
  assert.equal(state.handoffs[0].safeOrigin, 'https://example.test');
  assert.equal(state.handoffs[0].purpose, '<img onerror=attack()>');
  const serialized = JSON.stringify({ missions: state.missions, handoffs: state.handoffs });
  for (const secret of ['secret-password', 'secret-token', 'secret-proof', '/login', '?token=', '#fragment']) {
    assert.equal(serialized.includes(secret), false);
  }
});

test('UI client allows only declared messages and fails closed without the worker', async () => {
  const unknown = await sendUiMessage('UI_DELETE_EVERYTHING', {});
  assert.equal(unknown.ok, false);
  assert.equal(unknown.error.code, 'UI_MESSAGE_TYPE_INVALID');
  const missing = await sendUiMessage(UI_MESSAGE_TYPES.UI_GET_STATE, {}, null);
  assert.equal(missing.ok, false);
  assert.equal(missing.error.code, 'BRIDGE_UNAVAILABLE');

  const calls = [];
  const response = await sendUiMessage(UI_MESSAGE_TYPES.UI_GET_STATE, { ignored: '<page text>' }, {
    sendMessage(message) {
      calls.push(message);
      return Promise.resolve({ ok: false, error: { code: 'NOT_INTEGRATED', message: 'Worker integration pending.' } });
    },
  });
  assert.equal(response.ok, false);
  assert.equal(response.error.code, 'NOT_INTEGRATED');
  assert.deepEqual(calls, [{ type: UI_MESSAGE_TYPES.UI_GET_STATE, payload: { ignored: '<page text>' } }]);
});

test('controller binds every side-panel request to the active tab in its current window', async () => {
  const queries = [];
  const messages = [];
  const browser = {
    runtime: {},
    tabs: {
      async query(filter) {
        queries.push(structuredClone(filter));
        return [{ id: 7, windowId: 42, active: true, url: 'https://example.test/current' }];
      },
    },
  };
  const runtime = {
    async sendMessage(message) {
      messages.push(structuredClone(message));
      return {
        ok: true,
        state: {
          connection: 'ready',
          tab: { id: 7, url: 'https://example.test/current' },
          snapshot: { pageFingerprint: 'a'.repeat(64) },
        },
      };
    },
  };
  const controller = createUiController({
    browser,
    runtime,
    store: createApprovalStore({ storageArea: memoryStorage(), cryptoRef: fakeCrypto() }),
  });

  const state = await controller.refresh();

  assert.equal(state.connection, 'ready');
  assert.deepEqual(queries, [{ active: true, currentWindow: true }]);
  assert.deepEqual(messages, [{
    type: UI_MESSAGE_TYPES.UI_GET_STATE,
    payload: { targetTabId: 7, targetWindowId: 42 },
  }]);
});

test('controller keeps generated/native state distinguishable and rejects synthetic approval', async () => {
  const storage = memoryStorage();
  const store = createApprovalStore({ storageArea: storage, cryptoRef: fakeCrypto() });
  const calls = [];
  const runtime = {
    sendMessage(message) {
      calls.push(message);
      if (message.type === UI_MESSAGE_TYPES.UI_GET_STATE) {
        return Promise.resolve({
          ok: true,
          state: {
            connection: 'ready',
            tab: { id: 4, url: 'https://example.test/checkout', title: 'Checkout' },
            tools: [
              { name: 'native.lookup', description: 'Native tool' },
              { name: 'generated.submit', description: '<script>page text</script>', provenance: PROVENANCE },
            ],
            actions: [{ id: 'generated.submit', title: 'Submit order', classification: 'mutate', inputSchema: { type: 'object', properties: {} } }],
            snapshot: { pageFingerprint: 'a'.repeat(64) },
          },
        });
      }
      if (message.type === UI_MESSAGE_TYPES.UI_PREPARE_ACTION) {
        return Promise.resolve({
          ok: true,
          preparedAction: {
            ...message.payload,
            tabId: 4,
            frameId: 0,
            sessionId: 'tab-4-session-checkout',
            origin: 'https://example.test',
            effect: { summary: 'Submit order.' },
          },
        });
      }
      return Promise.resolve({ ok: false, error: { code: 'NOT_INTEGRATED', message: 'Worker integration pending.' } });
    },
  };
  const controller = createUiController({ runtime, store });
  const state = await controller.refresh();
  assert.equal(state.connection, 'ready');
  assert.deepEqual(state.tools.map((tool) => tool.kind), ['native', 'generated']);
  assert.equal(state.tools[1].description, '<script>page text</script>');
  const prepared = await controller.prepareAction('generated.submit', {});
  assert.equal(prepared.ok, true);
  const blocked = await controller.approveAction(prepared.preparedAction, syntheticClick);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.error.code, 'TRUSTED_ACTIVATION_REQUIRED');
  const pending = await controller.approveAction(prepared.preparedAction, trustedClick);
  assert.equal(pending.ok, false);
  assert.equal(pending.error.code, 'NOT_INTEGRATED');
  assert.ok(pending.approval);
  assert.equal((await store.list()).length, 1);
  assert.equal(calls.at(-1).type, UI_MESSAGE_TYPES.UI_APPROVE_ACTION);
});

test('controller exposes safe reads, restored prepared actions, mission controls, and human handoffs through exact UI contracts', async () => {
  const calls = [];
  const runtime = {
    sendMessage(message) {
      calls.push(structuredClone(message));
      if (message.type === UI_MESSAGE_TYPES.UI_GET_STATE) {
        return Promise.resolve({
          ok: true,
          state: {
            connection: 'ready',
            tab: { id: 4, url: 'https://example.test/current', title: 'Current' },
            snapshot: { pageFingerprint: 'a'.repeat(64) },
            tools: [{
              name: 'read.current',
              title: 'Read current page',
              description: 'Read bounded evidence.',
              classification: 'read',
              inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
              sourceType: 'site-adapter',
              adapter: { id: 'fixture', version: '1' },
              provenance: { source: 'toolbraid.verified-adapter', adapterId: 'fixture', adapterVersion: '1', pageFingerprint: 'a'.repeat(64) },
            }],
            pendingActions: [{
              actionId: 'pending-1',
              toolName: 'mutate.current',
              arguments: { value: 'safe' },
              tabId: 4,
              frameId: 0,
              sessionId: 'session-current-4',
              origin: 'https://example.test',
            }],
            missions: [{
              missionId: 'mission-1',
              phase: 'running',
              activeMemberId: 'member-1',
              members: [{ memberId: 'member-1', tabId: 8, frameId: 0, origin: 'https://example.test', status: 'attached', role: 'source', required: true }],
              pendingActions: [{ actionId: 'pending-1', memberId: 'member-1' }],
              invalidatedActionIds: ['invalidated-1'],
            }],
            handoffs: [{
              handoffId: 'captcha-1',
              type: 'captcha',
              state: 'human-active',
              missionId: 'mission-1',
              memberId: 'member-1',
              purpose: 'Complete challenge.',
              safeOrigin: 'https://example.test',
              captchaCheckboxAttempts: 0,
            }],
          },
        });
      }
      if (message.type === UI_MESSAGE_TYPES.UI_EXECUTE_READ) {
        return Promise.resolve({
          ok: true,
          result: {
            status: 'read-completed',
            tool: { id: 'read.current', title: 'Read current page', sourceType: 'site-adapter', adapterId: 'fixture', adapterVersion: '1' },
            binding: { tabId: 4, frameId: 0, sessionId: 'session-4', origin: 'https://example.test', pageFingerprint: 'a'.repeat(64) },
            data: { title: '<untrusted page title>', values: [1, 2, 3] },
            byteLength: 64,
            truncated: false,
            untrustedContent: true,
          },
        });
      }
      return Promise.resolve({ ok: true, result: { state: 'updated' } });
    },
  };
  const controller = createUiController({
    runtime,
    now: () => 1000,
    store: createApprovalStore({ storageArea: memoryStorage(), cryptoRef: fakeCrypto() }),
  });
  const state = await controller.refresh();
  assert.equal(state.missions[0].members[0].role, 'source');
  assert.equal(state.missions[0].members[0].required, true);
  assert.deepEqual(state.missions[0].invalidatedActionIds, ['invalidated-1']);
  assert.equal(controller.getPreparedActions()[0].actionId, 'pending-1');

  const blocked = await controller.executeRead('read.current', { query: 'status' }, syntheticClick);
  assert.equal(blocked.error.code, 'TRUSTED_ACTIVATION_REQUIRED');
  const read = await controller.executeRead('read.current', { query: 'status' }, trustedClick);
  assert.equal(read.ok, true);
  assert.equal(controller.getReadResult('read.current').data.title, '<untrusted page title>');
  assert.deepEqual(calls.at(-1), {
    type: UI_MESSAGE_TYPES.UI_EXECUTE_READ,
    payload: { toolId: 'read.current', arguments: { query: 'status' } },
  });

  await controller.attachMission('mission-1', trustedClick, { role: 'destination', required: true });
  assert.deepEqual(calls.at(-1), {
    type: UI_MESSAGE_TYPES.UI_MISSION_ATTACH,
    payload: { missionId: 'mission-1', memberId: 'member-4-1000', tabId: 4, frameId: 0, role: 'destination', required: true },
  });
  await controller.selectMissionMember('mission-1', 'member-1', trustedClick);
  assert.equal(calls.at(-1).type, UI_MESSAGE_TYPES.UI_MISSION_SELECT);
  await controller.detachMissionMember('mission-1', 'member-1', trustedClick);
  assert.equal(calls.at(-1).type, UI_MESSAGE_TYPES.UI_MISSION_DETACH);
  await controller.routeMission('mission-1', 'member-1', 'read', trustedClick);
  assert.deepEqual(calls.at(-1), {
    type: UI_MESSAGE_TYPES.UI_MISSION_ROUTE,
    payload: { missionId: 'mission-1', memberId: 'member-1', operation: 'read' },
  });
  await controller.requestHandoff({ missionId: 'mission-1', memberId: 'member-1', type: '2fa', purpose: 'Enter the one-time code.' }, trustedClick);
  assert.deepEqual(calls.at(-1), {
    type: UI_MESSAGE_TYPES.UI_HANDOFF_REQUEST,
    payload: { missionId: 'mission-1', memberId: 'member-1', type: '2fa', purpose: 'Enter the one-time code.' },
  });
  await controller.attemptCaptcha('captcha-1', trustedClick);
  assert.deepEqual(calls.at(-1), {
    type: UI_MESSAGE_TYPES.UI_HANDOFF_CAPTCHA_ATTEMPT,
    payload: { handoffId: 'captcha-1' },
  });
});

test('controller never marks a local approval executed after a fail-closed worker response', async () => {
  const store = createApprovalStore({ storageArea: memoryStorage(), cryptoRef: fakeCrypto() });
  const action = {
    id: 'read.current',
    name: 'Read current page',
    tabId: 4,
    frameId: 0,
    sessionId: 'tab-4-session-current',
    origin: 'https://example.test',
    arguments: {},
    effect: { summary: 'No external change.' },
  };
  const approval = await store.createApproval({ event: trustedClick, action });
  const controller = createUiController({
    store,
    runtime: { sendMessage: () => Promise.resolve({ ok: false, error: { code: 'EXECUTOR_UNAVAILABLE', message: 'No worker executor.' } }) },
  });
  const response = await controller.executeApproval(approval.id, trustedClick);
  assert.equal(response.ok, false);
  assert.equal(response.error.code, 'EXECUTOR_UNAVAILABLE');
  assert.equal((await store.get(approval.id)).state, 'approved');
});

test('trusted handoff opens the exact-origin window in the sidepanel and sends only its tab id to the worker', async () => {
  const calls = { permissions: [], windows: [], worker: [], removed: [] };
  const runtime = {
    sendMessage(message) {
      calls.worker.push(structuredClone(message));
      if (message.type === UI_MESSAGE_TYPES.UI_GET_STATE) {
        return Promise.resolve({
          ok: true,
          state: {
            connection: 'ready',
            tab: { id: 4, url: 'https://example.test/page' },
            handoffs: [{
              handoffId: 'handoff-sidepanel',
              type: 'login',
              state: 'awaiting-ui-gesture',
              missionId: 'mission-sidepanel',
              memberId: 'member-sidepanel',
              purpose: 'Sign in.',
              safeOrigin: 'https://example.test',
            }],
          },
        });
      }
      return Promise.resolve({ ok: true, result: { state: 'human-active' } });
    },
  };
  const browser = {
    runtime: {},
    permissions: {
      async request(value) { calls.permissions.push(structuredClone(value)); return true; },
    },
    windows: {
      async create(value) { calls.windows.push(structuredClone(value)); return { id: 8, tabs: [{ id: 101 }] }; },
      async remove(windowId) { calls.removed.push(windowId); },
    },
    tabs: { async query() { return [{ id: 101 }]; } },
  };
  const controller = createUiController({
    runtime,
    browser,
    store: createApprovalStore({ storageArea: memoryStorage(), cryptoRef: fakeCrypto() }),
  });
  await controller.refresh();

  const blocked = await controller.openHandoff('handoff-sidepanel', syntheticClick);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.error.code, 'TRUSTED_ACTIVATION_REQUIRED');
  assert.equal(calls.windows.length, 0);

  const opened = await controller.openHandoff('handoff-sidepanel', trustedClick);
  assert.equal(opened.ok, true);
  assert.deepEqual(calls.permissions, [{ origins: ['https://example.test/*'] }]);
  assert.deepEqual(calls.windows, [{
    url: 'https://example.test',
    type: 'popup',
    focused: true,
    width: 520,
    height: 720,
  }]);
  assert.deepEqual(calls.worker.at(-1), {
    type: UI_MESSAGE_TYPES.UI_HANDOFF_OPEN_SURFACE,
    payload: { handoffId: 'handoff-sidepanel', surfaceTabId: 101 },
  });
  assert.deepEqual(calls.removed, []);

  const completed = await controller.completeHandoff('handoff-sidepanel', trustedClick);
  assert.equal(completed.ok, true);
  assert.deepEqual(calls.worker.at(-1), {
    type: UI_MESSAGE_TYPES.UI_HANDOFF_COMPLETE,
    payload: { handoffId: 'handoff-sidepanel' },
  });
});

test('SHA-256 helper returns the standard digest used for approval bindings', async () => {
  assert.equal(await sha256Hex('abc', fakeCrypto()), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('approval normalization exposes only exact current-page records as actionable', () => {
  const pageFingerprint = 'p'.repeat(64);
  const state = normalizeState({
    connection: 'ready',
    tab: { id: 4, url: 'https://example.test/current' },
    sessionId: 'session-current-4',
    snapshot: { pageFingerprint },
    pendingActions: [{
      actionId: 'submit',
      toolName: 'mutate.current',
      tabId: 4,
      frameId: 0,
      sessionId: 'session-current-4',
      origin: 'https://example.test',
    }],
    approvals: [
      {
        id: 'approval-current',
        provenance: PROVENANCE,
        state: 'approved',
        nonce: 'nonce-current-123456',
        fingerprint: 'f-current',
        createdAt: 1,
        expiresAt: 999,
        scope: { actionId: 'submit', tabId: 4, frameId: 0, sessionId: 'session-current-4', origin: 'https://example.test', pageFingerprint },
      },
      {
        id: 'approval-stale',
        provenance: PROVENANCE,
        state: 'approved',
        nonce: 'nonce-stale-123456',
        fingerprint: 'f-stale',
        createdAt: 1,
        expiresAt: 999,
        scope: { actionId: 'submit', tabId: 4, frameId: 0, sessionId: 'session-old-4', origin: 'https://example.test', pageFingerprint },
      },
      {
        id: 'approval-without-pending-action',
        provenance: PROVENANCE,
        state: 'approved',
        nonce: 'nonce-gone-123456',
        fingerprint: 'f-gone',
        createdAt: 1,
        expiresAt: 999,
        scope: { actionId: 'gone', tabId: 4, frameId: 0, sessionId: 'session-current-4', origin: 'https://example.test', pageFingerprint },
      },
    ],
  });
  assert.equal(state.approvals.find((entry) => entry.id === 'approval-current').actionable, true);
  assert.equal(state.approvals.find((entry) => entry.id === 'approval-stale').actionable, false);
  assert.equal(state.approvals.find((entry) => entry.id === 'approval-stale').currentContext, 'same-page');
  assert.equal(state.approvals.find((entry) => entry.id === 'approval-without-pending-action').actionable, false);
});

test('controller sends a bounded mission objective and records live inspection results', async () => {
  const calls = [];
  const runtime = {
    sendMessage(message) {
      calls.push(structuredClone(message));
      if (message.type === UI_MESSAGE_TYPES.UI_GET_STATE) {
        return Promise.resolve({ ok: true, state: {
          connection: 'ready',
          tab: { id: 4, url: 'https://example.test/current', title: 'Current' },
          snapshot: { pageFingerprint: 'a'.repeat(64) },
          missions: [{
            missionId: 'mission-completed',
            phase: 'completed',
            revision: 3,
            members: [{ memberId: 'member-completed', tabId: 4, frameId: 0, origin: 'https://example.test', status: 'attached' }],
          }],
        } });
      }
      if (message.type === UI_MESSAGE_TYPES.UI_MISSION_CREATE) return Promise.resolve({ ok: true, result: { missionId: 'mission-1' } });
      if (message.type === UI_MESSAGE_TYPES.UI_MISSION_ROUTE) return Promise.resolve({ ok: true, result: {
        target: { ref: 'tab:4', tabId: 4, frameId: 0, origin: 'https://example.test' },
        page: { title: 'Current', origin: 'https://example.test', pageFingerprint: 'a'.repeat(64), revision: 3 },
        mission: { missionId: 'mission-1', phase: 'running', revision: 2 },
      } });
      return Promise.resolve({ ok: true, result: {} });
    },
  };
  const controller = createUiController({
    runtime,
    store: createApprovalStore({ storageArea: memoryStorage(), cryptoRef: fakeCrypto() }),
    now: () => 1000,
  });
  await controller.refresh();
  const objective = 'x'.repeat(400);
  const started = await controller.startMission(trustedClick, objective);
  assert.equal(started.ok, true);
  assert.equal(calls.find((entry) => entry.type === UI_MESSAGE_TYPES.UI_MISSION_CREATE).payload.objective.length, 280);
  const inspected = await controller.routeMission('mission-1', 'member-1', 'read', trustedClick);
  assert.equal(inspected.ok, true);
  assert.equal(controller.getMissionInspection('mission-1', 'member-1').page.title, 'Current');
});

test('controller cancels a newly created mission when its first exact member cannot attach', async () => {
  const calls = [];
  const runtime = {
    sendMessage(message) {
      calls.push(structuredClone(message));
      if (message.type === UI_MESSAGE_TYPES.UI_GET_STATE) return Promise.resolve({ ok: true, state: {
        connection: 'ready',
        tab: { id: 4, url: 'https://example.test/current' },
        snapshot: { pageFingerprint: 'a'.repeat(64) },
      } });
      if (message.type === UI_MESSAGE_TYPES.UI_MISSION_CREATE) return Promise.resolve({ ok: true, result: { missionId: 'mission-orphan' } });
      if (message.type === UI_MESSAGE_TYPES.UI_MISSION_ATTACH) return Promise.resolve({ ok: false, error: { code: 'ATTACH_FAILED', message: 'Member could not attach.' } });
      if (message.type === UI_MESSAGE_TYPES.UI_MISSION_SET_PHASE) return Promise.resolve({ ok: true, result: { missionId: 'mission-orphan', phase: 'cancelled' } });
      return Promise.resolve({ ok: false, error: { code: 'UNEXPECTED', message: 'Unexpected message.' } });
    },
  };
  const controller = createUiController({
    runtime,
    store: createApprovalStore({ storageArea: memoryStorage(), cryptoRef: fakeCrypto() }),
    now: () => 1000,
  });
  await controller.refresh();
  const response = await controller.startMission(trustedClick, 'Inspect the active page.');
  assert.equal(response.ok, false);
  assert.deepEqual(response.cleanup, { status: 'cancelled', missionId: 'mission-orphan' });
  assert.deepEqual(calls.at(-1), {
    type: UI_MESSAGE_TYPES.UI_MISSION_SET_PHASE,
    payload: { missionId: 'mission-orphan', phase: 'cancelled' },
  });
});

test('controller emits the fail-closed terminal mission phase contract', async () => {
  const calls = [];
  const runtime = {
    sendMessage(message) {
      calls.push(structuredClone(message));
      if (message.type === UI_MESSAGE_TYPES.UI_GET_STATE) return Promise.resolve({ ok: true, state: {
        connection: 'ready',
        tab: { id: 4, url: 'https://example.test/current' },
        snapshot: { pageFingerprint: 'a'.repeat(64) },
        missions: [{ missionId: 'mission-1', phase: 'running', revision: 7, members: [] }],
      } });
      return Promise.resolve({ ok: true, result: { phase: 'completed' } });
    },
  };
  const controller = createUiController({ runtime, store: createApprovalStore({ storageArea: memoryStorage(), cryptoRef: fakeCrypto() }) });
  await controller.refresh();
  const response = await controller.setMissionPhase('mission-1', 'completed', trustedClick);
  assert.equal(response.ok, true);
  assert.deepEqual(calls.at(-1), {
    type: UI_MESSAGE_TYPES.UI_MISSION_SET_PHASE,
    payload: { missionId: 'mission-1', phase: 'completed', expectedRevision: 7 },
  });
});
