import assert from 'node:assert/strict';
import test from 'node:test';

import { createApprovalStore } from '../../extension/approval-store.js';
import { MESSAGE_TYPES, createEnvelope, parseEnvelope } from '../../extension/protocol.js';
import { MISSION_UI_MESSAGE_TYPES } from '../../extension/mission-runtime.js';
import { createServiceWorkerController } from '../../extension/service-worker.js';
import { UI_MESSAGE_TYPES } from '../../extension/universal-runtime.js';

const EXTENSION_ID = 'toolbraid-integration-test';
const PAGE = 'https://example.test/checkout';

function makeStorage() {
  const values = {};
  return {
    values,
    get(key) { return Promise.resolve({ [key]: values[key] }); },
    set(value) { Object.assign(values, value); return Promise.resolve(); },
    remove(key) { delete values[key]; return Promise.resolve(); },
  };
}

function pageSnapshot() {
  return {
    metadata: { url: PAGE, origin: 'https://example.test', title: 'Checkout' },
    mainText: 'Review before publishing.',
    forms: [{
      ref: 'notice-form',
      name: 'Publish notice',
      action: 'https://example.test/api/publish',
      method: 'POST',
      fields: [{ ref: 'message', name: 'Message', type: 'text', required: true }],
    }],
    accessibleControls: [{ ref: 'message', role: 'textbox', name: 'Message', type: 'text', formRef: 'notice-form', required: true }],
    elementRefs: [
      { ref: 'notice-form', tagName: 'form', role: 'form', name: 'Publish notice' },
      { ref: 'message', tagName: 'input', role: 'textbox', name: 'Message', type: 'text' },
    ],
  };
}

function pageSender() {
  return {
    id: EXTENSION_ID,
    tab: { id: 12, url: PAGE },
    frameId: 0,
    documentId: 'document-0123456789abcdef',
    url: PAGE,
  };
}

function panelSender() {
  return { id: EXTENSION_ID, url: `chrome-extension://${EXTENSION_ID}/sidepanel.html` };
}

function fakeCrypto() {
  let sequence = 0;
  return {
    randomUUID: () => `approval-${String(++sequence).padStart(28, '0')}`,
    subtle: globalThis.crypto.subtle,
    getRandomValues(bytes) { bytes.fill(0x27); return bytes; },
  };
}

function bindingFromChannel(channel) {
  return {
    nonce: channel.nonce,
    sessionId: channel.sessionId,
    tabId: channel.tabId,
    frameId: channel.frameId,
  };
}

