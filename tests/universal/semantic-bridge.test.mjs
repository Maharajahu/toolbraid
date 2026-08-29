import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ACTION_CLASSES,
  assertPreparedActionCurrent,
  classifyAction,
  classifyLink,
  createPageSnapshot,
  fingerprintPageSnapshot,
  generateWebMcpToolDescriptors,
  isActionCurrent,
  prepareAction,
} from '../../src/universal/index.js';

function snapshot(overrides = {}) {
  return createPageSnapshot({
    metadata: {
      url: 'https://shop.example.test/checkout',
      title: 'Checkout',
      language: 'en',
    },
    headings: [{ ref: 'heading-1', level: 1, text: 'Checkout' }],
    mainText: 'Review your order before placing it.',
    links: [{ ref: 'help-link', href: '/help', text: 'Read help' }],
    forms: [{
      ref: 'checkout-form',
      name: 'Place order',
      method: 'POST',
      fields: [
        { ref: 'email', name: 'email', type: 'email', required: true },
        { ref: 'quantity', name: 'quantity', type: 'number' },
        { ref: 'place', name: 'Place order', type: 'submit' },
      ],
    }],
    accessibleControls: [
      { ref: 'help-control', role: 'link', name: 'Read help' },
      { ref: 'place-control', role: 'button', name: 'Place order', type: 'submit' },
    ],
    elementRefs: [
      { ref: 'heading-1', tagName: 'h1', name: 'Checkout' },
      { ref: 'help-link', tagName: 'a', name: 'Read help' },
      { ref: 'checkout-form', tagName: 'form', name: 'Place order' },
      { ref: 'email', tagName: 'input', name: 'email', type: 'email' },
      { ref: 'quantity', tagName: 'input', name: 'quantity', type: 'number' },
      { ref: 'place', tagName: 'button', name: 'Place order', type: 'submit' },
      { ref: 'help-control', tagName: 'a', name: 'Read help' },
      { ref: 'place-control', tagName: 'button', name: 'Place order', type: 'submit' },
    ],
    ...overrides,
  });
}

test('PageSnapshot is serializable and fingerprints semantic page state deterministically', () => {
  const first = snapshot();
  const second = snapshot();

  assert.equal(typeof first.pageFingerprint, 'string');
  assert.match(first.pageFingerprint, /^[a-f0-9]{64}$/);
  assert.equal(first.pageFingerprint, second.pageFingerprint);
  assert.equal(first.pageFingerprint, fingerprintPageSnapshot(first));
  assert.deepEqual(JSON.parse(JSON.stringify(first)), first);
  assert.notEqual(first.pageFingerprint, snapshot({ mainText: 'A different order' }).pageFingerprint);
  assert.equal(first.metadata.origin, 'https://shop.example.test');
  assert.equal(first.forms[0].fields[0].formRef, 'checkout-form');
});

test('classification is deterministic, explicit, and fails closed', () => {
  assert.equal(classifyAction({ name: 'Search orders' }).classification, ACTION_CLASSES.READ);
  assert.equal(classifyAction({ name: 'Save draft' }).classification, ACTION_CLASSES.STAGE);
  assert.equal(classifyAction({ name: 'Publish update' }).classification, ACTION_CLASSES.MUTATE);
  assert.equal(classifyAction({ name: 'Unfamiliar button' }).classification, ACTION_CLASSES.MUTATE);
  assert.equal(classifyLink({ href: '/next', text: 'Next' }).classification, ACTION_CLASSES.READ);
  assert.equal(classifyAction({ name: 'Delete account', classification: 'read' }).classification, ACTION_CLASSES.MUTATE);
});

test('generated descriptors are strict, serializable, provenance-bound, and deterministic', () => {
  const page = snapshot();
  const first = generateWebMcpToolDescriptors(page);
  const second = generateWebMcpToolDescriptors(page);
  assert.deepEqual(JSON.parse(JSON.stringify(first)), first);
  assert.deepEqual(first, second);
  assert.ok(first.length >= 3);
  assert.equal(new Set(first.map((tool) => tool.name)).size, first.length);

  for (const tool of first) {
    assert.equal(typeof tool.name, 'string');
    assert.equal(typeof tool.provenance.pageFingerprint, 'string');
    assert.equal(tool.provenance.pageFingerprint, page.pageFingerprint);
    assert.equal(typeof tool.annotations.readOnlyHint, 'boolean');
    assert.equal(tool.annotations.untrustedContentHint, true);
    assert.equal(tool.inputSchema.type, 'object');
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert.equal(typeof tool.execute, 'undefined');
  }

  const form = first.find((tool) => tool.target.ref === 'checkout-form');
  assert.equal(form.classification, ACTION_CLASSES.MUTATE);
  assert.deepEqual(form.inputSchema.required, ['email']);
  assert.equal(form.inputSchema.properties.quantity.type, 'number');
});

