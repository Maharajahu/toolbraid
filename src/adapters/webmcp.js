import { createAdapter } from './base.js';
import { ADAPTER_KINDS, AdapterContractError, assertRecord, isJsonSafe, isPlainObject, normalizeOrigin } from './contracts.js';

function validateManifest({ manifest, origins }) {
  if (!isPlainObject({ value: manifest })) {
    throw new AdapterContractError({ code: 'WEBMCP_MANIFEST_INVALID', message: 'WebMCP manifest must be a plain object.' });
  }
  if (manifest.origin !== undefined) {
    const manifestOrigin = normalizeOrigin({ origin: manifest.origin });
    if (origins?.length && !origins.includes(manifestOrigin)) {
      throw new AdapterContractError({ code: 'ADAPTER_ORIGIN_MISMATCH', message: 'WebMCP manifest origin does not match the adapter binding.' });
    }
  }
  if (manifest.version !== undefined && (typeof manifest.version !== 'string' || manifest.version.length > 40)) {
    throw new AdapterContractError({ code: 'WEBMCP_MANIFEST_INVALID', message: 'WebMCP manifest version must be a bounded string.' });
  }
  if (manifest.capabilities !== undefined && (!Array.isArray(manifest.capabilities) || manifest.capabilities.length === 0)) {
    throw new AdapterContractError({ code: 'WEBMCP_MANIFEST_INVALID', message: 'WebMCP manifest capabilities must be a non-empty array.' });
  }
  if (manifest.metadata !== undefined && !isJsonSafe({ value: manifest.metadata })) {
    throw new AdapterContractError({ code: 'WEBMCP_MANIFEST_INVALID', message: 'WebMCP manifest metadata must be JSON-safe.' });
  }
}

/**
 * Create a WebMCP adapter from a page-provided semantic manifest.  The
 * manifest is data only; handlers remain server-side functions supplied by the
 * integration and are never returned from `describe`.
 */
export function createWebMcpAdapter(spec = {}) {
  const input = assertRecord({ value: spec, name: 'WebMCP adapter specification' });
  const manifest = input.manifest ?? input.webmcpManifest;
  if (manifest !== undefined && !isPlainObject({ value: manifest })) {
    throw new AdapterContractError({ code: 'WEBMCP_MANIFEST_INVALID', message: 'WebMCP manifest must be a plain object.' });
  }
  const manifestOrigins = manifest?.origin === undefined ? undefined : [manifest.origin];
  const origins = input.origins ?? (input.origin === undefined ? manifestOrigins : undefined);
  if (input.metadata !== undefined && !isJsonSafe({ value: input.metadata })) {
    throw new AdapterContractError({ code: 'WEBMCP_METADATA_INVALID', message: 'WebMCP adapter metadata must be JSON-safe.' });
  }
  if (manifest !== undefined) {
    const normalizedOrigins = origins?.map((entry) => normalizeOrigin({ origin: entry }));
    validateManifest({ manifest, origins: normalizedOrigins });
    if (input.origin !== undefined && manifest.origin !== undefined && normalizeOrigin({ origin: input.origin }) !== normalizeOrigin({ origin: manifest.origin })) {
      throw new AdapterContractError({ code: 'ADAPTER_ORIGIN_MISMATCH', message: 'WebMCP manifest origin does not match the adapter binding.' });
    }
  }
  const capabilities = input.capabilities ?? input.operations ?? manifest?.capabilities;
  return createAdapter({
    ...input,
    id: input.id ?? 'webmcp',
    kind: ADAPTER_KINDS.WEBMCP,
    source: input.source ?? 'webmcp-manifest',
    version: input.version ?? manifest?.version,
    origins,
    capabilities,
    metadata: {
      ...(isPlainObject({ value: input.metadata }) ? input.metadata : {}),
      ...(manifest?.metadata === undefined ? {} : { manifest: manifest.metadata }),
    },
  });
}

export const WebMcpAdapter = createWebMcpAdapter;
export const WebMCPAdapter = createWebMcpAdapter;
export const createWebMCPAdapter = createWebMcpAdapter;
