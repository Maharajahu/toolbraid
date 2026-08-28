import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ICON_NAMES,
  iconMarkup,
  iconNameForNode,
} from '../../src/app/icons.js';
import { createConstellationLayout } from '../../src/app/constellation.js';

test('provides a compact first-party semantic icon set', () => {
  assert.ok(ICON_NAMES.length >= 16);
  assert.ok(ICON_NAMES.includes('braid'));
  assert.ok(ICON_NAMES.includes('quarantine'));
  assert.ok(ICON_NAMES.includes('rollback'));
});

test('maps provider and canonical node identities to specific icons', () => {
  assert.equal(iconNameForNode({ origin: 'https://pulse.toolbraid.dev', type: 'provider' }), 'radar');
  assert.equal(iconNameForNode({ origin: 'https://source.toolbraid.dev', type: 'provider' }), 'branch');
  assert.equal(iconNameForNode({
    providerId: 'signals',
    origin: 'https://toolbraid-signals-webmcp.vercel.app',
    type: 'provider',
  }), 'waveform');
  assert.equal(iconNameForNode({
    providerId: 'status',
    origin: 'https://toolbraid-status-webmcp.vercel.app',
    type: 'provider',
  }), 'status-board');
  assert.equal(iconNameForNode({ semanticId: 'recovery.option.apply', type: 'mutation' }), 'rollback');
  assert.equal(iconNameForNode({ semanticId: 'unsafe.override', type: 'capability' }), 'quarantine');
  assert.equal(iconNameForNode({ semanticId: 'unknown', type: 'provider' }), 'provider');
});

test('preserves provider identity through the real layout path on stable Vercel origins', () => {
  const layout = createConstellationLayout({
    providers: [
      { id: 'signals', origin: 'https://toolbraid-signals-webmcp.vercel.app', label: 'Signals' },
      { id: 'pulse', origin: 'https://toolbraid-pulse-webmcp.vercel.app', label: 'Pulse' },
      { id: 'source', origin: 'https://toolbraid-source-webmcp.vercel.app', label: 'Source' },
      { id: 'deploy', origin: 'https://toolbraid-deploy-webmcp.vercel.app', label: 'Deploy' },
      { id: 'status', origin: 'https://toolbraid-status-webmcp.vercel.app', label: 'Status' },
      { id: 'mirage', origin: 'https://toolbraid-mirage-webmcp.vercel.app', label: 'Mirage' },
    ],
    capabilities: [],
  });
  const providerIcons = Object.fromEntries(
    layout.nodes
      .filter(({ type }) => type === 'provider')
      .map((node) => [node.providerId, iconNameForNode(node)]),
  );

  assert.deepEqual(providerIcons, {
    deploy: 'deployment',
    mirage: 'mirage',
    pulse: 'radar',
    signals: 'waveform',
    source: 'branch',
    status: 'status-board',
  });
});

test('renders accessible SVG without accepting class or label injection', () => {
  const markup = iconMarkup('shield', {
    className: 'node-icon premium',
    label: '"><script>alert(1)</script>',
  });
  assert.match(markup, /class="node-icon premium"/);
  assert.match(markup, /aria-label="&quot;&gt;&lt;script&gt;alert\(1\)&lt;\/script&gt;"/);
  assert.doesNotMatch(markup, /<script>/);

  const fallback = iconMarkup('not-real', { className: 'x" onload="bad' });
  assert.match(fallback, /class="ui-icon"/);
  assert.match(fallback, /aria-hidden="true"/);
});
