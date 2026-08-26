import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ADAPTER_KINDS,
  ADAPTER_PRIORITY,
  AdapterContractError,
  createAdapterFixtures,
  createAdapterRegistry,
  createDomAccessibilityAdapter,
  createStructuredAdapter,
  createVisionFallbackAdapter,
  createWebMcpAdapter,
  isJsonSafe,
  normalizeOrigin,
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
