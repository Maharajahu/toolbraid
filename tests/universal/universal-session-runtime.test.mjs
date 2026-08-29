import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createMemoryKeyValueStore,
  createPersistentApprovalLedger,
  createPersistentAuditTrail,
} from '../../src/persistence/index.js';
import { createUniversalSessionRuntime } from '../../src/runtime/index.js';
import { createPageSnapshot, generateWebMcpToolDescriptors } from '../../src/universal/index.js';

function snapshot({ title = 'Fixture', formLabel = 'Publish public notice' } = {}) {
  return {
    metadata: { url: 'https://example.test/form', origin: 'https://example.test', title },
    mainText: 'Publish a customer notice.',
    forms: [{
      ref: 'notice-form', name: formLabel, action: 'https://example.test/api/submit', method: 'POST',
      fields: [{ ref: 'message', name: 'Message', type: 'text', required: true }],
    }],
    accessibleControls: [{ ref: 'draft', role: 'textbox', name: 'Draft note', type: 'text' }],
    elementRefs: [
      { ref: 'notice-form', tagName: 'form', role: 'form', name: formLabel },
      { ref: 'draft', tagName: 'input', role: 'textbox', name: 'Draft note', type: 'text' },
    ],
  };
}

test('ingests a page, registers safe generated tools, and executes a read', async () => {
  let registered;
  const ledger = await createPersistentApprovalLedger({ store: createMemoryKeyValueStore() });
  const runtime = createUniversalSessionRuntime({
    approvalLedger: ledger,
    registerTools: async (request) => { registered = request; return { ok: true }; },
    executePageAction: async () => { throw new Error('not expected'); },
  });
  const state = await runtime.ingest({ tabId: 1, sessionId: 'session-one', snapshot: snapshot() });
  assert.ok(registered.tools.some((tool) => tool.sourceType === 'page'));
  const read = registered.tools.find((tool) => tool.sourceType === 'page');
  const result = await runtime.executeTool({ tabId: 1, sessionId: 'session-one', name: read.name });
  assert.equal(result.type, 'page');
  assert.equal(result.untrustedContent, true);
  assert.equal(state.revision, 1);
});

test('generic page inputs and submissions remain blocked behind exact human approval', async () => {
  const calls = [];
  let tools;
  const ledger = await createPersistentApprovalLedger({ store: createMemoryKeyValueStore(), key: 'stage-ledger' });
  const runtime = createUniversalSessionRuntime({
    approvalLedger: ledger,
    registerTools: async (request) => { tools = request.tools; return { ok: true }; },
    executePageAction: async (request) => { calls.push(request); return { changed: true }; },
  });
  await runtime.ingest({ tabId: 2, sessionId: 'session-two', snapshot: snapshot() });
  assert.equal(tools.some((tool) => tool.classification === 'stage'), false);
  const inputMutation = tools.find((tool) => tool.target.ref === 'draft');
  const formMutation = tools.find((tool) => tool.target.ref === 'notice-form');
  assert.equal(inputMutation.classification, 'mutate');
  assert.equal(formMutation.classification, 'mutate');

  const inputProperty = Object.keys(inputMutation.inputSchema.properties)[0];
  const inputPending = await runtime.executeTool({ tabId: 2, sessionId: 'session-two', name: inputMutation.name, input: { [inputProperty]: 'Draft only' } });
  assert.equal(inputPending.status, 'approval-required');
  assert.equal(calls.length, 0);

  const formProperty = Object.keys(formMutation.inputSchema.properties)[0];
  const formPending = await runtime.executeTool({ tabId: 2, sessionId: 'session-two', name: formMutation.name, input: { [formProperty]: 'Publish me' } });
  assert.equal(formPending.status, 'approval-required');
  assert.equal(calls.length, 0);
});