test('runs PAGE_READY -> PAGE_SNAPSHOT -> registration -> WebMCP execute -> approve -> fresh snapshot -> receipt', async () => {
  const area = makeStorage();
  const calls = [];
  const snapshot = pageSnapshot();
  const api = {
    runtime: { id: EXTENSION_ID },
    storage: { local: area },
    tabs: { query: async () => [{ id: 12, url: PAGE, title: 'Checkout' }] },
    scripting: { executeScript: async () => [] },
  };
  const sendToContentScript = async (tabId, message, options) => {
    calls.push({ tabId, message, options });
    if (message.type === MESSAGE_TYPES.REGISTER_TOOLS) return { ok: true };
    if (message.type === MESSAGE_TYPES.PAGE_EXTRACT_SNAPSHOT) return { ok: true, snapshot };
    if (message.type === MESSAGE_TYPES.PAGE_ACTION_EXECUTE) return { ok: true, receipt: { receiptId: 'receipt-12', changed: true } };
    return { ok: true };
  };
  const controller = createServiceWorkerController({ chromeApi: api, sendToContentScript });
  const ready = await controller.handleRuntimeMessage({ type: MESSAGE_TYPES.PAGE_READY, pageInstanceId: 'page-0123456789abcdef' }, pageSender());
  assert.equal(ready.ok, true);
  const channel = ready.channel;
  const ingested = await controller.handleRuntimeMessage({ type: MESSAGE_TYPES.PAGE_SNAPSHOT, sessionId: channel.sessionId, nonce: channel.nonce, snapshot }, pageSender());
  assert.equal(ingested.ok, true);
  assert.ok(calls.some((call) => call.message.type === MESSAGE_TYPES.REGISTER_TOOLS));

  const read = ingested.state.tools.find((tool) => tool.classification === 'read' && tool.sourceType === 'page');
  const readResponse = await controller.handleRuntimeMessage({
    type: 'UI_EXECUTE_READ',
    payload: { toolId: read.name, arguments: {} },
  }, panelSender());
  assert.equal(readResponse.ok, true);
  assert.equal(readResponse.result.status, 'read-completed');
  assert.equal(readResponse.result.tool.id, read.name);
  assert.equal(readResponse.result.binding.sessionId, channel.sessionId);
  assert.equal(readResponse.result.data.type, 'page');
  assert.equal(readResponse.result.data.untrustedContent, true);

  const mutation = ingested.state.tools.find((tool) => tool.classification === 'mutate');
  assert.ok(mutation);
  const property = Object.keys(mutation.inputSchema.properties)[0];
  const pageExecute = await controller.handleRuntimeMessage({
    type: MESSAGE_TYPES.PAGE_EVENT,
    envelope: createEnvelope({
      ...channel,
      type: MESSAGE_TYPES.EXECUTE_REQUEST,
      requestId: 'req-mutation-012345',
      payload: { toolId: mutation.name, name: mutation.name, input: { [property]: 'Approved notice' } },
    }),
  }, pageSender());
  const pageResult = parseEnvelope(pageExecute.envelope, bindingFromChannel(channel));
  assert.equal(pageResult.ok, true);
  const prepared = pageResult.value.payload.result.preparedAction;
  assert.equal(pageResult.value.payload.result.status, 'approval-required');

  const localApprovals = createApprovalStore({ storageArea: area, cryptoRef: fakeCrypto() });
  const boundPrepared = {
    ...prepared,
    tabId: channel.tabId,
    frameId: channel.frameId,
    sessionId: channel.sessionId,
    origin: new URL(PAGE).origin,
  };
  const localApproval = await localApprovals.createApproval({ event: { isTrusted: true }, action: boundPrepared });
  const approved = await controller.handleRuntimeMessage({
    type: 'UI_APPROVE_ACTION',
    payload: { approval: localApproval },
  }, panelSender());
  assert.equal(approved.ok, true);
  assert.equal(approved.actionId, boundPrepared.actionId);

  const executed = await controller.handleRuntimeMessage({
    type: 'UI_EXECUTE_ACTION',
    payload: { approval: localApproval },
  }, panelSender());
  assert.equal(executed.ok, true);
  assert.equal(executed.result.status, 'dispatched');
  assert.equal(executed.result.outcome, 'postcondition-unverified');
  assert.equal(executed.result.receipt.receiptId, 'receipt-12');
  const refreshIndex = calls.findIndex((call) => call.message.type === MESSAGE_TYPES.PAGE_EXTRACT_SNAPSHOT);
  const actionIndex = calls.findIndex((call) => call.message.type === MESSAGE_TYPES.PAGE_ACTION_EXECUTE);
  assert.ok(refreshIndex >= 0);
  assert.ok(actionIndex > refreshIndex);
  assert.equal(calls[actionIndex].message.approved, true);
});

