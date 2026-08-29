import assert from 'node:assert/strict';
import test from 'node:test';

import { createApprovalStore } from '../../extension/approval-store.js';
import { MESSAGE_TYPES, createEnvelope, parseEnvelope } from '../../extension/protocol.js';
import { createServiceWorkerController } from '../../extension/service-worker.js';

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
