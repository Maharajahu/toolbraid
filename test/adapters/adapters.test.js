import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ADAPTER_KINDS,
  ADAPTER_PRIORITY,
  ADAPTER_SCHEMA_LIMITS,
  ADAPTER_VALUE_LIMITS,
  AdapterContractError,
  createAdapterFixtures,
  createAdapterRegistry,
  createDomAccessibilityAdapter,
  createStructuredAdapter,
  createVisionFallbackAdapter,
  createWebMcpAdapter,
  isJsonSafe,
  isSafeRegexPattern,
  normalizeOrigin,
  validateSchema,
  validateSchemaDefinition,
  validateJsonValueBounds,
} from '../../src/adapters/index.js';

const origin = 'https://shop.example.test';
const argsSchema = { type: 'object', additionalProperties: false, required: ['id'], properties: { id: { type: 'string' } } };
const outputSchema = { type: 'object', additionalProperties: false, required: ['id'], properties: { id: { type: 'string' } } };

function readCapability({ name = 'records.lookup', mutates = false, semanticTarget } = {}) {
  return {
    name,
    readOnly: !mutates,
    ...(semanticTarget === undefined ? {} : { semanticTarget }),
    inputSchema: argsSchema,
    outputSchema,
  };
}

test('normalizes and binds canonical HTTP(S) origins', () => {
  assert.equal(normalizeOrigin({ origin: 'HTTPS://SHOP.EXAMPLE.TEST/' }), origin);
  assert.throws(() => normalizeOrigin({ origin: `${origin}/orders` }), (error) => error.code === 'ADAPTER_ORIGIN_NOT_CANONICAL');
  assert.throws(() => normalizeOrigin({ origin: 'file:///tmp/data' }), (error) => error.code === 'ADAPTER_ORIGIN_PROTOCOL');
});

test('WebMCP manifests cannot self-assert their trusted execution origin', () => {
  assert.throws(
    () => createWebMcpAdapter({
      manifest: {
        origin: 'http://169.254.169.254',
        capabilities: [readCapability({ name: 'cloud.metadata.read' })],
      },
      handlers: { 'cloud.metadata.read': () => ({ denied: false }) },
    }),
    (error) => error instanceof AdapterContractError && error.code === 'WEBMCP_TRUSTED_ORIGIN_REQUIRED',
  );
});

test('typed adapters expose JSON-safe semantic descriptors', () => {
  const fixtures = createAdapterFixtures({ origin });
  for (const adapter of [fixtures.structured, fixtures.webmcp, fixtures.dom, fixtures.vision]) {
    const descriptor = adapter.describe({});
    assert.equal(isJsonSafe({ value: descriptor }), true);
    assert.equal(typeof descriptor.kind, 'string');
    assert.deepEqual(descriptor.origins, [origin]);
    assert.ok(descriptor.capabilities.length > 0);
    assert.equal(Object.keys(adapter).some((key) => /click|shell|browser/i.test(key)), false);
  }
  assert.deepEqual(ADAPTER_PRIORITY, [
    ADAPTER_KINDS.STRUCTURED_API,
    ADAPTER_KINDS.WEBMCP,
    ADAPTER_KINDS.DOM_ACCESSIBILITY,
    ADAPTER_KINDS.VISION,
  ]);
});

