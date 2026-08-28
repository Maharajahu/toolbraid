import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveOrchestratorOrigin } from '../../providers/recovery/runtime.js';
import {
  RECOVERY_DEPLOYMENT_PROFILES,
  RECOVERY_ORCHESTRATOR_ORIGIN,
  RECOVERY_PROVIDER_DESCRIPTORS,
  RECOVERY_PROVIDER_ORIGINS,
  resolveRecoveryDeploymentProfile,
} from '../../src/providers/recovery/catalog.js';

const CANONICAL_PROFILE = RECOVERY_DEPLOYMENT_PROFILES.canonical;
const VERCEL_STABLE_PROFILE = RECOVERY_DEPLOYMENT_PROFILES.vercelStable;
const PRODUCTION_ORCHESTRATOR = CANONICAL_PROFILE.orchestratorOrigin;

function assertDenied(callback) {
  assert.throws(callback, (error) => (
    error?.name === 'ProviderOriginError'
      && error?.code === 'ORCHESTRATOR_ORIGIN_DENIED'
  ));
}

test('Node and custom-domain runtimes default to the canonical deployment profile', () => {
  assert.equal(RECOVERY_ORCHESTRATOR_ORIGIN, PRODUCTION_ORCHESTRATOR);
  assert.equal(RECOVERY_PROVIDER_ORIGINS, CANONICAL_PROFILE.providerOrigins);
  assert.equal(resolveRecoveryDeploymentProfile(), CANONICAL_PROFILE);
  assert.equal(resolveRecoveryDeploymentProfile('https://app.toolbraid.dev/mission'), CANONICAL_PROFILE);
  assert.equal(resolveRecoveryDeploymentProfile('https://signals.toolbraid.dev/provider'), CANONICAL_PROFILE);
  assert.equal(resolveRecoveryDeploymentProfile('https://toolbraid-preview.vercel.app'), CANONICAL_PROFILE);
});

test('catalog evaluation selects the multi-project profile on every stable Vercel alias', async () => {
  const previousLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');
  const stableOrigins = [
    VERCEL_STABLE_PROFILE.orchestratorOrigin,
    ...Object.values(VERCEL_STABLE_PROFILE.providerOrigins),
  ];

  try {
    for (const [index, stableOrigin] of stableOrigins.entries()) {
      Object.defineProperty(globalThis, 'location', {
        configurable: true,
        value: new URL(`${stableOrigin}/runtime`),
      });
      const catalogModule = await import(`../../src/providers/recovery/catalog.js?stable-profile=${index}-${Date.now()}`);
      assert.equal(catalogModule.RECOVERY_ORCHESTRATOR_ORIGIN, VERCEL_STABLE_PROFILE.orchestratorOrigin);
      assert.deepEqual(catalogModule.RECOVERY_PROVIDER_ORIGINS, VERCEL_STABLE_PROFILE.providerOrigins);
      assert.deepEqual(
        catalogModule.RECOVERY_PROVIDER_DESCRIPTORS.map(({ id, origin }) => [id, origin]),
        Object.entries(VERCEL_STABLE_PROFILE.providerOrigins),
      );
      assert.deepEqual(
        catalogModule.createRecoveryProviderCatalog().providers.map(({ id, origin }) => [id, origin]),
        Object.entries(VERCEL_STABLE_PROFILE.providerOrigins),
      );
    }
  } finally {
    if (previousLocation) Object.defineProperty(globalThis, 'location', previousLocation);
    else delete globalThis.location;
  }
});

test('every production provider maps only to the exact production orchestrator origin', () => {
  for (const provider of RECOVERY_PROVIDER_DESCRIPTORS) {
    const requestedLocation = `${provider.origin}/?orchestrator=${encodeURIComponent(PRODUCTION_ORCHESTRATOR)}`;
    assert.equal(resolveOrchestratorOrigin(provider, {
      locationHref: requestedLocation,
      referrer: '',
    }), PRODUCTION_ORCHESTRATOR);

    assert.equal(resolveOrchestratorOrigin(provider, {
      locationHref: `${provider.origin}/provider.html`,
      referrer: `${PRODUCTION_ORCHESTRATOR}/missions/recovery`,
    }), PRODUCTION_ORCHESTRATOR);

    assert.equal(resolveOrchestratorOrigin(provider, {
      locationHref: `${provider.origin}/provider.html`,
      referrer: '',
    }), PRODUCTION_ORCHESTRATOR);
  }
});

test('every stable Vercel provider maps only to the stable Vercel orchestrator alias', () => {
  for (const canonicalProvider of RECOVERY_PROVIDER_DESCRIPTORS) {
    const provider = {
      ...canonicalProvider,
      origin: VERCEL_STABLE_PROFILE.providerOrigins[canonicalProvider.id],
    };
    const requestedLocation = `${provider.origin}/?orchestrator=${encodeURIComponent(VERCEL_STABLE_PROFILE.orchestratorOrigin)}`;
    assert.equal(resolveOrchestratorOrigin(provider, {
      locationHref: requestedLocation,
      referrer: '',
    }), VERCEL_STABLE_PROFILE.orchestratorOrigin);

    assert.equal(resolveOrchestratorOrigin(provider, {
      locationHref: `${provider.origin}/provider.html`,
      referrer: `${VERCEL_STABLE_PROFILE.orchestratorOrigin}/missions/recovery`,
    }), VERCEL_STABLE_PROFILE.orchestratorOrigin);

    assert.equal(resolveOrchestratorOrigin(provider, {
      locationHref: `${provider.origin}/provider.html`,
      referrer: '',
    }), VERCEL_STABLE_PROFILE.orchestratorOrigin);
  }
});