test('binds approval to exact page state and executes only after a durable claim', async () => {
  let tools;
  const calls = [];
  const ledger = await createPersistentApprovalLedger({ store: createMemoryKeyValueStore(), key: 'execute-ledger' });
  const runtime = createUniversalSessionRuntime({
    approvalLedger: ledger,
    registerTools: async (request) => { tools = request.tools; return { ok: true }; },
    executePageAction: async (request) => { calls.push(request); return { receiptId: 'r-1' }; },
    now: () => new Date('2026-08-29T00:00:00.000Z'),
  });
  const original = snapshot();
  await runtime.ingest({ tabId: 3, sessionId: 'session-three', snapshot: original });
  const mutation = tools.find((tool) => tool.classification === 'mutate');
  const property = Object.keys(mutation.inputSchema.properties)[0];
  const pending = await runtime.executeTool({ tabId: 3, sessionId: 'session-three', name: mutation.name, input: { [property]: 'Publish' } });
  const envelope = await runtime.approve({ tabId: 3, sessionId: 'session-three', actionId: pending.preparedAction.actionId, ttlMs: 60_000 });
  assert.match(envelope.fingerprint, /^[a-f0-9]{64}$/);

  await assert.rejects(
    runtime.executeApproved({ tabId: 3, sessionId: 'session-three', actionId: pending.preparedAction.actionId, snapshot: snapshot({ title: 'Changed' }) }),
    /changed|drift/i,
  );
  assert.equal(calls.length, 0);

  const result = await runtime.executeApproved({ tabId: 3, sessionId: 'session-three', actionId: pending.preparedAction.actionId, snapshot: original });
  assert.equal(result.status, 'dispatched');
  assert.equal(result.outcome, 'postcondition-unverified');
  assert.equal(result.postcondition, 'unverified');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].approved, true);
  assert.equal(await ledger.has(envelope.nonce, { now: new Date('2026-08-29T00:00:30.000Z') }), true);
});

test('page drift increments revision and invalidates pending authority', async () => {
  let tools;
  const ledger = await createPersistentApprovalLedger({ store: createMemoryKeyValueStore(), key: 'drift-ledger' });
  const runtime = createUniversalSessionRuntime({
    approvalLedger: ledger,
    registerTools: async (request) => { tools = request.tools; return { ok: true }; },
    executePageAction: async () => ({}),
  });
  await runtime.ingest({ tabId: 4, sessionId: 'session-four', snapshot: snapshot() });
  const mutation = tools.find((tool) => tool.classification === 'mutate');
  const property = Object.keys(mutation.inputSchema.properties)[0];
  const pending = await runtime.executeTool({ tabId: 4, sessionId: 'session-four', name: mutation.name, input: { [property]: 'Publish' } });
  await runtime.approve({ tabId: 4, sessionId: 'session-four', actionId: pending.preparedAction.actionId });
  const updated = await runtime.ingest({ tabId: 4, sessionId: 'session-four', snapshot: snapshot({ title: 'Changed' }) });
  assert.equal(updated.revision, 2);
  assert.equal(updated.pendingActions.length, 0);
  assert.equal(updated.approvals.length, 0);
});

test('serializes concurrent snapshot commits and registrations in arrival order', async () => {
  let registrationCalls = 0;
  let releaseFirstRegistration;
  let markFirstRegistrationStarted;
  const firstRegistrationGate = new Promise((resolve) => { releaseFirstRegistration = resolve; });
  const firstRegistrationStarted = new Promise((resolve) => { markFirstRegistrationStarted = resolve; });
  const completedRegistrations = [];
  const ledger = await createPersistentApprovalLedger({ store: createMemoryKeyValueStore(), key: 'snapshot-order-ledger' });
  const runtime = createUniversalSessionRuntime({
    approvalLedger: ledger,
    registerTools: async (request) => {
      registrationCalls += 1;
      const fingerprint = request.tools[0].provenance.pageFingerprint;
      if (registrationCalls === 1) {
        markFirstRegistrationStarted();
        await firstRegistrationGate;
      }
      completedRegistrations.push(fingerprint);
      return { ok: true };
    },
    executePageAction: async () => ({}),
  });
  const firstSnapshot = snapshot({ title: 'Slow snapshot A' });
  const secondSnapshot = snapshot({ title: 'Fast snapshot B' });
  const firstFingerprint = createPageSnapshot(firstSnapshot).pageFingerprint;
  const secondFingerprint = createPageSnapshot(secondSnapshot).pageFingerprint;

  const first = runtime.ingest({ tabId: 41, sessionId: 'session-snapshot-order', snapshot: firstSnapshot });
  await firstRegistrationStarted;
  const second = runtime.ingest({ tabId: 41, sessionId: 'session-snapshot-order', snapshot: secondSnapshot });

  assert.equal(registrationCalls, 1);
  assert.deepEqual(completedRegistrations, []);
  releaseFirstRegistration();
  const [firstState, secondState] = await Promise.all([first, second]);

  assert.equal(firstState.pageFingerprint, firstFingerprint);
  assert.equal(secondState.pageFingerprint, secondFingerprint);
  assert.deepEqual(completedRegistrations, [firstFingerprint, secondFingerprint]);
  assert.equal(runtime.state(41).pageFingerprint, secondFingerprint);
});

