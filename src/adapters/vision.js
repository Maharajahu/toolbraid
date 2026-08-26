import { createAdapter } from './base.js';
import {
  ADAPTER_KINDS,
  AdapterContractError,
  assertRecord,
  createAdapterError,
  errorResult,
  isJsonSafe,
  isPlainObject,
} from './contracts.js';

function hasVisionEvidence({ request }) {
  const evidence = request?.evidence ?? request?.visionEvidence;
  if (!isPlainObject({ value: evidence })) return false;
  if (evidence.type !== 'screenshot' && evidence.type !== 'image') return false;
  if (typeof evidence.digest !== 'string' || evidence.digest.length < 16 || evidence.digest.length > 256) return false;
  return isJsonSafe({ value: evidence });
}

/**
 * Create the explicit, high-risk vision fallback adapter.  A screenshot
 * digest is required as evidence so a caller cannot silently route an action
 * through an ungrounded visual guess.
 */
export function createVisionFallbackAdapter(spec = {}) {
  const input = assertRecord({ value: spec, name: 'vision adapter specification' });
  const rawCapabilities = input.capabilities ?? input.operations;
  if (!Array.isArray(rawCapabilities) || rawCapabilities.length === 0) {
    throw new AdapterContractError({ code: 'ADAPTER_CAPABILITIES_REQUIRED', message: 'Vision adapter requires semantic capabilities.' });
  }
  const capabilities = rawCapabilities.map((descriptor) => {
    if (!isPlainObject({ value: descriptor })) throw new AdapterContractError({ code: 'ADAPTER_CAPABILITY_INVALID', message: 'Vision capability must be a plain object.' });
    if (descriptor.semanticTarget === undefined && descriptor.target === undefined) {
      throw new AdapterContractError({ code: 'VISION_TARGET_REQUIRED', message: `Vision capability ${descriptor.name ?? descriptor.id} must declare a semantic target.` });
    }
    return { ...descriptor, semanticTarget: descriptor.semanticTarget ?? descriptor.target };
  });
  const userAvailability = input.availability;
  const adapter = createAdapter({
    ...input,
    id: input.id ?? 'vision.fallback',
    kind: ADAPTER_KINDS.VISION,
    source: input.source ?? 'vision-evidence',
    confidence: input.confidence ?? 0.55,
    riskScore: input.riskScore ?? 0.8,
    capabilities,
    availability: ({ capability, request, ...rest }) => {
      const grounded = hasVisionEvidence({ request });
      let custom = { available: grounded, reason: grounded ? undefined : 'A screenshot evidence digest is required for vision fallback.' };
      if (userAvailability) {
        const user = userAvailability({ capability, request, ...rest });
        if (user && typeof user.then === 'function') return { available: false, reason: 'Asynchronous availability checks are not permitted during routing.' };
        if (typeof user === 'boolean') custom = { ...custom, available: custom.available && user };
        else if (isPlainObject({ value: user })) custom = { ...custom, ...user, available: custom.available && user.available !== false };
      }
      return custom;
    },
  });
  const execute = adapter.execute;
  return Object.freeze({
    ...adapter,
    execute: (execution = {}) => {
      const inputRequest = isPlainObject({ value: execution }) ? execution : {};
      if (!hasVisionEvidence({ request: inputRequest.context ?? inputRequest })) {
        return errorResult({ error: createAdapterError({ code: 'VISION_EVIDENCE_REQUIRED', message: 'A screenshot evidence digest is required for vision fallback.' }) });
      }
      return execute(execution);
    },
  });
}

export const createVisionAdapter = createVisionFallbackAdapter;
export const VisionFallbackAdapter = createVisionFallbackAdapter;
export const createVisionFallback = createVisionFallbackAdapter;
