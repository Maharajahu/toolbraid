import assert from 'node:assert/strict';
import test from 'node:test';

import {
  POSTCONDITION_STATUSES,
  applyPostconditionResult,
  normalizePostconditionResult,
  validatePostconditionContract,
} from '../../src/universal/postconditions.js';
import {
  createMemoryKeyValueStore,
  createPersistentApprovalLedger,
  createPersistentAuditTrail,
} from '../../src/persistence/index.js';
import { createUniversalSessionRuntime } from '../../src/runtime/index.js';
import { createSiteAdapterRegistry } from '../../src/site-adapters/index.js';
import { createPageSnapshot, generateWebMcpToolDescriptors, prepareAction } from '../../src/universal/index.js';

const CONTRACT = Object.freeze({
  version: 1,
  id: 'fixture.submit',
  adapterId: 'fixture',
  adapterVersion: '1',
  observation: 'page-snapshot',
});

function snapshot({ title = 'Fixture' } = {}) {
  return {
    metadata: { url: 'https://example.test/form', origin: 'https://example.test', title },
    mainText: 'Submit a customer notice.',
    accessibleControls: [{ ref: 'submit', role: 'button', name: 'Submit', type: 'button' }],
    elementRefs: [{ ref: 'submit', tagName: 'button', role: 'button', name: 'Submit', type: 'button' }],
  };
}

function baseReceipt() {
  return {
    dispatchId: 'dispatch:one',
    actionId: 'action-one',
    mode: 'mutation',
    status: 'dispatched',
    outcome: 'postcondition-unverified',
    postcondition: 'unverified',
    receipt: { receiptId: 'receipt-one', operation: 'click', ref: 'submit' },
    approvalClaim: { fingerprint: 'a'.repeat(64) },
  };
}

test('validates a bounded declarative postcondition contract', () => {
  assert.deepEqual(validatePostconditionContract(CONTRACT), CONTRACT);
  assert.throws(
    () => validatePostconditionContract({ ...CONTRACT, observation: 'network' }),
    (error) => error.code === 'POSTCONDITION_CONTRACT_INVALID',
  );
  assert.throws(
    () => validatePostconditionContract({ ...CONTRACT, adapterId: 'fixture', extra: true }),
    (error) => error.code === 'POSTCONDITION_CONTRACT_INVALID',
  );
});

test('binds postconditions only to verified mutation descriptors', () => {
  const { tool } = mutationTool();
  assert.doesNotThrow(() => generateWebMcpToolDescriptors(createPageSnapshot(snapshot()), { includePageRead: true }));
  assert.throws(
    () => {
      const read = {
        ...tool,
        classification: 'read',
        kind: 'read',
        requiresApproval: false,
        annotations: { ...tool.annotations, readOnlyHint: true },
        effect: { ...tool.effect, classification: 'read', externalStateChange: false, requiresApproval: false },
      };
      prepareAction({ snapshot: createPageSnapshot(snapshot()), descriptor: read, input: {} });
    },
    (error) => error.code === 'TOOL_POSTCONDITION_INVALID',
  );
});

test('registry passes a canonical after-snapshot observation to the bound adapter verifier', () => {
  const { page, tool } = mutationTool();
  const after = createPageSnapshot(snapshot({ title: 'Confirmed' }));
  let contextSeen;
  const registry = createSiteAdapterRegistry({
    adapters: [{
      id: 'fixture',
      version: '1',
      matches: () => true,
      generateTools: () => [],
      verifyPostcondition: (context) => {
        contextSeen = context;
        return {
          status: 'verified-success',
          reasonCode: 'CONFIRMED',
          afterPageFingerprint: context.afterSnapshot.pageFingerprint,
        };
      },
    }],
  });
  const result = registry.verifyPostcondition(tool, {
    tabId: 1,
    frameId: 0,
    sessionId: 'session-fixture-bound',
    preparedAction: { actionId: 'action-one' },
    dispatchReceipt: { receiptId: 'receipt-one' },
    beforeSnapshot: page,
    afterSnapshot: after,
  });
  assert.equal(result.status, 'verified-success');
  assert.equal(contextSeen.contract.id, CONTRACT.id);
  assert.equal(contextSeen.beforeSnapshot.pageFingerprint, page.pageFingerprint);
  assert.equal(contextSeen.afterSnapshot.pageFingerprint, after.pageFingerprint);
  assert.equal(contextSeen.tool.name, tool.name);
});