test('getCapability returns detached, deeply frozen snapshots', () => {
  const adapter = createStructuredAdapter({
    origin,
    capabilities: [{
      name: 'orders.update',
      readOnly: false,
      tags: ['orders', 'mutation'],
      confidence: 0.7,
      confidenceRationale: ['host-confirmed'],
      riskScore: 0.4,
      riskFactors: ['writes-order-state'],
      semanticTarget: {
        role: 'region',
        name: 'Orders',
        attributes: { scope: 'private' },
      },
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: { orderId: { type: 'string' } },
      },
      outputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: { result: { type: 'object', properties: { id: { type: 'string' } } } },
      },
    }],
    handlers: { 'orders.update': () => ({}) },
  });

  const first = adapter.getCapability({ name: 'orders.update' });
  const second = adapter.getCapability({ name: 'orders.update' });
  assert.notEqual(first, second);
  assert.notEqual(first.inputSchema, second.inputSchema);
  assert.notEqual(first.outputSchema, second.outputSchema);
  assert.notEqual(first.semanticTarget, second.semanticTarget);
  assert.notEqual(first.confidenceMetadata, second.confidenceMetadata);
  assert.notEqual(first.confidenceMetadata.rationale, second.confidenceMetadata.rationale);
  assert.notEqual(first.risk, second.risk);
  assert.notEqual(first.risk.factors, second.risk.factors);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.inputSchema), true);
  assert.equal(Object.isFrozen(first.inputSchema.properties), true);
  assert.equal(Object.isFrozen(first.inputSchema.properties.orderId), true);
  assert.equal(Object.isFrozen(first.outputSchema), true);
  assert.equal(Object.isFrozen(first.outputSchema.properties), true);
  assert.equal(Object.isFrozen(first.outputSchema.properties.result), true);
  assert.equal(Object.isFrozen(first.outputSchema.properties.result.properties), true);
  assert.equal(Object.isFrozen(first.outputSchema.properties.result.properties.id), true);
  assert.equal(Object.isFrozen(first.semanticTarget), true);
  assert.equal(Object.isFrozen(first.semanticTarget.attributes), true);
  assert.equal(Object.isFrozen(first.confidenceMetadata), true);
  assert.equal(Object.isFrozen(first.confidenceMetadata.rationale), true);
  assert.equal(Object.isFrozen(first.risk), true);
  assert.equal(Object.isFrozen(first.risk.factors), true);
  assert.equal(Object.isFrozen(first.tags), true);
  assert.throws(() => { first.mutates = false; }, TypeError);
  assert.throws(() => { first.inputSchema.properties.orderId.type = 'number'; }, TypeError);
  assert.throws(() => { first.outputSchema.properties.result.properties.id.type = 'number'; }, TypeError);
  assert.throws(() => { first.semanticTarget.attributes.scope = 'public'; }, TypeError);
  assert.throws(() => { first.confidenceMetadata.rationale.push('tampered'); }, TypeError);
  assert.throws(() => { first.risk.factors.push('tampered'); }, TypeError);
  assert.throws(() => { first.tags.push('tampered'); }, TypeError);
  assert.equal(second.mutates, true);
  assert.equal(second.inputSchema.properties.orderId.type, 'string');
  assert.equal(second.outputSchema.properties.result.properties.id.type, 'string');
  assert.equal(second.semanticTarget.attributes.scope, 'private');
  assert.deepEqual(second.confidenceMetadata.rationale, ['host-confirmed']);
  assert.deepEqual(second.risk.factors, ['writes-order-state']);
  assert.deepEqual(second.tags, ['orders', 'mutation']);

  const denied = adapter.execute({ origin, capability: 'orders.update', args: {} });
  assert.equal(denied.ok, false);
  assert.equal(denied.error.code, 'ADAPTER_APPROVAL_REQUIRED');
});

test('registry chooses the safest available adapter by fixed priority', () => {
  const { registry } = createAdapterFixtures({ origin });
  const selection = registry.select({ origin, capability: 'orders.lookup' });
  assert.equal(selection.ok, true);
  assert.equal(selection.selectedAdapterId, 'structured.api');
  assert.equal(selection.selected.priority, 0);
  assert.equal(selection.selected.confidence, 0.98);
  assert.equal(selection.selected.risk.level, 'low');
  assert.deepEqual(selection.routing.order, [...ADAPTER_PRIORITY]);
});