test('routes a live mission into a sidepanel-created human handoff without worker browser writes', async () => {
  const local = makeStorage();
  const session = makeStorage();
  const calls = { create: 0, update: 0, inject: 0, message: 0 };
  const snapshot = pageSnapshot();
  const tabs = new Map([
    [12, { id: 12, windowId: 4, url: PAGE, title: 'Checkout' }],
    [101, { id: 101, windowId: 4, url: 'https://example.test/', title: 'Human handoff' }],
    [102, { id: 102, windowId: 4, url: 'https://example.test/', title: 'Human handoff without checkbox' }],
  ]);
  const api = {
    runtime: { id: EXTENSION_ID },
    storage: { local, session },
    tabs: {
      query: async () => [tabs.get(12)],
      get: async (tabId) => structuredClone(tabs.get(tabId)),
      create: async () => { calls.create += 1; throw new Error('worker must not create a handoff tab'); },
      update: async () => { calls.update += 1; throw new Error('worker must not navigate a handoff tab'); },
      sendMessage: async () => { calls.message += 1; throw new Error('worker must not message a handoff tab'); },
    },
    scripting: {
      executeScript: async (details) => {
        calls.inject += 1;
        if (Array.isArray(details?.target?.frameIds)
          && details.target.frameIds.length === 1
          && details.target.frameIds[0] === 0
          && typeof details.func === 'function') {
          if (details.target.tabId === 101) return [{ result: { ok: true, clicked: true } }];
          if (details.target.tabId === 102) {
            return [{ result: {
              ok: false,
              error: {
                code: 'CAPTCHA_CHECKBOX_TARGET_INVALID',
                message: 'Exactly one visible top-frame CAPTCHA checkbox is required; no click was dispatched.',
              },
            } }];
          }
        }
        throw new Error('worker injected outside the exact top-frame handoff surface');
      },
    },
  };
  const sent = [];
  const sendToContentScript = async (tabId, message, options) => {
    sent.push({ tabId, message, options });
    if (message.type === MESSAGE_TYPES.REGISTER_TOOLS) return { ok: true };
    return { ok: true, snapshot };
  };
  const controller = createServiceWorkerController({ chromeApi: api, sendToContentScript });
  const ready = await controller.handleRuntimeMessage(
    { type: MESSAGE_TYPES.PAGE_READY, pageInstanceId: 'page-0123456789abcdef' },
    pageSender(),
  );
  assert.equal(ready.ok, true);
  const ingested = await controller.handleRuntimeMessage({
    type: MESSAGE_TYPES.PAGE_SNAPSHOT,
    sessionId: ready.channel.sessionId,
    nonce: ready.channel.nonce,
    snapshot,
  }, pageSender());
  assert.equal(ingested.ok, true);

  const created = await controller.handleRuntimeMessage({
    type: 'UI_MISSION_CREATE',
    payload: { missionId: 'mission-human', objective: 'Authenticate, then resume the exact mission.' },
  }, panelSender());
  assert.equal(created.ok, true);
  const attached = await controller.handleRuntimeMessage({
    type: 'UI_MISSION_ATTACH',
    payload: { missionId: 'mission-human', memberId: 'member-source', tabId: 12, frameId: 0 },
  }, panelSender());
  assert.equal(attached.ok, true);
  const missionRuntime = await controller.ensureMissionRuntime();
  const liveBinding = missionRuntime.getBinding('mission-human', 'member-source');
  assert.equal(missionRuntime.validateBinding(liveBinding), true);

  const requested = await controller.handleRuntimeMessage({
    type: 'UI_HANDOFF_REQUEST',
    payload: {
      handoffId: 'handoff-human',
      type: 'login',
      missionId: 'mission-human',
      memberId: 'member-source',
      targetFingerprint: 'target-login-exact',
      purpose: 'Sign in on the exact approved origin.',
      credentials: { password: 'must-never-cross' },
    },
  }, panelSender());
  assert.equal(requested.ok, true, JSON.stringify(requested));
  assert.equal(requested.result.state, 'awaiting-ui-gesture');

  const opened = await controller.handleRuntimeMessage({
    type: 'UI_HANDOFF_OPEN_SURFACE',
    payload: {
      handoffId: 'handoff-human',
      surfaceTabId: 101,
      binding: { sessionId: 'forged', password: 'must-never-cross' },
    },
  }, panelSender());
  assert.equal(opened.ok, true);
  assert.equal(opened.result.state, 'human-active');
  assert.deepEqual(calls, { create: 0, update: 0, inject: 0, message: 0 });

  const wrongType = await controller.handleRuntimeMessage({
    type: 'UI_HANDOFF_CAPTCHA_ATTEMPT',
    payload: { handoffId: 'handoff-human', surfaceTabId: 999 },
  }, panelSender());
  assert.equal(wrongType.ok, false);
  assert.equal(wrongType.error.code, 'CAPTCHA_TYPE_REQUIRED');

  const completed = await controller.handleRuntimeMessage({
    type: 'UI_HANDOFF_COMPLETE',
    payload: { handoffId: 'handoff-human', proof: { password: 'must-never-cross' } },
  }, panelSender());
  assert.equal(completed.ok, true);
  assert.equal(completed.result.state, 'completed');
  assert.equal(JSON.stringify(session.values).includes('must-never-cross'), false);
  assert.deepEqual(calls, { create: 0, update: 0, inject: 0, message: 0 });

  const captchaRequested = await controller.handleRuntimeMessage({
    type: 'UI_HANDOFF_REQUEST',
    payload: {
      handoffId: 'handoff-captcha',
      type: 'captcha',
      missionId: 'mission-human',
      memberId: 'member-source',
      targetFingerprint: 'target-captcha-exact',
      purpose: 'Attempt the visible CAPTCHA checkbox once.',
    },
  }, panelSender());
  assert.equal(captchaRequested.ok, true);

  const wrongState = await controller.handleRuntimeMessage({
    type: 'UI_HANDOFF_CAPTCHA_ATTEMPT',
    payload: { handoffId: 'handoff-captcha' },
  }, panelSender());
  assert.equal(wrongState.ok, false);
  assert.equal(wrongState.error.code, 'HANDOFF_STATE_INVALID');

  const captchaOpened = await controller.handleRuntimeMessage({
    type: 'UI_HANDOFF_OPEN_SURFACE',
    payload: { handoffId: 'handoff-captcha', surfaceTabId: 101 },
  }, panelSender());
  assert.equal(captchaOpened.ok, true);
  assert.equal(captchaOpened.result.state, 'human-active');

  const attempted = await controller.handleRuntimeMessage({
    type: 'UI_HANDOFF_CAPTCHA_ATTEMPT',
    payload: { handoffId: 'handoff-captcha', surfaceTabId: 999, intent: 'forged' },
  }, panelSender());
  assert.equal(attempted.ok, true);
  assert.equal(attempted.result.state, 'human-active');
  assert.equal(attempted.result.captchaCheckboxAttempts, 1);
  assert.equal(calls.inject, 1);

  const repeated = await controller.handleRuntimeMessage({
    type: 'UI_HANDOFF_CAPTCHA_ATTEMPT',
    payload: { handoffId: 'handoff-captcha' },
  }, panelSender());
  assert.equal(repeated.ok, false);
  assert.equal(repeated.error.code, 'CAPTCHA_ATTEMPT_LIMIT');

  const noTargetRequested = await controller.handleRuntimeMessage({
    type: 'UI_HANDOFF_REQUEST',
    payload: {
      handoffId: 'handoff-captcha-no-target',
      type: 'captcha',
      missionId: 'mission-human',
      memberId: 'member-source',
      targetFingerprint: 'target-captcha-no-target',
      purpose: 'Leave control with the human when no unique checkbox is visible.',
    },
  }, panelSender());
  assert.equal(noTargetRequested.ok, true);
  const noTargetOpened = await controller.handleRuntimeMessage({
    type: 'UI_HANDOFF_OPEN_SURFACE',
    payload: { handoffId: 'handoff-captcha-no-target', surfaceTabId: 102 },
  }, panelSender());
  assert.equal(noTargetOpened.ok, true);
  const noTarget = await controller.handleRuntimeMessage({
    type: 'UI_HANDOFF_CAPTCHA_ATTEMPT',
    payload: { handoffId: 'handoff-captcha-no-target' },
  }, panelSender());
  assert.equal(noTarget.ok, false);
  assert.equal(noTarget.error.code, 'CAPTCHA_CHECKBOX_TARGET_INVALID');
  const handoffState = await controller.handleRuntimeMessage({ type: 'UI_HANDOFF_GET_STATE' }, panelSender());
  const noTargetState = handoffState.state.handoffs.find((entry) => entry.handoffId === 'handoff-captcha-no-target');
  assert.equal(noTargetState.state, 'human-active');
  assert.equal(noTargetState.captchaCheckboxAttempts, 0);

  const driftRequested = await controller.handleRuntimeMessage({
    type: 'UI_HANDOFF_REQUEST',
    payload: {
      handoffId: 'handoff-captcha-drift',
      type: 'captcha',
      missionId: 'mission-human',
      memberId: 'member-source',
      targetFingerprint: 'target-captcha-drift',
      purpose: 'Reject a checkbox attempt after surface drift.',
    },
  }, panelSender());
  assert.equal(driftRequested.ok, true);
  const driftOpened = await controller.handleRuntimeMessage({
    type: 'UI_HANDOFF_OPEN_SURFACE',
    payload: { handoffId: 'handoff-captcha-drift', surfaceTabId: 101 },
  }, panelSender());
  assert.equal(driftOpened.ok, true);
  tabs.set(101, { ...tabs.get(101), url: 'https://attacker.test/' });
  const wrongSurface = await controller.handleRuntimeMessage({
    type: 'UI_HANDOFF_CAPTCHA_ATTEMPT',
    payload: { handoffId: 'handoff-captcha-drift' },
  }, panelSender());
  assert.equal(wrongSurface.ok, false);
  assert.equal(wrongSurface.error.code, 'HANDOFF_SURFACE_DRIFT');
  assert.deepEqual(calls, { create: 0, update: 0, inject: 2, message: 0 });
});