test('denial removes the exact pending mutation without executing it', async () => {
  const executions = [];
  const ledger = await createPersistentApprovalLedger({ store: createMemoryKeyValueStore(), key: 'denial-ledger' });
  const runtime = createUniversalSessionRuntime({
    approvalLedger: ledger,
    registerTools: async () => ({ ok: true }),
    executePageAction: async (request) => { executions.push(request); return {}; },
  });
  const initial = await runtime.ingest({ tabId: 5, sessionId: 'session-denial', snapshot: snapshot() });
  const mutation = initial.tools.find((tool) => tool.classification === 'mutate');
  const property = Object.keys(mutation.inputSchema.properties)[0];
  const prepared = await runtime.executeTool({
    tabId: 5,
    sessionId: 'session-denial',
    name: mutation.name,
    input: { [property]: 'Do not send' },
  });

  const denied = await runtime.deny({
    tabId: 5,
    sessionId: 'session-denial',
    actionId: prepared.preparedAction.actionId,
  });

  assert.equal(denied.status, 'denied');
  assert.equal(runtime.state(5).pendingActions.length, 0);
  assert.equal(executions.length, 0);
});

test('durably records dispatch, redacts its receipt, and rehydrates it after restart', async () => {
  const store = createMemoryKeyValueStore();
  const auditKey = 'audit:durable-dispatch';
  const auditForSession = () => createPersistentAuditTrail({
    store,
    key: auditKey,
    now: () => new Date('2026-08-29T00:05:00.000Z'),
  });
  let tools;
  const ledger = await createPersistentApprovalLedger({
    store,
    key: 'durable-dispatch-ledger',
    now: () => new Date('2026-08-29T00:05:00.000Z'),
  });
  const runtime = createUniversalSessionRuntime({
    approvalLedger: ledger,
    auditForSession,
    registerTools: async (request) => { tools = request.tools; return { ok: true }; },
    executePageAction: async () => ({
      receiptId: 'receipt-durable-one',
      operation: 'submit',
      ref: 'notice-form',
      changed: { operation: 'set', applied: true, value: 'must-not-persist' },
      events: ['input', 'submit'],
      secret: 'must-not-persist',
    }),
    now: () => new Date('2026-08-29T00:05:00.000Z'),
  });
  const original = snapshot();
  await runtime.ingest({ tabId: 6, sessionId: 'session-durable-dispatch', snapshot: original });
  const mutation = tools.find((tool) => tool.classification === 'mutate');
  const property = Object.keys(mutation.inputSchema.properties)[0];
  const pending = await runtime.executeTool({
    tabId: 6,
    sessionId: 'session-durable-dispatch',
    name: mutation.name,
    input: { [property]: 'Publish' },
  });
  await runtime.approve({
    tabId: 6,
    sessionId: 'session-durable-dispatch',
    actionId: pending.preparedAction.actionId,
    ttlMs: 60_000,
  });
  const result = await runtime.executeApproved({
    tabId: 6,
    sessionId: 'session-durable-dispatch',
    actionId: pending.preparedAction.actionId,
    snapshot: original,
  });
  assert.equal(result.status, 'dispatched');
  assert.equal(result.postcondition, 'unverified');
  assert.equal(result.receipt.secret, undefined);
  assert.equal(result.receipt.changed.value, '[redacted]');

  const trail = await createPersistentAuditTrail({ store, key: auditKey });
  const entries = await trail.entries();
  assert.ok(entries.find((entry) => entry.event === 'action.dispatching'));
  const dispatched = entries.find((entry) => entry.event === 'action.dispatched');
  assert.ok(dispatched);
  assert.equal(dispatched.details.receipt.secret, undefined);
  assert.equal(dispatched.details.receipt.changed.value, '[redacted]');
  assert.equal(entries.some((entry) => entry.event === 'action.executed'), false);

  const restarted = createUniversalSessionRuntime({
    approvalLedger: await createPersistentApprovalLedger({
      store,
      key: 'durable-dispatch-ledger',
      now: () => new Date('2026-08-29T00:06:00.000Z'),
    }),
    auditForSession,
    registerTools: async () => ({ ok: true }),
    executePageAction: async () => { throw new Error('not expected'); },
  });
  const restored = await restarted.ingest({
    tabId: 6,
    sessionId: 'session-durable-dispatch',
    snapshot: original,
  });
  assert.equal(restored.receipts.length, 1);
  assert.equal(restored.receipts[0].status, 'dispatched');
  assert.equal(restored.receipts[0].outcome, 'postcondition-unverified');
  assert.equal(restored.receipts[0].receipt.receiptId, 'receipt-durable-one');
});