test('registry falls back through WebMCP and DOM only when higher priorities are unavailable', () => {
  const structured = createStructuredAdapter({
    origin,
    capabilities: [readCapability()],
    handlers: { 'records.lookup': ({ args }) => ({ id: args.id }) },
    availability: ({ request }) => ({ available: request?.disableStructured !== true }),
  });
  const webmcp = createWebMcpAdapter({
    origin,
    capabilities: [readCapability()],
    handlers: { 'records.lookup': ({ args }) => ({ id: args.id }) },
    availability: ({ request }) => ({ available: request?.disableWebMcp !== true }),
  });
  const dom = createDomAccessibilityAdapter({
    origin,
    accessibilityTree: { role: 'region', name: 'Records' },
    capabilities: [readCapability({ semanticTarget: { role: 'region', name: 'Records' } })],
    handlers: { 'records.lookup': ({ args }) => ({ id: args.id }) },
  });
  const registry = createAdapterRegistry({ adapters: [structured, webmcp, dom] });
  assert.equal(registry.select({ origin, capability: 'records.lookup', request: { id: 'a' } }).selectedAdapterId, 'structured.api');
  assert.equal(registry.select({ origin, capability: 'records.lookup', request: { disableStructured: true } }).selectedAdapterId, 'webmcp');
  assert.equal(registry.select({ origin, capability: 'records.lookup', request: { disableStructured: true, disableWebMcp: true } }).selectedAdapterId, 'dom.accessibility');
});

test('vision fallback is fail-closed until policy and evidence are explicit', () => {
  const { registry } = createAdapterFixtures({ origin });
  const evidence = { type: 'screenshot', digest: '0123456789abcdef0123456789abcdef' };
  const denied = registry.select({ origin, capability: 'visual.confirm', request: { evidence } });
  assert.equal(denied.ok, false);
  assert.equal(denied.error.code, 'ADAPTER_NOT_AVAILABLE');
  const callerOptIn = registry.select({
    origin,
    capability: 'visual.confirm',
    request: { evidence, allowVisionFallback: true },
  });
  assert.equal(callerOptIn.ok, false);
  assert.equal(callerOptIn.error.code, 'ADAPTER_NOT_AVAILABLE');
  const selected = registry.select({ origin, capability: 'visual.confirm', request: { evidence }, policy: { allowVisionFallback: true } });
  assert.equal(selected.ok, true);
  assert.equal(selected.selectedAdapterId, 'vision.fallback');
  const result = registry.execute({ selection: selected, origin, capability: 'visual.confirm', args: {}, context: { evidence } });
  assert.equal(result.ok, true);
  assert.deepEqual(result.output, { confirmed: true });
  const noEvidence = registry.execute({ selection: selected, origin, capability: 'visual.confirm', args: {}, context: {} });
  assert.equal(noEvidence.ok, false);
  assert.equal(noEvidence.error.code, 'VISION_EVIDENCE_REQUIRED');
});

test('forged selection cannot downgrade execution to a weaker adapter', () => {
  let structuredCalls = 0;
  let weakCalls = 0;
  const structured = createStructuredAdapter({
    origin,
    capabilities: [readCapability()],
    handlers: { 'records.lookup': () => { structuredCalls += 1; return { id: 'structured' }; } },
  });
  const webmcp = createWebMcpAdapter({
    origin,
    capabilities: [readCapability()],
    handlers: { 'records.lookup': () => { weakCalls += 1; return { id: 'webmcp' }; } },
  });
  const registry = createAdapterRegistry({ adapters: [structured, webmcp] });
  const selection = registry.select({ origin, capability: 'records.lookup', request: {} });
  assert.equal(selection.ok, true);
  assert.equal(selection.selectedAdapterId, structured.id);

  const forged = {
    ...selection,
    selectedAdapterId: webmcp.id,
    selected: { ...selection.selected, adapterId: webmcp.id, kind: webmcp.kind },
  };
  const result = registry.execute({
    selection: forged,
    origin,
    capability: 'records.lookup',
    args: {},
  });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'ADAPTER_SELECTION_REQUIRED');
  assert.equal(structuredCalls, 0);
  assert.equal(weakCalls, 0);
});

