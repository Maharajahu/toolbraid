import { createAdapter } from './base.js';
import { ADAPTER_KINDS, AdapterContractError, assertRecord, isPlainObject } from './contracts.js';

/**
 * Create a structured/API adapter.  The API implementation is supplied as
 * semantic capability handlers; no transport client or credential handling is
 * hidden in this contract.
 */
export function createStructuredAdapter(spec = {}) {
  const input = assertRecord({ value: spec, name: 'structured adapter specification' });
  if (input.manifest !== undefined && !isPlainObject({ value: input.manifest })) {
    throw new AdapterContractError({ code: 'ADAPTER_MANIFEST_INVALID', message: 'Structured adapter manifest must be a plain object.' });
  }
  const capabilities = input.capabilities ?? input.operations ?? input.manifest?.capabilities;
  return createAdapter({
    ...input,
    id: input.id ?? 'structured.api',
    kind: ADAPTER_KINDS.STRUCTURED_API,
    source: input.source ?? 'structured-api',
    capabilities,
  });
}

export const StructuredApiAdapter = createStructuredAdapter;
export const createStructuredApiAdapter = createStructuredAdapter;