test('registry rejects a stale same-origin after fingerprint even when the adapter matches everything', () => {
  const { page, tool } = mutationTool();
  const after = createPageSnapshot(snapshot({ title: 'Changed after dispatch' }));
  let calls = 0;
  const registry = createSiteAdapterRegistry({
    adapters: [{
      id: 'fixture',
      version: '1',
      matches: () => true,
      generateTools: () => [],
      verifyPostcondition: () => {
        calls += 1;
        return { status: 'verified-success' };
      },
    }],
  });
  const result = registry.verifyPostcondition(tool, {
    tabId: 1,
    frameId: 0,
    sessionId: 'session-fixture-stale',
    beforeSnapshot: page,
    afterSnapshot: after,
  });
  assert.equal(result.status, 'unverified');
  assert.equal(result.reasonCode, 'POSTCONDITION_FINGERPRINT_MISMATCH');
  assert.equal(result.afterPageFingerprint, after.pageFingerprint);
  assert.equal(calls, 1);
});

test('registry quarantines null, non-array, and malformed direct adapter tool output', () => {
  const page = createPageSnapshot(snapshot());
  const valid = mutationTool().tool;
  for (const generated of [null, { name: 'not-an-array' }, [null], [{ name: 'malformed' }]]) {
    const registry = createSiteAdapterRegistry({
      adapters: [{
        id: 'fixture',
        version: '1',
        matches: () => true,
        generateTools: () => generated,
      }],
    });
    assert.deepEqual(registry.generateTools(page), []);
  }
  const mixed = createSiteAdapterRegistry({
    adapters: [{
      id: 'fixture',
      version: '1',
      matches: () => true,
      generateTools: () => [valid, null],
    }],
  });
  assert.equal(mixed.generateTools(page).length, 1);
});

test('registry rejects an alternate-origin observation and requires bound execution context', () => {
  const { page, tool } = mutationTool();
  const alternate = createPageSnapshot({
    ...snapshot(),
    metadata: { ...snapshot().metadata, url: 'https://attacker.example/form', origin: 'https://attacker.example' },
  });
  let calls = 0;
  const registry = createSiteAdapterRegistry({
    adapters: [{
      id: 'fixture',
      version: '1',
      matches: () => true,
      generateTools: () => [],
      verifyPostcondition: () => {
        calls += 1;
        return { status: 'verified-success' };
      },
    }],
  });
  const context = {
    tabId: 1,
    frameId: 0,
    sessionId: 'session-fixture-bound',
    beforeSnapshot: page,
    afterSnapshot: alternate,
  };
  const result = registry.verifyPostcondition(tool, context);
  assert.equal(result.status, 'unverified');
  assert.equal(result.reasonCode, 'POSTCONDITION_ORIGIN_MISMATCH');
  assert.equal(calls, 0);
  const missingBinding = registry.verifyPostcondition(tool, {
    beforeSnapshot: page,
    afterSnapshot: page,
  });
  assert.equal(missingBinding.status, 'unverified');
  assert.equal(missingBinding.reasonCode, 'POSTCONDITION_CONTEXT_INVALID');
});

test('owns adapter descriptors and verifies the prepared postcondition binding', async () => {
  const page = createPageSnapshot(snapshot());
  const source = mutationTool().tool;
  let verifierContext;
  const runtime = createUniversalSessionRuntime({
    approvalLedger: await createPersistentApprovalLedger({ store: createMemoryKeyValueStore(), key: 'postcondition-descriptor-ledger' }),
    siteAdapterRegistry: { generateTools: () => [source] },
    registerTools: async () => ({ ok: true }),
    executePageAction: async () => ({ receiptId: 'descriptor-receipt', operation: 'click', ref: 'submit' }),
    postconditionVerifier: (context) => {
      verifierContext = context;
      return { status: 'verified-success', afterPageFingerprint: '1'.repeat(64) };
    },
  });
  const actionId = await prepareAndApprove(runtime, 96, 'session-postcondition-descriptor', page, source);
  source.postcondition = { ...CONTRACT, id: 'attacker.contract' };
  const result = await runtime.executeApproved({ tabId: 96, sessionId: 'session-postcondition-descriptor', actionId, snapshot: page });
  assert.equal(result.status, 'verified-success');
  assert.equal(verifierContext.descriptor.postcondition.id, CONTRACT.id);
  assert.equal(verifierContext.preparedAction.postcondition.id, CONTRACT.id);
});

