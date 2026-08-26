export {
  ADAPTER_KINDS,
  ADAPTER_PRIORITY,
  DEFAULT_ADAPTER_METADATA,
  AdapterContractError,
  assertRecord,
  cloneJson,
  createAdapterError,
  errorResult,
  isJsonSafe,
  isPlainObject,
  makeMetadata,
  normalizeConfidence,
  normalizeOrigin,
  normalizeOrigins,
  normalizeRisk,
  originsEqual,
  validateCapabilityName,
  validateSchema,
  validateSchemaDefinition,
} from './contracts.js';
export { createAdapter } from './base.js';
export { createStructuredAdapter } from './structured.js';
export { createWebMcpAdapter } from './webmcp.js';
export { createDomAccessibilityAdapter, createDomAdapter } from './dom.js';
export { createVisionFallbackAdapter, createVisionAdapter } from './vision.js';
export { createAdapterRegistry, selectAdapter } from './registry.js';
export { FIXTURE_ORIGIN, createAdapterFixtures, createFixtureAdapters } from './fixtures.js';

