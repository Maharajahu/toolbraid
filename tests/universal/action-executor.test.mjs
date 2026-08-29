import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { createPageSnapshot } from '../../src/universal/snapshot.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const EXTRACTOR_SOURCE = fs.readFileSync(path.join(ROOT, 'extension/page-extractor.js'), 'utf8');
const EXECUTOR_SOURCE = fs.readFileSync(path.join(ROOT, 'extension/action-executor.js'), 'utf8');

class FakeEvent {
  constructor(type, options = {}) {
    this.type = type;
    this.bubbles = Boolean(options.bubbles);
    this.cancelable = Boolean(options.cancelable);
  }
}

class FakeNode {
  constructor(tag, attrs = {}, text = '') {
    this.nodeType = 1;
    this.localName = tag.toLowerCase();
    this.tagName = tag.toUpperCase();
    this.attributes = { ...attrs };
    this.childNodes = [];
    this.parentNode = null;
    this.parentElement = null;
    this._text = text;
    this.events = [];
    this.clicks = 0;
    this.requestSubmitCalls = [];
    this.submitCalls = 0;
    this.value = attrs.value ?? '';
    this.checked = attrs.checked === true;
    this.disabled = attrs.disabled === true;
    this.required = attrs.required === true;
    this.multiple = attrs.multiple === true;
    this.options = [];
  }

  append(...children) {
    for (const child of children) {
      child.parentNode = this;
      child.parentElement = child.nodeType === 1 ? this : null;
      this.childNodes.push(child);
    }
    return this;
  }

  get children() { return this.childNodes.filter((child) => child.nodeType === 1); }

  get textContent() { return [this._text, ...this.childNodes.map((child) => child.textContent ?? child.nodeValue ?? '')].filter(Boolean).join(' '); }

  get innerText() { return this.textContent; }

  getAttribute(name) {
    const key = name.toLowerCase();
    return Object.hasOwn(this.attributes, key) ? String(this.attributes[key]) : null;
  }

  hasAttribute(name) { return Object.hasOwn(this.attributes, name.toLowerCase()); }

  dispatchEvent(event) { this.events.push(event.type); return true; }

  click() { this.clicks += 1; }

  requestSubmit(submitter) { this.requestSubmitCalls.push(submitter ?? null); }

  submit() { this.submitCalls += 1; }
}

class FakeDocument {
  constructor(root, url = 'https://fixture.example.test/form') {
    this.nodeType = 9;
    this.documentElement = root;
    this.body = root.children.find((child) => child.localName === 'body') ?? root;
    this.title = 'Action fixture';
    this.URL = url;
    this.location = { href: url, origin: new URL(url).origin };
  }

  all() {
    const result = [];
    const seen = new Set();
    const visit = (node) => {
      if (!node || seen.has(node)) return;
      seen.add(node);
      if (node.nodeType === 1) result.push(node);
      for (const child of node.childNodes ?? []) visit(child);
      for (const child of node.shadowRoot?.childNodes ?? []) visit(child);
    };
    visit(this.documentElement);
    return result;
  }

  querySelectorAll(selector) {
    const nodes = this.all();
    if (selector === '*') return nodes;
    if (/^[a-z]+$/i.test(selector)) return nodes.filter((node) => node.localName === selector.toLowerCase());
    return [];
  }
}

function loadRuntime() {
  const context = {
    TextEncoder,
    URL,
    Event: FakeEvent,
    setTimeout,
    clearTimeout,
    console,
  };
  context.globalThis = context;
  vm.runInNewContext(EXTRACTOR_SOURCE, context, { filename: 'page-extractor.js' });
  vm.runInNewContext(EXECUTOR_SOURCE, context, { filename: 'action-executor.js' });
  return context;
}

function buildFixture() {
  const html = new FakeNode('html');
  const body = new FakeNode('body');
  const main = new FakeNode('main');
  const form = new FakeNode('form', { id: 'form', method: 'post' });
  const title = new FakeNode('input', { id: 'title', name: 'title', type: 'text', value: 'Initial' });
  const select = new FakeNode('select', { id: 'audience', name: 'audience' });
  const customers = new FakeNode('option', { value: 'customers' }, 'Customers');
  const internal = new FakeNode('option', { value: 'internal' }, 'Internal');
  select.options = [customers, internal];
  select.append(customers, internal);
  const checkbox = new FakeNode('input', { id: 'confirm', name: 'confirm', type: 'checkbox' });
  const submit = new FakeNode('button', { 'data-toolbraid-ref': 'publish', type: 'submit', 'aria-label': 'Publish notice' }, 'Publish');
  form.append(title, select, checkbox, submit);
  main.append(form);
  body.append(main);
  html.append(body);
  return { documentRef: new FakeDocument(html), form, title, select, checkbox, submit };
}

