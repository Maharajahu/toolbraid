export {
  ADAPTER_KINDS,
  ADAPTER_PRIORITY,
  ADAPTER_ERROR_LIMITS,
  ADAPTER_SCHEMA_LIMITS,
  ADAPTER_VALUE_LIMITS,
  DEFAULT_ADAPTER_METADATA,
  AdapterContractError,
  assertRecord,
  cloneJson,
  createAdapterError,
  errorResult,
  isJsonSafe,
  normalizeAdapterError,
  isSafeRegexPattern,
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
  validateJsonValueBounds,
} from './contracts.js';
export { ADAPTER_DATA_LIMITS, assertAdapterDataBounds, createAdapter } from './base.js';
export { createStructuredAdapter, createStructuredApiAdapter, StructuredApiAdapter } from './structured.js';
export { createWebMcpAdapter, createWebMCPAdapter, WebMcpAdapter, WebMCPAdapter } from './webmcp.js';
export { createDomAccessibilityAdapter, createDomAdapter, createDomA11yAdapter, createDOMAccessibilityAdapter, DomAccessibilityAdapter } from './dom.js';
export { createVisionFallbackAdapter, createVisionAdapter, createVisionFallback, VisionFallbackAdapter } from './vision.js';
export { createAdapterRegistry, selectAdapter } from './registry.js';
export { FIXTURE_ORIGIN, createAdapterFixtures, createFixtureAdapters } from './fixtures.js';