test('production rejects mismatched provider documents, lookalike origins, and untrusted referrers', () => {
  const [signals, pulse] = RECOVERY_PROVIDER_DESCRIPTORS;

  assertDenied(() => resolveOrchestratorOrigin(signals, {
    locationHref: `${pulse.origin}/?orchestrator=${encodeURIComponent(PRODUCTION_ORCHESTRATOR)}`,
    referrer: '',
  }));
  assertDenied(() => resolveOrchestratorOrigin(signals, {
    locationHref: `${signals.origin}/?orchestrator=${encodeURIComponent('https://app.toolbraid.dev.evil.example')}`,
    referrer: '',
  }));
  assertDenied(() => resolveOrchestratorOrigin(signals, {
    locationHref: `${signals.origin}/provider.html`,
    referrer: 'https://attacker.example/launch',
  }));
  assertDenied(() => resolveOrchestratorOrigin(signals, {
    locationHref: `${signals.origin}/?orchestrator=${encodeURIComponent('http://app.toolbraid.dev')}`,
    referrer: '',
  }));
});

test('stable Vercel mode rejects cross-profile, preview, and lookalike origins', () => {
  const [canonicalSignals] = RECOVERY_PROVIDER_DESCRIPTORS;
  const signals = {
    ...canonicalSignals,
    origin: VERCEL_STABLE_PROFILE.providerOrigins.signals,
  };

  assertDenied(() => resolveOrchestratorOrigin(signals, {
    locationHref: `${signals.origin}/?orchestrator=${encodeURIComponent(PRODUCTION_ORCHESTRATOR)}`,
    referrer: '',
  }));
  assertDenied(() => resolveOrchestratorOrigin(canonicalSignals, {
    locationHref: `${signals.origin}/?orchestrator=${encodeURIComponent(VERCEL_STABLE_PROFILE.orchestratorOrigin)}`,
    referrer: '',
  }));
  assertDenied(() => resolveOrchestratorOrigin(signals, {
    locationHref: `${VERCEL_STABLE_PROFILE.providerOrigins.pulse}/?orchestrator=${encodeURIComponent(VERCEL_STABLE_PROFILE.orchestratorOrigin)}`,
    referrer: '',
  }));
  assertDenied(() => resolveOrchestratorOrigin(signals, {
    locationHref: `${signals.origin}.evil.example/?orchestrator=${encodeURIComponent(VERCEL_STABLE_PROFILE.orchestratorOrigin)}`,
    referrer: '',
  }));
  assertDenied(() => resolveOrchestratorOrigin(signals, {
    locationHref: 'https://toolbraid-signals-webmcp-git-preview-example-team.vercel.app/',
    referrer: VERCEL_STABLE_PROFILE.orchestratorOrigin,
  }));
  assertDenied(() => resolveOrchestratorOrigin(signals, {
    locationHref: signals.origin.replace('https:', 'http:'),
    referrer: VERCEL_STABLE_PROFILE.orchestratorOrigin,
  }));
});

test('every local provider port maps to the same-host port 4173 orchestrator', () => {
  for (const [index, provider] of RECOVERY_PROVIDER_DESCRIPTORS.entries()) {
    const providerOrigin = `http://127.0.0.1:${4174 + index}`;
    const localOrchestrator = 'http://127.0.0.1:4173';

    assert.equal(resolveOrchestratorOrigin(provider, {
      locationHref: `${providerOrigin}/?orchestrator=${encodeURIComponent(localOrchestrator)}`,
      referrer: '',
    }), localOrchestrator);

    assert.equal(resolveOrchestratorOrigin(provider, {
      locationHref: `${providerOrigin}/provider.html`,
      referrer: `${localOrchestrator}/mission`,
    }), localOrchestrator);

    assert.equal(resolveOrchestratorOrigin(provider, {
      locationHref: `${providerOrigin}/provider.html`,
      referrer: '',
    }), localOrchestrator);
  }
});

test('local mode rejects the wrong provider port, non-loopback hosts, and wrong orchestrators', () => {
  const [signals] = RECOVERY_PROVIDER_DESCRIPTORS;

  assertDenied(() => resolveOrchestratorOrigin(signals, {
    locationHref: 'http://127.0.0.1:4175/?orchestrator=http%3A%2F%2F127.0.0.1%3A4173',
    referrer: '',
  }));
  assertDenied(() => resolveOrchestratorOrigin(signals, {
    locationHref: 'http://providers.example:4174/?orchestrator=http%3A%2F%2Fproviders.example%3A4173',
    referrer: '',
  }));
  assertDenied(() => resolveOrchestratorOrigin(signals, {
    locationHref: 'http://127.0.0.1:4174/?orchestrator=http%3A%2F%2F127.0.0.1%3A4175',
    referrer: '',
  }));
  assertDenied(() => resolveOrchestratorOrigin(signals, {
    locationHref: 'http://127.0.0.1:4174/provider.html',
    referrer: 'http://localhost:4173/mission',
  }));
});