function targetBinding(snapshot, ref, target) {
  return {
    pageFingerprint: snapshot.pageFingerprint,
    ref,
    role: target.role,
    name: target.name,
    formRef: target.formRef,
    type: target.type,
  };
}

function canonicalFingerprint(extractor, documentRef) {
  const raw = JSON.parse(JSON.stringify(extractor.extract({ documentRef })));
  delete raw.pageFingerprint;
  delete raw.fingerprint;
  delete raw.stats;
  delete raw.mediaInventory;
  return createPageSnapshot(raw).pageFingerprint;
}

test('executor stages input, select, and checkbox values with native input/change events', () => {
  const context = loadRuntime();
  const fixture = buildFixture();
  const extractor = context.ToolBraidUniversalPageExtractor;
  const executor = context.ToolBraidUniversalActionExecutor;
  let snapshot = extractor.extract({ documentRef: fixture.documentRef });

  const inputResult = executor.executeAction({
    documentRef: fixture.documentRef,
    pageFingerprint: snapshot.pageFingerprint,
    classification: 'stage',
    operation: 'input',
    target: { ref: 'id:title', role: 'textbox', name: 'title', formRef: 'id:form', type: 'text' },
    arguments: { value: 'Changed' },
  });
  assert.deepEqual(Array.from(inputResult.events), ['input', 'change']);
  assert.equal(fixture.title.value, 'Changed');
  assert.deepEqual(fixture.title.events, ['input', 'change']);

  snapshot = extractor.extract({ documentRef: fixture.documentRef });
  const selectResult = executor.executeAction({
    documentRef: fixture.documentRef,
    pageFingerprint: snapshot.pageFingerprint,
    classification: 'stage',
    operation: 'select',
    target: { ref: 'id:audience', role: 'combobox', name: 'audience', formRef: 'id:form', type: 'select' },
    arguments: { value: 'internal' },
  });
  assert.deepEqual(Array.from(selectResult.events), ['input', 'change']);
  assert.equal(fixture.select.value, 'internal');

  snapshot = extractor.extract({ documentRef: fixture.documentRef });
  const checkboxResult = executor.executeAction({
    documentRef: fixture.documentRef,
    pageFingerprint: snapshot.pageFingerprint,
    classification: 'stage',
    operation: 'check',
    target: { ref: 'id:confirm', role: 'checkbox', name: 'confirm', formRef: 'id:form', type: 'checkbox' },
    arguments: { checked: true },
  });
  assert.deepEqual(Array.from(checkboxResult.events), ['input', 'change']);
  assert.equal(fixture.checkbox.checked, true);
});

test('executor allows only approved, exactly bound mutation click/submit operations', () => {
  const context = loadRuntime();
  const fixture = buildFixture();
  const extractor = context.ToolBraidUniversalPageExtractor;
  const executor = context.ToolBraidUniversalActionExecutor;
  const snapshot = extractor.extract({ documentRef: fixture.documentRef });
  const ref = 'data:publish';
  const target = { ref, role: 'button', name: 'Publish notice', formRef: 'id:form', type: 'submit' };
  const binding = targetBinding(snapshot, ref, target);

  assert.throws(
    () => executor.executeAction({ documentRef: fixture.documentRef, classification: 'mutate', operation: 'click', target, binding }),
    (error) => error.code === 'APPROVAL_REQUIRED',
  );
  const result = executor.executeAction({ documentRef: fixture.documentRef, classification: 'mutate', operation: 'click', target, binding, approved: true });
  assert.equal(result.ok, true);
  assert.equal(result.operation, 'click');
  assert.equal(fixture.submit.clicks, 1);

  assert.throws(
    () => executor.executeAction({ documentRef: fixture.documentRef, classification: 'mutate', operation: 'click', target: { ...target, name: 'Forged' }, binding, approved: true }),
    (error) => error.code === 'ACTION_TARGET_DRIFT' || error.code === 'ACTION_BINDING_MISMATCH',
  );
  assert.throws(
    () => executor.executeAction({ documentRef: fixture.documentRef, classification: 'mutate', operation: 'delete', target, binding, approved: true }),
    (error) => error.code === 'ACTION_OPERATION_INVALID',
  );
});