test('quarantines malformed adapter descriptor arrays without aborting page ingest', async () => {
  const page = createPageSnapshot(snapshot());
  const valid = mutationTool().tool;
  const runtime = createUniversalSessionRuntime({
    approvalLedger: await createPersistentApprovalLedger({ store: createMemoryKeyValueStore(), key: 'postcondition-descriptor-quarantine-ledger' }),
    siteAdapterRegistry: { generateTools: () => [valid, null, { name: 'malformed' }] },
    registerTools: async () => ({ ok: true }),
    executePageAction: async () => ({}),
  });
  const state = await runtime.ingest({ tabId: 97, sessionId: 'session-postcondition-quarantine', snapshot: page });
  assert.ok(state.tools.some((tool) => tool.name === valid.name));
  assert.ok(state.tools.some((tool) => tool.sourceType === 'page'));
  assert.ok(state.quarantined.some((entry) => entry.assessment?.reasonCode === 'ADAPTER_DESCRIPTOR_INVALID'));

  const malformedArrayRuntime = createUniversalSessionRuntime({
    approvalLedger: await createPersistentApprovalLedger({ store: createMemoryKeyValueStore(), key: 'postcondition-array-quarantine-ledger' }),
    siteAdapterRegistry: { generateTools: () => ({ not: 'an-array' }) },
    registerTools: async () => ({ ok: true }),
    executePageAction: async () => ({}),
  });
  const fallback = await malformedArrayRuntime.ingest({ tabId: 98, sessionId: 'session-postcondition-array-quarantine', snapshot: page });
  assert.ok(fallback.tools.some((tool) => tool.sourceType === 'page'));
  assert.ok(fallback.quarantined.some((entry) => entry.assessment?.reasonCode === 'ADAPTER_DESCRIPTOR_ARRAY_INVALID'));
});

test('normalizes success, explicit failure, and unverified postcondition verdicts', () => {
  const before = createPageSnapshot(snapshot());
  const after = createPageSnapshot(snapshot({ title: 'Confirmed' }));
  const context = {
    contract: CONTRACT,
    beforeSnapshot: before,
    afterPageFingerprint: after.pageFingerprint,
    checkedAt: '2026-08-29T00:00:00.000Z',
  };

  const success = normalizePostconditionResult({
    status: POSTCONDITION_STATUSES.VERIFIED_SUCCESS,
    reasonCode: 'CONFIRMATION_VISIBLE',
    evidence: { targetRef: 'submit', observed: 'confirmed' },
  }, context);
  assert.equal(success.status, 'verified-success');
  assert.equal(success.beforePageFingerprint, before.pageFingerprint);
  assert.equal(success.afterPageFingerprint, after.pageFingerprint);
  assert.equal(success.evidence.observed, 'confirmed');

  const failure = normalizePostconditionResult({
    status: POSTCONDITION_STATUSES.VERIFIED_FAILURE,
    reasonCode: 'ERROR_VISIBLE',
    evidence: { targetRef: 'submit', observed: 'error' },
  }, context);
  assert.equal(failure.status, 'verified-failure');

  const unverified = normalizePostconditionResult({
    status: POSTCONDITION_STATUSES.UNVERIFIED,
    reasonCode: 'SNAPSHOT_UNAVAILABLE',
  }, { ...context, afterPageFingerprint: null });
  assert.equal(unverified.status, 'unverified');
  assert.equal(unverified.afterPageFingerprint, null);
});

test('requires an observed after fingerprint for verified verdicts and bounds evidence', () => {
  const before = createPageSnapshot(snapshot());
  assert.throws(
    () => normalizePostconditionResult({ status: 'verified-success' }, {
      contract: CONTRACT,
      beforeSnapshot: before,
      checkedAt: '2026-08-29T00:00:00.000Z',
    }),
    (error) => error.code === 'POSTCONDITION_RESULT_INVALID',
  );
  assert.throws(
    () => normalizePostconditionResult({
      status: 'verified-failure',
      evidence: { value: 'x'.repeat(9000) },
    }, {
      contract: CONTRACT,
      beforeSnapshot: before,
      afterPageFingerprint: 'b'.repeat(64),
      checkedAt: '2026-08-29T00:00:00.000Z',
    }),
    (error) => error.code === 'POSTCONDITION_RESULT_INVALID',
  );
});