test('binds prepared actions to the exact mission owner and clears them on execute, deny, and stage', async () => {
  const area = makeStorage();
  const snapshot = pageSnapshot();
  snapshot.accessibleControls.push({ ref: 'preview-control', role: 'button', name: 'Preview draft' });
  snapshot.elementRefs.push({ ref: 'preview-control', tagName: 'button', role: 'button', name: 'Preview draft' });
  const api = {
    runtime: { id: EXTENSION_ID },
    storage: { local: area },
    tabs: { query: async () => [{ id: 12, url: PAGE, title: 'Checkout' }] },
    scripting: { executeScript: async () => [] },
  };
  const calls = [];
  const sendToContentScript = async (tabId, message, options) => {
    calls.push({ tabId, message, options });
    if (message.type === MESSAGE_TYPES.REGISTER_TOOLS) return { ok: true };
    if (message.type === MESSAGE_TYPES.PAGE_EXTRACT_SNAPSHOT) return { ok: true, snapshot };
    if (message.type === MESSAGE_TYPES.PAGE_ACTION_EXECUTE) return { ok: true, receipt: { receiptId: `receipt-${calls.length}`, changed: true } };
    return { ok: true };
  };
  const controller = createServiceWorkerController({ chromeApi: api, sendToContentScript });
  const ready = await controller.handleRuntimeMessage({ type: MESSAGE_TYPES.PAGE_READY, pageInstanceId: 'page-0123456789abcdef' }, pageSender());
  const ingested = await controller.handleRuntimeMessage({
    type: MESSAGE_TYPES.PAGE_SNAPSHOT,
    sessionId: ready.channel.sessionId,
    nonce: ready.channel.nonce,
    snapshot,
  }, pageSender());
  assert.equal(ingested.ok, true);
  const created = await controller.handleRuntimeMessage({
    type: MISSION_UI_MESSAGE_TYPES.CREATE,
    payload: { missionId: 'mission-actions', objective: 'Review the exact page action.' },
  }, panelSender());
  assert.equal(created.ok, true);
  const attached = await controller.handleRuntimeMessage({
    type: MISSION_UI_MESSAGE_TYPES.ATTACH,
    payload: { missionId: 'mission-actions', memberId: 'member-actions', tabId: 12, frameId: 0 },
  }, panelSender());
  assert.equal(attached.ok, true);

  const mutation = ingested.state.tools.find((tool) => tool.classification === 'mutate');
  assert.ok(mutation);
  const property = Object.keys(mutation.inputSchema.properties)[0];
  const firstPrepared = await controller.handleRuntimeMessage({
    type: UI_MESSAGE_TYPES.UI_PREPARE_ACTION,
    payload: { actionId: mutation.name, arguments: { [property]: 'Execute through mission' } },
  }, panelSender());
  assert.equal(firstPrepared.ok, true);
  assert.equal(firstPrepared.result.status, 'approval-required');
  assert.equal(firstPrepared.missionBinding.status, 'bound');
  assert.equal(firstPrepared.missionBinding.missionId, 'mission-actions');

  let state = await controller.handleRuntimeMessage({ type: UI_MESSAGE_TYPES.UI_GET_STATE }, panelSender());
  assert.equal(state.ok, true);
  assert.equal(state.state.sessionId, ready.channel.sessionId);
  assert.deepEqual(state.state.missions[0].pendingActions.map((action) => action.actionId), [firstPrepared.preparedAction.actionId]);

  const localApprovals = createApprovalStore({ storageArea: area, cryptoRef: fakeCrypto() });
  const localApproval = await localApprovals.createApproval({ event: { isTrusted: true }, action: firstPrepared.preparedAction });
  const approved = await controller.handleRuntimeMessage({
    type: UI_MESSAGE_TYPES.UI_APPROVE_ACTION,
    payload: { decision: 'approve', approval: localApproval },
  }, panelSender());
  assert.equal(approved.ok, true);
  const executed = await controller.handleRuntimeMessage({
    type: UI_MESSAGE_TYPES.UI_EXECUTE_ACTION,
    payload: { approval: localApproval },
  }, panelSender());
  assert.equal(executed.ok, true);
  assert.equal(executed.missionBinding.status, 'resolved');
  state = await controller.handleRuntimeMessage({ type: UI_MESSAGE_TYPES.UI_GET_STATE }, panelSender());
  assert.deepEqual(state.state.missions[0].pendingActions, []);

  const secondPrepared = await controller.handleRuntimeMessage({
    type: UI_MESSAGE_TYPES.UI_PREPARE_ACTION,
    payload: { actionId: mutation.name, arguments: { [property]: 'Deny through mission' } },
  }, panelSender());
  assert.equal(secondPrepared.missionBinding.status, 'bound');
  const denied = await controller.handleRuntimeMessage({
    type: UI_MESSAGE_TYPES.UI_APPROVE_ACTION,
    payload: { decision: 'deny', action: secondPrepared.preparedAction },
  }, panelSender());
  assert.equal(denied.ok, true);
  assert.equal(denied.missionBinding.status, 'resolved');
  state = await controller.handleRuntimeMessage({ type: UI_MESSAGE_TYPES.UI_GET_STATE }, panelSender());
  assert.deepEqual(state.state.missions[0].pendingActions, []);

  // Generic page interactions are intentionally conservative mutations. A
  // verified adapter may expose a reversible stage descriptor; the
  // coordinator's resolution path is covered independently.
  state = await controller.handleRuntimeMessage({ type: UI_MESSAGE_TYPES.UI_GET_STATE }, panelSender());
  assert.deepEqual(state.state.missions[0].pendingActions, []);
});