test('origin and schema mismatches fail closed', () => {
  const { registry, structured } = createAdapterFixtures({ origin });
  const wrongOrigin = registry.select({ origin: 'https://other.example.test', capability: 'orders.lookup' });
  assert.equal(wrongOrigin.ok, false);
  assert.equal(wrongOrigin.error.code, 'ADAPTER_NOT_AVAILABLE');
  const badArgs = structured.execute({ origin, capability: 'orders.lookup', args: { orderId: 42 } });
  assert.equal(badArgs.ok, false);
  assert.equal(badArgs.error.code, 'ADAPTER_ARGUMENT_SCHEMA_INVALID');
  const badCapability = structured.execute({ origin: 'https://other.example.test', capability: 'orders.lookup', args: { orderId: 'o1' } });
  assert.equal(badCapability.ok, false);
  assert.equal(badCapability.error.code, 'ADAPTER_ORIGIN_MISMATCH');
});

test('rejects unsafe nested-quantifier patterns before any adapter execution', () => {
  const hostilePatterns = [
    '^(a+)+$',
    '^(a*)*$',
    '^(?:a+)+$',
    '^(a*)a(a*)a(a*)$',
    '(a|aa)+',
  ];
  for (const pattern of hostilePatterns) {
    assert.equal(isSafeRegexPattern({ pattern }), false, `pattern unexpectedly accepted: ${pattern}`);
    // This deliberately uses the Daybreak payload length but makes no wall
    // clock assertion: definition validation must reject it before matching.
    const boundedResult = validateSchema({ value: 'a'.repeat(896), schema: { type: 'string', pattern } });
    assert.equal(boundedResult.valid, false);
    const calls = [];
    const inputSchema = {
      type: 'object',
      additionalProperties: false,
      required: ['value'],
      properties: { value: { type: 'string', pattern } },
    };
    const definition = validateSchemaDefinition({ schema: inputSchema });
    assert.equal(definition.valid, false);
    assert.ok(definition.errors.some((error) => error.keyword === 'pattern'));
    assert.throws(
      () => createStructuredAdapter({
        origin,
        capabilities: [{ name: 'records.lookup', readOnly: true, inputSchema, outputSchema }],
        handlers: { 'records.lookup': () => calls.push('executed') },
      }),
      (error) => error instanceof AdapterContractError
        && error.code === 'ADAPTER_SCHEMA_INVALID'
        && error.details.input.some((entry) => entry.keyword === 'pattern'),
    );
    assert.deepEqual(calls, []);
  }
});

test('hard adapter schema and string bounds fail closed', () => {
  assert.equal(isSafeRegexPattern({ pattern: '^[a-z]{1,64}$' }), true);
  assert.equal(isSafeRegexPattern({ pattern: '^a+$' }), false);
  const oversizedPattern = 'a'.repeat(ADAPTER_SCHEMA_LIMITS.maxPatternLength + 1);
  const patternDefinition = validateSchemaDefinition({ schema: { type: 'string', pattern: oversizedPattern } });
  assert.equal(patternDefinition.valid, false);
  assert.ok(patternDefinition.errors.some((error) => error.keyword === 'pattern'));

  const oversized = 'a'.repeat(ADAPTER_SCHEMA_LIMITS.maxStringLength + 1);
  const valueResult = validateSchema({ value: oversized, schema: { type: 'string' } });
  assert.equal(valueResult.valid, false);
  assert.ok(valueResult.errors.some((error) => error.keyword === 'json'));
});