test('enforces global evidence node, key, key-length, and work budgets before normalization', () => {
  const context = {
    contract: CONTRACT,
    beforeSnapshot: createPageSnapshot(snapshot()),
    afterPageFingerprint: 'b'.repeat(64),
    checkedAt: '2026-08-29T00:00:00.000Z',
  };
  const tooManyKeys = Object.fromEntries(Array.from({ length: 129 }, (_, index) => [`key-${index}`, null]));
  assert.throws(
    () => normalizePostconditionResult({ status: 'verified-success', evidence: tooManyKeys }, context),
    (error) => error.code === 'POSTCONDITION_RESULT_INVALID',
  );
  assert.throws(
    () => normalizePostconditionResult({
      status: 'verified-success',
      evidence: { [`k${'x'.repeat(128)}`]: null },
    }, context),
    (error) => error.code === 'POSTCONDITION_RESULT_INVALID',
  );
  const manyNodes = {
    groups: Array.from({ length: 32 }, () => Array.from({ length: 32 }, () => ({ value: null }))),
  };
  assert.throws(
    () => normalizePostconditionResult({ status: 'verified-success', evidence: manyNodes }, context),
    (error) => error.code === 'POSTCONDITION_RESULT_INVALID',
  );
});

test('maps a verified verdict onto a known dispatch without changing dispatch identity', () => {
  const before = createPageSnapshot(snapshot());
  const result = normalizePostconditionResult({
    status: 'verified-success',
    reasonCode: 'CONFIRMED',
    evidence: { observed: 'confirmed' },
  }, {
    contract: CONTRACT,
    beforeSnapshot: before,
    afterPageFingerprint: 'b'.repeat(64),
    checkedAt: '2026-08-29T00:00:00.000Z',
  });
  const mapped = applyPostconditionResult(baseReceipt(), result);
  assert.equal(mapped.dispatchId, 'dispatch:one');
  assert.equal(mapped.status, 'verified-success');
  assert.equal(mapped.outcome, 'verified-success');
  assert.equal(mapped.postcondition, 'satisfied');
  assert.equal(mapped.receipt.receiptId, 'receipt-one');
  assert.equal(mapped.verification.status, 'verified-success');
  const unknown = applyPostconditionResult({ ...baseReceipt(), status: 'outcome-unknown', outcome: 'unknown' }, result);
  assert.equal(unknown.status, 'outcome-unknown');
  assert.equal(unknown.verification, undefined);
  const terminal = applyPostconditionResult(mapped, { ...result, status: 'verified-failure' });
  assert.equal(terminal.status, 'verified-success');
});

function mutationTool() {
  const page = createPageSnapshot(snapshot());
  const tool = generateWebMcpToolDescriptors(page, { includePageRead: true })
    .find((entry) => entry.classification === 'mutate');
  const source = structuredClone(tool);
  return {
    page,
    tool: {
      ...source,
      sourceType: 'verified-adapter',
      adapter: { id: 'fixture', version: '1' },
      provenance: {
        ...source.provenance,
        source: 'toolbraid.verified-adapter',
        adapterId: 'fixture',
        adapterVersion: '1',
        sourceType: 'verified-adapter',
      },
      postcondition: CONTRACT,
    },
  };
}

async function prepareAndApprove(runtime, tabId, sessionId, page, tool) {
  let tools;
  await runtime.ingest({ tabId, sessionId, snapshot: page });
  // The test registry returns the contract-bearing descriptor above.
  tools = runtime.state(tabId).tools;
  const active = tools.find((entry) => entry.name === tool.name);
  const property = Object.keys(active.inputSchema.properties);
  const pending = await runtime.executeTool({
    tabId,
    sessionId,
    name: active.name,
    input: property.length ? { [property[0]]: 'submit' } : {},
  });
  await runtime.approve({ tabId, sessionId, actionId: pending.preparedAction.actionId });
  return pending.preparedAction.actionId;
}