test('rehydrates an unmatched durable dispatch as outcome unknown after a receipt crash', async () => {
  const store = createMemoryKeyValueStore();
  const auditKey = 'audit:dispatch-crash';
  let crashReceipt = true;
  const auditForSession = async () => {
    const trail = await createPersistentAuditTrail({
      store,
      key: auditKey,
      now: () => new Date('2026-08-29T00:10:00.000Z'),
    });
    if (!crashReceipt) return trail;
    return Object.freeze({
      ...trail,
      async append(event, details) {
        if (event === 'action.dispatched') {
          crashReceipt = false;
          throw new Error('simulated crash after page dispatch');
        }
        return trail.append(event, details);
      },
    });
  };
  let tools;
  let effects = 0;
  const runtime = createUniversalSessionRuntime({
    approvalLedger: await createPersistentApprovalLedger({
      store,
      key: 'dispatch-crash-ledger',
      now: () => new Date('2026-08-29T00:10:00.000Z'),
    }),
    auditForSession,
    registerTools: async (request) => { tools = request.tools; return { ok: true }; },
    executePageAction: async () => { effects += 1; return { receiptId: 'lost-receipt', operation: 'submit' }; },
    now: () => new Date('2026-08-29T00:10:00.000Z'),
  });
  const original = snapshot();
  await runtime.ingest({ tabId: 7, sessionId: 'session-dispatch-crash', snapshot: original });
  const mutation = tools.find((tool) => tool.classification === 'mutate');
  const property = Object.keys(mutation.inputSchema.properties)[0];
  const pending = await runtime.executeTool({
    tabId: 7,
    sessionId: 'session-dispatch-crash',
    name: mutation.name,
    input: { [property]: 'Publish once' },
  });
  await runtime.approve({
    tabId: 7,
    sessionId: 'session-dispatch-crash',
    actionId: pending.preparedAction.actionId,
    ttlMs: 60_000,
  });
  await assert.rejects(
    runtime.executeApproved({
      tabId: 7,
      sessionId: 'session-dispatch-crash',
      actionId: pending.preparedAction.actionId,
      snapshot: original,
    }),
    (error) => error.code === 'ACTION_OUTCOME_UNKNOWN',
  );
  assert.equal(effects, 1);
  assert.equal(runtime.state(7).receipts[0].status, 'outcome-unknown');

  const persisted = await createPersistentAuditTrail({ store, key: auditKey });
  const crashEntries = await persisted.entries();
  assert.ok(crashEntries.find((entry) => entry.event === 'action.dispatching'));
  assert.equal(crashEntries.some((entry) => entry.event === 'action.dispatched'), false);

  const restarted = createUniversalSessionRuntime({
    approvalLedger: await createPersistentApprovalLedger({
      store,
      key: 'dispatch-crash-ledger',
      now: () => new Date('2026-08-29T00:11:00.000Z'),
    }),
    auditForSession: () => createPersistentAuditTrail({ store, key: auditKey }),
    registerTools: async () => ({ ok: true }),
    executePageAction: async () => { throw new Error('not expected'); },
  });
  const restored = await restarted.ingest({
    tabId: 7,
    sessionId: 'session-dispatch-crash',
    snapshot: original,
  });
  assert.equal(restored.receipts.length, 1);
  assert.equal(restored.receipts[0].status, 'outcome-unknown');
  assert.equal(restored.receipts[0].outcome, 'unknown');
  assert.equal(restored.receipts[0].postcondition, 'unverified');
});

test('quarantines duplicate descriptor names with the winning descriptor identity', async () => {
  const semanticSnapshot = createPageSnapshot(snapshot());
  const winner = generateWebMcpToolDescriptors(semanticSnapshot, { includePageRead: true })[0];
  const duplicate = { ...structuredClone(winner), title: `${winner.title} conflicting duplicate` };
  const ledger = await createPersistentApprovalLedger({ store: createMemoryKeyValueStore(), key: 'duplicate-ledger' });
  const runtime = createUniversalSessionRuntime({
    approvalLedger: ledger,
    siteAdapterRegistry: {
      generateTools: () => [winner, duplicate],
      executeRead: () => ({}),
    },
    registerTools: async () => ({ ok: true }),
    executePageAction: async () => ({}),
  });
  const state = await runtime.ingest({ tabId: 8, sessionId: 'session-duplicate-tools', snapshot: snapshot() });
  const quarantined = state.quarantined.find((entry) => entry.assessment?.reasonCode === 'TOOL_NAME_DUPLICATE');
  assert.ok(quarantined);
  assert.equal(quarantined.descriptor.name, winner.name);
  assert.equal(quarantined.winningDescriptor.name, winner.name);
  assert.equal(quarantined.winningDescriptor.sourceType, winner.sourceType);
  assert.equal(quarantined.assessment.evidence[0].winningDescriptor.name, winner.name);
  assert.equal(state.tools.filter((tool) => tool.name === winner.name).length, 1);
});