test('executor requires approval for generic value changes and redacts the mutation receipt', () => {
  const context = loadRuntime();
  const fixture = buildFixture();
  const extractor = context.ToolBraidUniversalPageExtractor;
  const executor = context.ToolBraidUniversalActionExecutor;
  const snapshot = extractor.extract({ documentRef: fixture.documentRef });
  const target = { ref: 'id:title', role: 'textbox', name: 'title', formRef: 'id:form', type: 'text' };
  const binding = targetBinding(snapshot, target.ref, target);

  assert.throws(
    () => executor.executeAction({ documentRef: fixture.documentRef, classification: 'mutate', operation: 'set', target, binding, arguments: { value: 'Secret draft' } }),
    (error) => error.code === 'APPROVAL_REQUIRED',
  );
  const result = executor.executeAction({
    documentRef: fixture.documentRef,
    classification: 'mutate',
    operation: 'set',
    target,
    binding,
    arguments: { value: 'Approved value' },
    approved: true,
  });
  assert.equal(fixture.title.value, 'Approved value');
  assert.deepEqual(Array.from(result.events), ['input', 'change']);
  assert.equal(result.changed.value, '[redacted]');
  assert.doesNotMatch(JSON.stringify(result), /Approved value/);
});

test('executor accepts a freshly revalidated privileged canonical fingerprint while retaining local target checks', () => {
  const context = loadRuntime();
  const fixture = buildFixture();
  const executor = context.ToolBraidUniversalActionExecutor;
  const canonicalPageFingerprint = canonicalFingerprint(context.ToolBraidUniversalPageExtractor, fixture.documentRef);
  const extractorPageFingerprint = context.ToolBraidUniversalPageExtractor.extract({ documentRef: fixture.documentRef }).pageFingerprint;
  assert.notEqual(canonicalPageFingerprint, extractorPageFingerprint);
  const target = { ref: 'data:publish', role: 'button', name: 'Publish notice', formRef: 'id:form', type: 'submit' };
  const binding = { ...target, canonicalPageFingerprint };

  const result = executor.executeAction({
    documentRef: fixture.documentRef,
    classification: 'mutate',
    operation: 'click',
    target,
    binding,
    approved: true,
  });
  assert.equal(result.ok, true);
  assert.equal(result.pageFingerprint, canonicalPageFingerprint);
  assert.equal(result.canonicalPageFingerprint, canonicalPageFingerprint);
  assert.equal(typeof result.extractorFingerprint, 'string');

  assert.throws(
    () => executor.executeAction({
      documentRef: fixture.documentRef,
      classification: 'mutate',
      operation: 'click',
      target: { ...target, name: 'Forged target' },
      binding,
      approved: true,
    }),
    (error) => error.code === 'ACTION_BINDING_MISMATCH',
  );
});

test('executor applies approved POST form arguments atomically before submit and redacts the receipt', () => {
  const context = loadRuntime();
  const fixture = buildFixture();
  const executor = context.ToolBraidUniversalActionExecutor;
  const canonicalPageFingerprint = canonicalFingerprint(context.ToolBraidUniversalPageExtractor, fixture.documentRef);
  const inputSchema = {
    type: 'object',
    properties: {
      title: { type: 'string' },
      audience: { type: 'string', enum: ['customers', 'internal'] },
      confirm: { type: 'boolean' },
    },
    required: ['title', 'audience', 'confirm'],
    additionalProperties: false,
  };
  const result = executor.executeAction({
    documentRef: fixture.documentRef,
    preparedAction: {
      pageFingerprint: canonicalPageFingerprint,
      target: {
        ref: 'id:form',
        type: 'form',
        targetFingerprint: 'canonical-form-target',
        binding: { role: 'form', name: '', formRef: null },
      },
      arguments: { title: 'Approved title', audience: 'internal', confirm: true },
      descriptor: { inputSchema },
    },
    classification: 'mutate',
    operation: 'submit',
    approved: true,
  });

  assert.equal(fixture.title.value, 'Approved title');
  assert.equal(fixture.select.value, 'internal');
  assert.equal(fixture.checkbox.checked, true);
  assert.deepEqual(fixture.title.events, ['input', 'change']);
  assert.deepEqual(fixture.select.events, ['input', 'change']);
  assert.deepEqual(fixture.checkbox.events, ['input', 'change']);
  assert.equal(fixture.form.requestSubmitCalls.length, 1);
  assert.deepEqual(Array.from(result.events), ['input', 'change', 'input', 'change', 'input', 'change', 'submit']);
  assert.equal(result.changed.submit, true);
  assert.equal(result.changed.fields.length, 3);
  assert.ok(result.changed.fields.every((field) => field.redacted === true && !Object.hasOwn(field, 'value')));
  assert.equal(result.pageFingerprint, canonicalPageFingerprint);
});