async function commitThenThrowAudit({ store, key, event }) {
  const trail = await createPersistentAuditTrail({ store, key });
  let injected = false;
  return Object.freeze({
    ...trail,
    async append(name, details) {
      const result = await trail.append(name, details);
      if (!injected && name === event) {
        injected = true;
        throw new Error(`committed then threw: ${event}`);
      }
      return result;
    },
  });
}

test('recovers committed-then-thrown audit appends without leaving replayable authority', async () => {
  const page = createPageSnapshot(snapshot());
  const { tool } = mutationTool();
  for (const [index, event] of ['approval.claimed', 'action.dispatching', 'action.dispatched'].entries()) {
    const store = createMemoryKeyValueStore();
    const auditKey = `audit:postcondition-commit-throw-${index}`;
    const effects = [];
    const runtime = createUniversalSessionRuntime({
      approvalLedger: await createPersistentApprovalLedger({ store, key: `postcondition-commit-throw-${index}-ledger` }),
      auditForSession: () => commitThenThrowAudit({ store, key: auditKey, event }),
      siteAdapterRegistry: { generateTools: () => [tool] },
      registerTools: async () => ({ ok: true }),
      executePageAction: async () => {
        effects.push(true);
        return { receiptId: `commit-throw-receipt-${index}`, operation: 'click', ref: 'submit' };
      },
      postconditionVerifier: async () => ({ status: 'verified-success', afterPageFingerprint: 'a'.repeat(64) }),
    });
    const actionId = await prepareAndApprove(runtime, 99 + index, `session-postcondition-commit-${index}`, page, tool);
    const result = await runtime.executeApproved({
      tabId: 99 + index,
      sessionId: `session-postcondition-commit-${index}`,
      actionId,
      snapshot: page,
    });
    assert.equal(result.status, 'verified-success');
    assert.equal(effects.length, 1);
    assert.equal(runtime.state(99 + index).pendingActions.length, 0);
    await assert.rejects(
      runtime.executeApproved({
        tabId: 99 + index,
        sessionId: `session-postcondition-commit-${index}`,
        actionId,
        snapshot: page,
      }),
      (error) => error.code === 'APPROVAL_REQUIRED',
    );
  }
});

test('runtime upgrades only a persisted known dispatch and leaves generic actions unchanged', async () => {
  const page = createPageSnapshot(snapshot());
  const { tool } = mutationTool();
  const store = createMemoryKeyValueStore();
  const auditKey = 'audit:postcondition-success';
  const ledger = await createPersistentApprovalLedger({ store, key: 'postcondition-success-ledger' });
  const calls = [];
  const runtime = createUniversalSessionRuntime({
    approvalLedger: ledger,
    auditForSession: () => createPersistentAuditTrail({ store, key: auditKey }),
    siteAdapterRegistry: { generateTools: () => [tool] },
    registerTools: async () => ({ ok: true }),
    executePageAction: async () => ({ receiptId: 'receipt-success', operation: 'click', ref: 'submit' }),
    postconditionVerifier: async (context) => {
      calls.push(context);
      return {
        status: 'verified-success',
        afterPageFingerprint: 'b'.repeat(64),
        reasonCode: 'CONFIRMED',
        evidence: { observed: 'confirmed' },
      };
    },
  });
  const actionId = await prepareAndApprove(runtime, 90, 'session-postcondition-success', page, tool);
  const result = await runtime.executeApproved({ tabId: 90, sessionId: 'session-postcondition-success', actionId, snapshot: page });
  assert.equal(result.status, 'verified-success');
  assert.equal(result.outcome, 'verified-success');
  assert.equal(result.postcondition, 'satisfied');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].dispatchReceipt.receiptId, 'receipt-success');
  const entries = await (await createPersistentAuditTrail({ store, key: auditKey })).entries();
  assert.deepEqual(entries.map((entry) => entry.event), [
    'page.ingested', 'action.prepared', 'approval.created', 'approval.claimed',
    'action.dispatching', 'action.dispatched', 'action.postcondition',
  ]);
});