test('generic GET forms, navigation, and value changes require approval and the tool surface is bounded', () => {
  const controls = Array.from({ length: 80 }, (_, index) => ({
    ref: `control-${index}`,
    role: index % 2 ? 'button' : 'textbox',
    name: index % 2 ? `View result ${index}` : `Search value ${index}`,
    type: index % 2 ? 'button' : 'search',
  }));
  const page = snapshot({
    forms: [{
      ref: 'search-form',
      name: 'Search documentation',
      method: 'GET',
      action: 'https://shop.example.test/search',
      fields: [{ ref: 'query', name: 'Query', type: 'search', required: true }],
    }],
    accessibleControls: controls,
    links: Array.from({ length: 80 }, (_, index) => ({ ref: `link-${index}`, href: `/result/${index}`, text: `View result ${index}` })),
  });
  const tools = generateWebMcpToolDescriptors(page, { includePageRead: true, maxTools: 32 });
  assert.equal(tools.length, 32);
  assert.equal(tools[0].sourceType, 'page');
  assert.equal(tools[0].classification, 'read');
  assert.ok(tools.slice(1).every((tool) => tool.classification === 'mutate' && tool.requiresApproval));
  const search = tools.find((tool) => tool.target.ref === 'search-form');
  assert.ok(search);
  assert.match(search.effect.summary, /human approval/);
  assert.ok(search.semanticEvidence.some((entry) => entry.code === 'UNVERIFIED_INTERACTION_REQUIRES_APPROVAL'));
});

test('prepared actions bind exact target, arguments, effect, and page fingerprint', () => {
  const page = snapshot();
  const submit = generateWebMcpToolDescriptors(page).find((tool) => tool.target.ref === 'checkout-form');
  const prepared = prepareAction({ snapshot: page, descriptor: submit, arguments: { email: 'operator@example.test', quantity: 2 } });

  assert.equal(prepared.status, 'prepared');
  assert.equal(prepared.classification, ACTION_CLASSES.MUTATE);
  assert.equal(prepared.target.ref, 'checkout-form');
  assert.deepEqual(prepared.arguments, { email: 'operator@example.test', quantity: 2 });
  assert.equal(prepared.effect.classification, ACTION_CLASSES.MUTATE);
  assert.equal(prepared.requiresApproval, true);
  assert.equal(assertPreparedActionCurrent(prepared, page), true);
  assert.equal(isActionCurrent(prepared, page), true);
  assert.notEqual(prepareAction(page, submit, { email: 'operator@example.test', quantity: 2 }).actionId, '');
  assert.throws(
    () => prepareAction(page, submit, { email: 'operator@example.test', unexpected: true }),
    (error) => error.code === 'ACTION_ARGUMENTS_INVALID',
  );
});

test('page drift and target drift invalidate prepared actions before execution', () => {
  const page = snapshot();
  const submit = generateWebMcpToolDescriptors(page).find((tool) => tool.target.ref === 'checkout-form');
  const prepared = prepareAction(page, submit, { email: 'operator@example.test' });
  const changedPage = snapshot({ mainText: 'The order total changed.' });
  assert.equal(isActionCurrent(prepared, changedPage), false);
  assert.throws(
    () => assertPreparedActionCurrent(prepared, changedPage),
    (error) => error.code === 'PAGE_FINGERPRINT_DRIFT',
  );

  // A bridge must still catch an element replacement even if a caller tries to
  // reuse the old page fingerprint rather than accepting a stale target.
  const forgedCurrent = { ...page, forms: [{ ...page.forms[0], name: 'Different target' }] };
  assert.throws(
    () => assertPreparedActionCurrent(prepared, forgedCurrent),
    (error) => error.code === 'ACTION_TARGET_DRIFT' || error.code === 'PAGE_FINGERPRINT_DRIFT',
  );
});

test('prepared actions preserve a live semantic binding for isolated-world execution', () => {
  const page = snapshot();
  const mutation = generateWebMcpToolDescriptors(page).find((tool) => tool.classification === 'mutate');
  const property = Object.keys(mutation.inputSchema.properties)[0];
  const prepared = prepareAction({ snapshot: page, descriptor: mutation, input: { [property]: 'bound@example.test' } });
  assert.equal(prepared.target.binding.role, 'form');
  assert.equal(prepared.target.binding.name, 'Place order');
  assert.equal(Object.hasOwn(prepared.target.binding, 'formRef'), true);
});