test('executor rejects ambiguous form argument mappings before changing or submitting the form', () => {
  const context = loadRuntime();
  const fixture = buildFixture();
  const duplicateA = new FakeNode('input', { id: 'message-a', name: 'message', type: 'text', value: 'A' });
  const duplicateB = new FakeNode('input', { id: 'message-b', name: 'message', type: 'text', value: 'B' });
  fixture.form.append(duplicateA, duplicateB);
  const executor = context.ToolBraidUniversalActionExecutor;
  assert.throws(
    () => executor.executeAction({
      documentRef: fixture.documentRef,
      canonicalPageFingerprint: canonicalFingerprint(context.ToolBraidUniversalPageExtractor, fixture.documentRef),
      classification: 'mutate',
      operation: 'submit',
      target: { ref: 'id:form', role: 'form', name: '', formRef: null, type: null },
      binding: { canonicalPageFingerprint: canonicalFingerprint(context.ToolBraidUniversalPageExtractor, fixture.documentRef), ref: 'id:form', role: 'form', name: '', formRef: null },
      inputSchema: { type: 'object', properties: { message: { type: 'string' } }, additionalProperties: false },
      arguments: { message: 'Should not apply' },
      approved: true,
    }),
    (error) => error.code === 'ACTION_FIELD_AMBIGUOUS',
  );
  assert.equal(duplicateA.value, 'A');
  assert.equal(duplicateB.value, 'B');
  assert.equal(fixture.form.requestSubmitCalls.length, 0);
});

test('executor blocks fingerprint drift, ambiguity, sensitive fields, and unknown destructive actions', () => {
  const context = loadRuntime();
  const fixture = buildFixture();
  const extractor = context.ToolBraidUniversalPageExtractor;
  const executor = context.ToolBraidUniversalActionExecutor;
  let snapshot = extractor.extract({ documentRef: fixture.documentRef });
  const target = { ref: 'data:publish', role: 'button', name: 'Publish notice', formRef: 'id:form', type: 'submit' };
  const binding = targetBinding(snapshot, target.ref, target);
  fixture.title.value = 'Changed before mutation';
  assert.throws(
    () => executor.executeAction({ documentRef: fixture.documentRef, classification: 'mutate', operation: 'click', target, binding, approved: true }),
    (error) => error.code === 'PAGE_FINGERPRINT_DRIFT',
  );

  const password = new FakeNode('input', { id: 'password', name: 'password', type: 'password' });
  fixture.form.append(password);
  snapshot = extractor.extract({ documentRef: fixture.documentRef });
  assert.throws(
    () => executor.executeAction({ documentRef: fixture.documentRef, pageFingerprint: snapshot.pageFingerprint, classification: 'stage', operation: 'input', target: { ref: 'id:password', role: 'textbox', name: 'password', formRef: 'id:form', type: 'password' }, arguments: { value: 'secret' } }),
    (error) => error.code === 'SENSITIVE_FIELD_BLOCKED',
  );

  const deleteButton = new FakeNode('button', { id: 'delete', type: 'button' }, 'Delete account');
  fixture.form.append(deleteButton);
  snapshot = extractor.extract({ documentRef: fixture.documentRef });
  assert.throws(
    () => executor.executeAction({ documentRef: fixture.documentRef, pageFingerprint: snapshot.pageFingerprint, ref: 'id:delete' }),
    (error) => error.code === 'DESTRUCTIVE_ACTION_UNKNOWN',
  );
});