test('runtime maps explicit postcondition failure and verifier errors to truthful outcomes', async () => {
  const page = createPageSnapshot(snapshot());
  const { tool } = mutationTool();
  const makeRuntime = async (postconditionVerifier, key) => createUniversalSessionRuntime({
    approvalLedger: await createPersistentApprovalLedger({ store: createMemoryKeyValueStore(), key: `${key}-ledger` }),
    siteAdapterRegistry: { generateTools: () => [tool] },
    registerTools: async () => ({ ok: true }),
    executePageAction: async () => ({ receiptId: `${key}-receipt`, operation: 'click', ref: 'submit' }),
    postconditionVerifier,
  });

  const failureRuntime = await makeRuntime(async () => ({
    status: 'verified-failure',
    afterPageFingerprint: 'c'.repeat(64),
    reasonCode: 'ERROR_VISIBLE',
  }), 'postcondition-failure');
  const failureActionId = await prepareAndApprove(failureRuntime, 91, 'session-postcondition-failure', page, tool);
  const failure = await failureRuntime.executeApproved({ tabId: 91, sessionId: 'session-postcondition-failure', actionId: failureActionId, snapshot: page });
  assert.equal(failure.status, 'verified-failure');
  assert.equal(failure.outcome, 'verified-failure');
  assert.equal(failure.postcondition, 'failed');

  const errorRuntime = await makeRuntime(async () => { throw new Error('snapshot unavailable'); }, 'postcondition-error');
  const errorActionId = await prepareAndApprove(errorRuntime, 92, 'session-postcondition-error', page, tool);
  const errorResult = await errorRuntime.executeApproved({ tabId: 92, sessionId: 'session-postcondition-error', actionId: errorActionId, snapshot: page });
  assert.equal(errorResult.status, 'dispatched');
  assert.equal(errorResult.outcome, 'postcondition-unverified');
  assert.equal(errorResult.postcondition, 'unverified');
});

test('times out a verifier after durable dispatch without changing the known outcome', async () => {
  const page = createPageSnapshot(snapshot());
  const { tool } = mutationTool();
  const runtime = createUniversalSessionRuntime({
    approvalLedger: await createPersistentApprovalLedger({ store: createMemoryKeyValueStore(), key: 'postcondition-timeout-ledger' }),
    siteAdapterRegistry: { generateTools: () => [tool] },
    registerTools: async () => ({ ok: true }),
    executePageAction: async () => ({ receiptId: 'timeout-receipt', operation: 'click', ref: 'submit' }),
    postconditionVerifier: async () => new Promise(() => {}),
    postconditionTimeoutMs: 5,
  });
  const actionId = await prepareAndApprove(runtime, 92, 'session-postcondition-timeout', page, tool);
  const result = await runtime.executeApproved({ tabId: 92, sessionId: 'session-postcondition-timeout', actionId, snapshot: page });
  assert.equal(result.status, 'dispatched');
  assert.equal(result.outcome, 'postcondition-unverified');
  assert.equal(result.postcondition, 'unverified');
  assert.equal(result.verification.reasonCode, 'POSTCONDITION_TIMEOUT');
});

test('aborts timed-out verifiers and ignores a late verdict', async () => {
  const page = createPageSnapshot(snapshot());
  const { tool } = mutationTool();
  const store = createMemoryKeyValueStore();
  const auditKey = 'audit:postcondition-abort';
  let observedSignal;
  let resolveLate;
  const runtime = createUniversalSessionRuntime({
    approvalLedger: await createPersistentApprovalLedger({ store, key: 'postcondition-abort-ledger' }),
    auditForSession: () => createPersistentAuditTrail({ store, key: auditKey }),
    siteAdapterRegistry: { generateTools: () => [tool] },
    registerTools: async () => ({ ok: true }),
    executePageAction: async () => ({ receiptId: 'abort-receipt', operation: 'click', ref: 'submit' }),
    postconditionVerifier: ({ signal }) => {
      observedSignal = signal;
      return new Promise((resolve) => { resolveLate = resolve; });
    },
    postconditionTimeoutMs: 5,
  });
  const actionId = await prepareAndApprove(runtime, 95, 'session-postcondition-abort', page, tool);
  const result = await runtime.executeApproved({ tabId: 95, sessionId: 'session-postcondition-abort', actionId, snapshot: page });
  assert.equal(observedSignal instanceof AbortSignal, true);
  assert.equal(observedSignal.aborted, true);
  assert.equal(result.status, 'dispatched');
  assert.equal(result.verification.reasonCode, 'POSTCONDITION_TIMEOUT');
  resolveLate({ status: 'verified-success', afterPageFingerprint: 'f'.repeat(64) });
  await Promise.resolve();
  assert.equal(runtime.state(95).receipts[0].status, 'dispatched');
  const entries = await (await createPersistentAuditTrail({
    store,
    key: auditKey,
  })).entries();
  const event = entries.find((entry) => entry.event === 'action.postcondition');
  assert.equal(event.details.verification.status, 'unverified');
});