test('value-wide bounds reject oversized provider output before schema cloning', () => {
  const oversizedItems = new Array(200_000).fill(null);
  const bounded = validateJsonValueBounds({ value: { items: oversizedItems } });
  assert.equal(bounded.valid, false);
  assert.equal(bounded.reason, 'maximum array length exceeded');

  let invocations = 0;
  const adapter = createStructuredAdapter({
    origin,
    capabilities: [{
      name: 'records.lookup',
      readOnly: true,
      inputSchema: { type: 'object' },
      // additionalProperties is intentionally permissive: value-wide bounds
      // must still reject the provider output.
      outputSchema: { type: 'object' },
    }],
    handlers: {
      'records.lookup': () => {
        invocations += 1;
        return { items: oversizedItems };
      },
    },
  });
  const result = adapter.execute({ origin, capability: 'records.lookup', args: {} });
  assert.equal(invocations, 1);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'ADAPTER_OUTPUT_INVALID');

  let inputInvocations = 0;
  const inputAdapter = createStructuredAdapter({
    origin,
    capabilities: [{
      name: 'records.lookup',
      readOnly: true,
      inputSchema: { type: 'object' },
      outputSchema: { type: 'object' },
    }],
    handlers: {
      'records.lookup': () => {
        inputInvocations += 1;
        return {};
      },
    },
  });
  const inputResult = inputAdapter.execute({
    origin,
    capability: 'records.lookup',
    args: { items: oversizedItems },
  });
  assert.equal(inputInvocations, 0);
  assert.equal(inputResult.ok, false);
  assert.equal(inputResult.error.code, 'ADAPTER_ARGUMENT_SCHEMA_INVALID');
});

test('mutating capabilities require trusted approval and cannot replay', () => {
  const { structured } = createAdapterFixtures({ origin });
  const args = { sku: 'sku-1', quantity: 2 };
  const denied = structured.execute({ origin, capability: 'cart.add', args });
  assert.equal(denied.ok, false);
  assert.equal(denied.error.code, 'ADAPTER_APPROVAL_REQUIRED');
  const approval = { trusted: true, origin, adapterId: 'structured.api', capability: 'cart.add' };
  const success = structured.execute({ origin, capability: 'cart.add', args, context: { approvalRecord: approval } });
  assert.equal(success.ok, true);
  assert.deepEqual(success.output, args);
  const replay = structured.execute({ origin, capability: 'cart.add', args, context: { approvalRecord: approval, replay: true } });
  assert.equal(replay.ok, false);
  assert.equal(replay.error.code, 'ADAPTER_MUTATION_REPLAY_FORBIDDEN');
});

test('DOM targets remain semantic and vision targets require grounding metadata', () => {
  assert.throws(() => createDomAccessibilityAdapter({ origin, capabilities: [readCapability()] }), (error) => error.code === 'DOM_TARGET_REQUIRED');
  assert.throws(() => createDomAccessibilityAdapter({ origin, capabilities: [readCapability({ semanticTarget: { role: 'button', selector: '#save' } })] }), (error) => error.code === 'ADAPTER_RAW_OPERATION_FORBIDDEN');
  assert.throws(() => createVisionFallbackAdapter({ origin, capabilities: [readCapability()] }), (error) => error.code === 'VISION_TARGET_REQUIRED');
});

test('registry rejects duplicate ids and unknown/raw capability contracts', () => {
  const { registry, structured } = createAdapterFixtures({ origin });
  const duplicate = registry.register({ adapter: structured });
  assert.equal(duplicate.ok, false);
  assert.equal(duplicate.error.code, 'ADAPTER_DUPLICATE');
  assert.throws(() => createStructuredAdapter({ origin, capabilities: [readCapability({ name: 'browser.navigate' })], handlers: { 'browser.navigate': () => ({ id: 'x' }) } }), (error) => error.code === 'ADAPTER_RAW_OPERATION_FORBIDDEN');
  const unknown = registry.select({ origin, capability: 'records.missing' });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.error.code, 'ADAPTER_NOT_AVAILABLE');
  assert.ok(unknown.rejections.every((entry) => typeof entry.reason === 'string'));
});

test('registry rejects command-like capability names', () => {
  for (const name of ['command.run', 'code.execute', 'process.spawn', 'subprocess.run', 'powershell.invoke', 'terminal.open', 'system.exec', 'cmd.run']) {
    assert.throws(
      () => createStructuredAdapter({ origin, capabilities: [readCapability({ name })], handlers: { [name]: () => ({ id: 'x' }) } }),
      (error) => error instanceof AdapterContractError && error.code === 'ADAPTER_RAW_OPERATION_FORBIDDEN',
      `unexpectedly accepted capability ${name}`,
    );
  }
});
