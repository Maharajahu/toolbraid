/**
 * Deterministic fixtures used by the local smoke test and by integration
 * consumers.  The fixture deliberately looks like a real adapter: it exposes
 * semantic capabilities and keeps its state behind the adapter boundary.
 * Nothing in this module is used as a trust boundary in production.
 */

export const FIXTURE_IDS = Object.freeze({
  tenantId: 'tenant-acme',
  subject: 'user-alice',
  subjectId: 'user-alice',
  origin: 'https://shop.example.test',
});

export const FIXTURE_CAPABILITIES = Object.freeze([
  Object.freeze({
    id: 'catalog.search',
    version: '1',
    name: 'Search product catalog',
    description: 'Find products by a stable text query.',
    kind: 'read',
    mode: 'read',
    risk: 'low',
    requiresApproval: false,
    origin: FIXTURE_IDS.origin,
    adapter: 'structured',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string' }, limit: { type: 'integer' } },
      required: ['query'],
      additionalProperties: false,
    },
  }),
  Object.freeze({
    id: 'cart.read',
    version: '1',
    name: 'Read shopping cart',
    description: 'Read the current cart contents.',
    kind: 'read',
    mode: 'read',
    risk: 'low',
    requiresApproval: false,
    origin: FIXTURE_IDS.origin,
    adapter: 'structured',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  }),
  Object.freeze({
    id: 'cart.add',
    version: '1',
    name: 'Add product to cart',
    description: 'Add one product to the shopping cart.',
    kind: 'mutation',
    mode: 'mutation',
    risk: 'high',
    requiresApproval: true,
    origin: FIXTURE_IDS.origin,
    adapter: 'structured',
    inputSchema: {
      type: 'object',
      properties: {
        productId: { type: 'string' },
        quantity: { type: 'integer', minimum: 1, maximum: 20 },
      },
      required: ['productId'],
      additionalProperties: false,
    },
  }),
]);

const FIXTURE_PRODUCTS = Object.freeze([
  Object.freeze({ id: 'sku-espresso', title: 'Espresso beans', price: 18 }),
  Object.freeze({ id: 'sku-tea', title: 'Green tea', price: 12 }),
  Object.freeze({ id: 'sku-mug', title: 'Ceramic mug', price: 9 }),
]);

/**
 * Build a fresh fixture adapter.  Every call returns independent state and a
 * stable result sequence, which makes replay and approval tests reproducible.
 */
export function createFixtureAdapter(options = {}) {
  const origin = String(options.origin || FIXTURE_IDS.origin);
  const products = (options.products || FIXTURE_PRODUCTS).map((product) => ({ ...product }));
  const cart = new Map();
  const calls = [];

  const metadata = FIXTURE_CAPABILITIES.map((capability) => ({
    ...capability,
    origin,
    inputSchema: clone(capability.inputSchema),
  }));

  const adapter = {
    id: 'fixture-structured',
    name: 'Deterministic structured fixture',
    type: 'structured',
    origin,
    capabilities: metadata,
    listCapabilities() {
      return metadata.map((capability) => clone(capability));
    },
    describeCapability(capabilityId) {
      const capability = metadata.find((entry) => entry.id === capabilityId);
      return capability ? clone(capability) : undefined;
    },
    async invoke(capabilityId, args = {}, context = {}) {
      const call = {
        capabilityId,
        args: clone(args),
        readOnly: capabilityId !== 'cart.add',
        workflowId: context.workflowId,
      };
      calls.push(call);

      if (capabilityId === 'catalog.search') {
        const query = String(args.query || '').trim().toLowerCase();
        const limit = clampInteger(args.limit, 10, 1, 20);
        const items = products
          .filter((product) => !query || `${product.id} ${product.title}`.toLowerCase().includes(query))
          .slice(0, limit)
          .map((product) => ({ ...product }));
        return { query, items, count: items.length };
      }

      if (capabilityId === 'cart.read') {
        return {
          items: [...cart.entries()].map(([productId, quantity]) => ({ productId, quantity })),
          count: [...cart.values()].reduce((sum, quantity) => sum + quantity, 0),
        };
      }

      if (capabilityId === 'cart.add') {
        const productId = String(args.productId || '');
        const quantity = clampInteger(args.quantity, 1, 1, 20);
        if (!products.some((product) => product.id === productId)) {
          const error = new Error(`Unknown fixture product: ${productId}`);
          error.code = 'CAPABILITY_ARGUMENT_INVALID';
          error.retryable = false;
          throw error;
        }
        const next = (cart.get(productId) || 0) + quantity;
        cart.set(productId, next);
        return { productId, quantity, totalQuantity: next };
      }

      const error = new Error(`Unknown fixture capability: ${capabilityId}`);
      error.code = 'CAPABILITY_NOT_FOUND';
      error.retryable = false;
      throw error;
    },
    // A few adapters in the project use execute() rather than invoke().  Keep
    // this alias semantic and intentionally do not expose click/shell methods.
    execute(capabilityId, args, context) {
      return adapter.invoke(capabilityId, args, context);
    },
    snapshot() {
      return {
        cart: [...cart.entries()].map(([productId, quantity]) => ({ productId, quantity })),
        calls: calls.map((call) => clone(call)),
      };
    },
    reset() {
      cart.clear();
      calls.length = 0;
    },
  };

  return adapter;
}

/**
 * Return the complete dependency bundle used by createCompositionRoot().
 * Keeping fixture creation in one function prevents tests from accidentally
 * sharing mutable adapter state.
 */
export function createFixtureDependencies(options = {}) {
  const adapter = options.adapter || createFixtureAdapter(options);
  return {
    adapter,
    adapters: [adapter],
    capabilities: adapter.listCapabilities(),
    identity: {
      tenantId: String(options.tenantId || FIXTURE_IDS.tenantId),
      subject: String(options.subject || FIXTURE_IDS.subject),
      subjectId: String(options.subjectId || options.subject || FIXTURE_IDS.subjectId),
      origin: String(options.origin || FIXTURE_IDS.origin),
    },
    now: options.now || (() => new Date('2026-01-01T00:00:00.000Z')),
    idFactory: options.idFactory || createDeterministicIdFactory(),
  };
}

export function createDeterministicIdFactory(prefix = 'fixture') {
  let sequence = 0;
  return (kind = 'id') => `${prefix}-${String(kind).replace(/[^a-z0-9_-]/gi, '-')}-${++sequence}`;
}

function clampInteger(value, fallback, minimum, maximum) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
}

function clone(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

export default createFixtureDependencies;
