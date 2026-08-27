import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ICON_NAMES,
  iconMarkup,
  iconNameForNode,
} from '../../src/app/icons.js';

test('provides a compact first-party semantic icon set', () => {
  assert.ok(ICON_NAMES.length >= 16);
  assert.ok(ICON_NAMES.includes('braid'));
  assert.ok(ICON_NAMES.includes('quarantine'));
  assert.ok(ICON_NAMES.includes('rollback'));
});

test('maps provider and canonical node identities to specific icons', () => {
  assert.equal(iconNameForNode({ origin: 'https://pulse.toolbraid.dev', type: 'provider' }), 'radar');
  assert.equal(iconNameForNode({ origin: 'https://source.toolbraid.dev', type: 'provider' }), 'branch');
  assert.equal(iconNameForNode({ semanticId: 'recovery.option.apply', type: 'mutation' }), 'rollback');
  assert.equal(iconNameForNode({ semanticId: 'unsafe.override', type: 'capability' }), 'quarantine');
  assert.equal(iconNameForNode({ semanticId: 'unknown', type: 'provider' }), 'provider');
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
