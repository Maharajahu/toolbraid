import { createDomAccessibilityAdapter } from './dom.js';
import { createAdapterRegistry } from './registry.js';
import { createStructuredAdapter } from './structured.js';
import { createVisionFallbackAdapter } from './vision.js';
import { createWebMcpAdapter } from './webmcp.js';

export const FIXTURE_ORIGIN = 'https://shop.example.test';

const emptyArgs = { type: 'object', additionalProperties: false };
const lookupArgs = {
  type: 'object',
  additionalProperties: false,
  required: ['orderId'],
  properties: { orderId: { type: 'string', minLength: 1 } },
};
const lookupOutput = {
  type: 'object',
  additionalProperties: false,
  required: ['orderId', 'status'],
  properties: { orderId: { type: 'string' }, status: { type: 'string' } },
};
const cartArgs = {
  type: 'object',
  additionalProperties: false,
  required: ['sku'],
  properties: { sku: { type: 'string', minLength: 1 }, quantity: { type: 'integer', minimum: 1, maximum: 20 } },
};
const cartOutput = {
  type: 'object',
  additionalProperties: false,
  required: ['sku', 'quantity'],
  properties: { sku: { type: 'string' }, quantity: { type: 'integer' } },
};
const profileArgs = {
  type: 'object',
  additionalProperties: false,
  required: ['field', 'value'],
  properties: { field: { type: 'string' }, value: { type: 'string' } },
};
const profileOutput = {
  type: 'object',
  additionalProperties: false,
  required: ['updated'],
  properties: { updated: { type: 'boolean' } },
};

/**
 * Deterministic adapter fixtures used by unit and integration tests.  They
 * intentionally overlap on a few semantic capabilities so routing priority
 * can be exercised without network access.
 */
export function createAdapterFixtures({ origin = FIXTURE_ORIGIN } = {}) {
  const structured = createStructuredAdapter({
    origin,
    capabilities: [
      { name: 'orders.lookup', description: 'Read an order status.', readOnly: true, inputSchema: lookupArgs, outputSchema: lookupOutput },
      { name: 'cart.add', description: 'Add a product to the cart.', mutates: true, inputSchema: cartArgs, outputSchema: cartOutput },
    ],
    handlers: {
      'orders.lookup': ({ args }) => ({ orderId: args.orderId, status: 'paid' }),
      'cart.add': ({ args }) => ({ sku: args.sku, quantity: args.quantity ?? 1 }),
    },
  });

  const webmcp = createWebMcpAdapter({
    origin,
    manifest: { origin, version: '1', capabilities: [
      { name: 'orders.lookup', description: 'Read an order status from the page.', readOnly: true, inputSchema: lookupArgs, outputSchema: lookupOutput },
      { name: 'profile.update', description: 'Update the signed-in profile.', mutates: true, inputSchema: profileArgs, outputSchema: profileOutput, semanticTarget: { role: 'form', name: 'Profile' } },
    ] },
    handlers: {
      'orders.lookup': ({ args }) => ({ orderId: args.orderId, status: 'shipped' }),
      'profile.update': () => ({ updated: true }),
    },
  });

  const accessibilityTree = {
    role: 'document',
    children: [
      { role: 'region', name: 'Orders', id: 'orders-region' },
      { role: 'form', name: 'Profile', id: 'profile-form' },
    ],
  };
  const dom = createDomAccessibilityAdapter({
    origin,
    accessibilityTree,
    capabilities: [
      { name: 'orders.lookup', description: 'Read orders from the visible order region.', readOnly: true, semanticTarget: { role: 'region', name: 'Orders' }, inputSchema: lookupArgs, outputSchema: lookupOutput },
      { name: 'profile.update', description: 'Update the visible profile form.', mutates: true, semanticTarget: { role: 'form', name: 'Profile' }, inputSchema: profileArgs, outputSchema: profileOutput },
    ],
    handlers: {
      'orders.lookup': ({ args }) => ({ orderId: args.orderId, status: 'visible' }),
      'profile.update': () => ({ updated: true }),
    },
  });

  const vision = createVisionFallbackAdapter({
    origin,
    capabilities: [
      { name: 'profile.update', description: 'Update a profile by visual grounding.', mutates: true, semanticTarget: { description: 'Profile form save control' }, inputSchema: profileArgs, outputSchema: profileOutput },
      { name: 'visual.confirm', description: 'Read a visually displayed confirmation.', readOnly: true, semanticTarget: { description: 'Confirmation message' }, inputSchema: emptyArgs, outputSchema: { type: 'object', additionalProperties: false, required: ['confirmed'], properties: { confirmed: { type: 'boolean' } } } },
    ],
    handlers: {
      'profile.update': () => ({ updated: true }),
      'visual.confirm': () => ({ confirmed: true }),
    },
  });

  const registry = createAdapterRegistry({ adapters: [structured, webmcp, dom, vision] });
  return { origin, structured, webmcp, dom, vision, registry };
}

export const createFixtureAdapters = createAdapterFixtures;

