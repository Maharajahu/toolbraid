import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveOrchestratorOrigin } from '../../providers/recovery/runtime.js';
import { RECOVERY_PROVIDER_DESCRIPTORS } from '../../src/providers/recovery/catalog.js';

const PRODUCTION_ORCHESTRATOR = 'https://app.toolbraid.dev';

function assertDenied(callback) {
  assert.throws(callback, (error) => (
    error?.name === 'ProviderOriginError'
      && error?.code === 'ORCHESTRATOR_ORIGIN_DENIED'
  ));
}

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