test('rehydrates postcondition upgrades while preserving dispatch-crash unknown semantics', async () => {
  const page = createPageSnapshot(snapshot());
  const { tool } = mutationTool();
  const store = createMemoryKeyValueStore();
  const auditKey = 'audit:postcondition-rehydrate';
  const make = async (postconditionVerifier, key) => createUniversalSessionRuntime({
    approvalLedger: await createPersistentApprovalLedger({ store, key: `${key}-ledger` }),
    auditForSession: () => createPersistentAuditTrail({ store, key: auditKey }),
    siteAdapterRegistry: { generateTools: () => [tool] },
    registerTools: async () => ({ ok: true }),
    executePageAction: async () => ({ receiptId: 'receipt-rehydrate', operation: 'click', ref: 'submit' }),
    postconditionVerifier,
  });
  const first = await make(async () => ({ status: 'verified-success', afterPageFingerprint: 'd'.repeat(64) }), 'rehydrate');
  const actionId = await prepareAndApprove(first, 93, 'session-postcondition-rehydrate', page, tool);
  await first.executeApproved({ tabId: 93, sessionId: 'session-postcondition-rehydrate', actionId, snapshot: page });
  const trail = await createPersistentAuditTrail({ store, key: auditKey });
  const persisted = await trail.entries();
  const dispatched = persisted.find((entry) => entry.event === 'action.dispatched');
  const dispatching = persisted.find((entry) => entry.event === 'action.dispatching');
  await trail.append('action.dispatching', dispatching.details);
  await trail.append('action.dispatched', {
    ...dispatched.details,
    receipt: { receiptId: 'late-dispatch-receipt', operation: 'click', ref: 'submit' },
  });

  const restarted = createUniversalSessionRuntime({
    approvalLedger: await createPersistentApprovalLedger({ store, key: 'rehydrate-ledger' }),
    auditForSession: () => createPersistentAuditTrail({ store, key: auditKey }),
    registerTools: async () => ({ ok: true }),
    executePageAction: async () => { throw new Error('not expected'); },
  });
  const restored = await restarted.ingest({ tabId: 93, sessionId: 'session-postcondition-rehydrate', snapshot: page });
  assert.equal(restored.receipts[0].status, 'verified-success');
  assert.equal(restored.receipts[0].outcome, 'verified-success');

  const unknownStore = createMemoryKeyValueStore();
  let crash = true;
  const unknownAudit = async () => {
    const trail = await createPersistentAuditTrail({ store: unknownStore, key: 'audit:postcondition-crash' });
    if (!crash) return trail;
    return Object.freeze({ ...trail, async append(event, details) {
      if (event === 'action.dispatched') { crash = false; throw new Error('dispatch receipt crash'); }
      return trail.append(event, details);
    } });
  };
  const unknownRuntime = createUniversalSessionRuntime({
    approvalLedger: await createPersistentApprovalLedger({ store: unknownStore, key: 'unknown-ledger' }),
    auditForSession: unknownAudit,
    siteAdapterRegistry: { generateTools: () => [tool] },
    registerTools: async () => ({ ok: true }),
    executePageAction: async () => ({ receiptId: 'receipt-unknown', operation: 'click', ref: 'submit' }),
    postconditionVerifier: async () => ({ status: 'verified-success', afterPageFingerprint: 'e'.repeat(64) }),
  });
  const unknownActionId = await prepareAndApprove(unknownRuntime, 94, 'session-postcondition-unknown', page, tool);
  await assert.rejects(
    unknownRuntime.executeApproved({ tabId: 94, sessionId: 'session-postcondition-unknown', actionId: unknownActionId, snapshot: page }),
    (error) => error.code === 'ACTION_OUTCOME_UNKNOWN',
  );
  assert.equal(unknownRuntime.state(94).receipts[0].status, 'outcome-unknown');
});
