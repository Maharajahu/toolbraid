import {
  RECOVERY_PROVIDER_DESCRIPTORS,
  createRecoveryProviderCatalog,
} from '../../src/providers/recovery/catalog.js';

const ORCHESTRATOR_PORT = '4173';
const PRODUCTION_ORCHESTRATOR_ORIGIN = 'https://app.toolbraid.dev';
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
const LOCAL_PROVIDER_PORTS = Object.freeze(Object.fromEntries(
  RECOVERY_PROVIDER_DESCRIPTORS.map(({ id }, index) => [id, String(4174 + index)]),
));
const PRODUCTION_ORCHESTRATORS = Object.freeze(Object.fromEntries(
  RECOVERY_PROVIDER_DESCRIPTORS.map(({ origin }) => [origin, PRODUCTION_ORCHESTRATOR_ORIGIN]),
));

function invalidOrigin(message = 'The provider can expose tools only to its assigned ToolBraid orchestrator.') {
  const error = new Error(message);
  error.name = 'ProviderOriginError';
  error.code = 'ORCHESTRATOR_ORIGIN_DENIED';
  return error;
}

function parseAbsoluteUrl(value, label) {
  try {
    return new URL(value);
  } catch {
    throw invalidOrigin(`${label} must be an absolute URL for the assigned ToolBraid orchestrator.`);
  }
}

function expectedOrchestratorOrigin(provider, providerLocation) {
  const productionOrchestrator = PRODUCTION_ORCHESTRATORS[providerLocation.origin];
  if (provider.origin === providerLocation.origin && productionOrchestrator) {
    return productionOrchestrator;
  }

  const providerHost = providerLocation.hostname.toLowerCase();
  const expectedLocalPort = LOCAL_PROVIDER_PORTS[provider.id];
  if (providerLocation.protocol !== 'http:'
      || !LOOPBACK_HOSTS.has(providerHost)
      || providerLocation.port !== expectedLocalPort) {
    throw invalidOrigin('This provider document is not running on its assigned production origin or local development port.');
  }

  const orchestrator = new URL(providerLocation.origin);
  orchestrator.port = ORCHESTRATOR_PORT;
  return orchestrator.origin;
}

export function validateOrchestratorOrigin(provider, value, { locationHref } = {}) {
  if (!provider || typeof provider.id !== 'string' || typeof provider.origin !== 'string') {
    throw new TypeError('A recovery provider descriptor is required.');
  }
  const providerLocation = parseAbsoluteUrl(locationHref ?? globalThis.location?.href, 'Provider location');
  const candidate = parseAbsoluteUrl(value, 'Orchestrator origin');
  const expectedOrigin = expectedOrchestratorOrigin(provider, providerLocation);
  if (candidate.origin !== expectedOrigin) throw invalidOrigin();
  return candidate.origin;
}

export function resolveOrchestratorOrigin(provider, {
  locationHref = globalThis.location?.href,
  referrer = globalThis.document?.referrer ?? '',
} = {}) {
  const providerLocation = parseAbsoluteUrl(locationHref, 'Provider location');
  // Validate the provider document itself before trusting query or referrer data.
  const fallbackOrigin = expectedOrchestratorOrigin(provider, providerLocation);
  const requested = providerLocation.searchParams.get('orchestrator');
  if (requested) {
    return validateOrchestratorOrigin(provider, requested, { locationHref: providerLocation.href });
  }

  if (referrer) {
    return validateOrchestratorOrigin(provider, referrer, { locationHref: providerLocation.href });
  }

  return fallbackOrigin;
}

function messageTargets() {
  const targets = [];
  if (window.parent && window.parent !== window) targets.push(window.parent);
  if (window.opener && !window.opener.closed) targets.push(window.opener);
  return targets;
}

function announce(message, orchestratorOrigin) {
  for (const target of messageTargets()) target.postMessage(message, orchestratorOrigin);
}

function renderState(state, message) {
  document.body.dataset.state = state;
  const output = document.querySelector('[data-provider-state]');
  if (output) output.textContent = message;
}

export function createProviderRuntime(providerId) {
  const catalog = createRecoveryProviderCatalog();
  const provider = catalog.providers.find((candidate) => candidate.id === providerId);
  if (!provider) throw new Error(`Unknown recovery provider: ${providerId}`);

  const orchestratorOrigin = resolveOrchestratorOrigin(provider);
  const lifecycle = new AbortController();
  const signal = lifecycle.signal;
  window.addEventListener('pagehide', () => lifecycle.abort('Provider document unloaded.'), { once: true });

  return Object.freeze({
    provider,
    orchestratorOrigin,
    signal,
    ready() {
      const toolNames = provider.tools.map(({ name }) => name);
      renderState('ready', `${toolNames.length} native tool${toolNames.length === 1 ? '' : 's'} registered`);
      announce({
        source: 'toolbraid-provider',
        type: 'toolbraid:provider-ready',
        version: 1,
        providerId,
        origin: location.origin,
        toolNames,
      }, orchestratorOrigin);
    },
    fail(error) {
      const detail = {
        name: typeof error?.name === 'string' ? error.name : 'Error',
        code: typeof error?.code === 'string' ? error.code : 'PROVIDER_REGISTRATION_FAILED',
        message: typeof error?.message === 'string' ? error.message : 'Provider registration failed.',
      };
      renderState('error', detail.message);
      announce({
        source: 'toolbraid-provider',
        type: 'toolbraid:provider-error',
        version: 1,
        providerId,
        origin: location.origin,
        error: detail,
      }, orchestratorOrigin);
      console.error(`[ToolBraid:${providerId}]`, detail);
    },
  });
}
