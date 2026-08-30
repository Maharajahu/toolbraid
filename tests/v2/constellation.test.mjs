import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CONSTELLATION_STATES,
  createConstellationLayout,
  createCurvedSvgPath,
  renderConstellationSvg,
} from '../../src/app/constellation.js';

function fixture() {
  return {
    providers: [
      { origin: 'https://deploy.example', label: 'Deploy Control' },
      { origin: 'https://health.example', label: 'Service Health' },
      { origin: 'https://status.example', label: 'Customer Status' },
    ],
    capabilities: [
      {
        id: 'status.notice.publish',
        label: 'Status notice',
        providerOrigin: 'https://status.example',
      },
      {
        id: 'service.health.read',
        label: 'Health read',
        providerOrigin: 'https://health.example',
        state: 'complete',
      },
      {
        id: 'recovery.option.prepare',
        label: 'Recovery option',
        providerOrigin: 'https://deploy.example',
        state: 'active',
      },
    ],
    mutations: [
      { id: 'status.notice.publish', label: 'Publish notice', state: 'locked' },
      { id: 'recovery.option.apply', label: 'Apply recovery', state: 'locked' },
    ],
  };
}

test('layout is deterministic regardless of provider, capability, and mutation input order', () => {
  const first = fixture();
  const reversed = {
    ...first,
    providers: [...first.providers].reverse(),
    capabilities: [...first.capabilities].reverse(),
    mutations: [...first.mutations].reverse(),
  };

  assert.deepEqual(createConstellationLayout(first), createConstellationLayout(reversed));
});

test('all node and edge ids are semantic and unique', () => {
  const layout = createConstellationLayout(fixture());
  const ids = [...layout.nodes, ...layout.edges].map((item) => item.id);

  assert.equal(new Set(ids).size, ids.length);
  assert.ok(layout.edges.every((edge) => edge.id.startsWith('edge--')));
  assert.ok(layout.nodes.every((node) => node.id.startsWith('node--')));
  assert.ok(layout.edges.some((edge) => edge.semanticId.includes('service.health.read')));
});

test('every coordinate and generated SVG path stays finite', () => {
  const layout = createConstellationLayout(fixture());

  for (const node of layout.nodes) {
    assert.equal(Number.isFinite(node.x), true);
    assert.equal(Number.isFinite(node.y), true);
  }
  for (const edge of layout.edges) {
    assert.doesNotMatch(edge.path, /NaN|Infinity/);
    assert.match(edge.path, /^M [-\d.]+ [-\d.]+ Q [-\d.]+ [-\d.]+ [-\d.]+ [-\d.]+$/);
  }
  assert.equal(createCurvedSvgPath({ x: 4, y: 4 }, { x: 4, y: 4 }), 'M 4 4 Q 4 4 4 4');
});

test('compact layout remains exactly centered and keeps approval gates separated', () => {
  const layout = createConstellationLayout({
    ...fixture(),
    width: 720,
    height: 700,
    centerX: 360,
    centerY: 300,
    outerRadius: 235,
    innerRadius: 132,
    mutationGap: 120,
    mutationWidth: 196,
  });

  assert.equal(layout.hub.x, layout.width / 2);
  assert.equal(layout.mutations[0].x + layout.mutations[1].x, layout.width);
  assert.ok(
    layout.mutations[0].x + layout.mutations[0].width / 2
      < layout.mutations[1].x - layout.mutations[1].width / 2,
  );
  assert.ok(layout.providers.some((provider) => provider.labelPlacement === 'above'));
  assert.ok(layout.providers.some((provider) => provider.labelPlacement === 'below'));
});

test('renderer escapes all user-controlled text and attributes', () => {
  const markup = renderConstellationSvg({
    providers: [{ origin: 'https://safe.example', label: '<script>alert("provider")</script>' }],
    capabilities: [{
      id: 'safe.read',
      label: '<img src=x onerror="boom">',
      providerOrigin: 'https://safe.example',
    }],
  }, {
    title: '<unsafe title>',
    description: 'A & B',
  });

  assert.doesNotMatch(markup, /<script>|<img/);
  assert.match(markup, /&lt;script&gt;alert\("provider"\)&lt;\/script&gt;/);
  assert.match(markup, /&lt;img src=x onerror="boom"&gt;/);
  assert.match(markup, /&lt;unsafe title&gt;/);
  assert.match(markup, /A &amp; B/);
});

test('renderer exposes two approval gates and pulse-addressable edges', () => {
  const markup = renderConstellationSvg(fixture());
  const edgeCount = createConstellationLayout(fixture()).edges.length;

  assert.equal((markup.match(/data-approval-required="true"/g) ?? []).length, 2);
  assert.equal((markup.match(/class="tb-approval-gate /g) ?? []).length, 2);
  assert.equal((markup.match(/class="tb-edge__pulse"/g) ?? []).length, edgeCount);
  assert.match(markup, /data-edge-id="edge--/);
  assert.match(markup, /data-from="/);
  assert.match(markup, /data-to="/);
});

test('renders first-party semantic SVG icons without external image dependencies', () => {
  const markup = renderConstellationSvg(fixture());

  assert.match(markup, /data-icon="activity"/);
  assert.match(markup, /data-icon="deployment"/);
  assert.match(markup, /data-icon="recovery"/);
  assert.match(markup, /data-icon="broadcast"/);
  assert.match(markup, /data-icon="toolbraid"/);
  assert.match(markup, /data-icon="shield"/);
  assert.equal((markup.match(/data-icon="approval-lock"/g) ?? []).length, 2);
  assert.doesNotMatch(markup, /<image|https?:\/\/[^" ]+\.(?:svg|png|webp)/);
});

test('each semantic edge exposes pulse routes and two independently triggerable packet trails', () => {
  const layout = createConstellationLayout(fixture());
  const markup = renderConstellationSvg(layout);

  assert.equal((markup.match(/data-pulse-route="/g) ?? []).length, layout.edges.length);
  assert.equal((markup.match(/data-packet-trail="lead"/g) ?? []).length, layout.edges.length);
  assert.equal((markup.match(/data-packet-trail="echo"/g) ?? []).length, layout.edges.length);
  assert.equal((markup.match(/data-motion="lead"/g) ?? []).length, layout.edges.length);
  assert.equal((markup.match(/data-motion="echo"/g) ?? []).length, layout.edges.length);
  assert.equal((markup.match(/begin="indefinite"/g) ?? []).length, layout.edges.length * 2);
});

test('all interaction states have stable class and data-state hooks', () => {
  const base = fixture();
  const providers = CONSTELLATION_STATES.map((state, index) => ({
    origin: `https://${state}-${index}.example`,
    label: state,
    state,
  }));
  const markup = renderConstellationSvg({ ...base, providers });

  for (const state of CONSTELLATION_STATES) {
    assert.match(markup, new RegExp(`is-${state}`));
    assert.match(markup, new RegExp(`data-state="${state}"`));
  }
});
