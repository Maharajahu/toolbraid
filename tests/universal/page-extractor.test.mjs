import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const EXTRACTOR_SOURCE = fs.readFileSync(path.join(ROOT, 'extension/page-extractor.js'), 'utf8');

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
    this.submitCalls = 0;
    this.requestSubmitCalls = [];
    this.shadowRoot = null;
    this.value = attrs.value ?? '';
    this.checked = attrs.checked === true;
    this.disabled = attrs.disabled === true;
    this.required = attrs.required === true;
    this.multiple = attrs.multiple === true;
    this.options = [];
    this.duration = Number.isFinite(attrs.duration) ? attrs.duration : NaN;
    this.currentSrc = attrs.src ?? '';
    this.naturalWidth = Number(attrs.width) || 0;
    this.naturalHeight = Number(attrs.height) || 0;
    this.controls = attrs.controls === true;
  }

  append(...children) {
    for (const child of children) {
      child.parentNode = this;
      child.parentElement = child.nodeType === 1 ? this : null;
      this.childNodes.push(child);
    }
    return this;
  }

  setShadow(...children) {
    const root = { mode: 'open', childNodes: [], children: [], host: this };
    for (const child of children) {
      child.parentNode = root;
      child.parentElement = null;
      root.childNodes.push(child);
      root.children.push(child);
    }
    this.shadowRoot = root;
    return root;
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

function text(value) {
  return { nodeType: 3, nodeValue: value, textContent: value };
}

class FakeDocument {
  constructor(root, { url = 'https://fixture.example.test/page' } = {}) {
    this.nodeType = 9;
    this.documentElement = root;
    this.body = root.children.find((child) => child.localName === 'body') ?? root;
    this.title = '';
    this.URL = url;
    this.location = { href: url, origin: new URL(url).origin };
  }

  getElementById(id) {
    return this.all().find((node) => node.getAttribute('id') === id) ?? null;
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

function loadExtractor() {
  const context = {
    TextEncoder,
    URL,
    setTimeout,
    clearTimeout,
    console,
  };
  context.globalThis = context;
  vm.runInNewContext(EXTRACTOR_SOURCE, context, { filename: 'page-extractor.js' });
  return context;
}

function buildFixture() {
  const html = new FakeNode('html', { lang: 'en' });
  const head = new FakeNode('head');
  const title = new FakeNode('title', {}, 'Universal fixture');
  const meta = new FakeNode('meta', { name: 'description', content: 'Bounded extractor fixture.' });
  head.append(title, meta);
  const body = new FakeNode('body');
  const main = new FakeNode('main');
  const heading = new FakeNode('h1', { id: 'heading' }, 'Incident status');
  const paragraph = new FakeNode('p', {}, 'All systems are healthy.');
  const link = new FakeNode('a', { href: '/status', id: 'status-link' }, 'Read status');
  const form = new FakeNode('form', { id: 'notice-form', method: 'post', action: '/api/notice', 'aria-label': 'Publish notice' });
  const label = new FakeNode('label', { for: 'message' }, 'Message');
  const input = new FakeNode('input', { id: 'message', name: 'message', type: 'text', required: true, value: 'Healthy' });
  const select = new FakeNode('select', { name: 'audience' });
  const optionA = new FakeNode('option', { value: 'customers' }, 'Customers');
  const optionB = new FakeNode('option', { value: 'internal' }, 'Internal');
  select.options = [optionA, optionB];
  select.append(optionA, optionB);
  const checkbox = new FakeNode('input', { name: 'confirm', type: 'checkbox', required: true });
  const submit = new FakeNode('button', { type: 'submit', 'aria-label': 'Publish notice' }, 'Publish notice');
  label.append(input);
  form.append(label, select, checkbox, submit);
  const image = new FakeNode('img', { src: '/chart.png', alt: 'Healthy chart', width: '320', height: '180' });
  const host = new FakeNode('section', { id: 'host' });
  const shadowHeading = new FakeNode('h2', {}, 'Open shadow status');
  const shadowButton = new FakeNode('button', { type: 'button', 'aria-label': 'Refresh shadow' }, 'Refresh');
  host.setShadow(shadowHeading, shadowButton);
  main.append(heading, paragraph, link, form, image, host);
  body.append(main);
  html.append(head, body);
  const documentRef = new FakeDocument(html);
  documentRef.title = 'Universal fixture';
  return { documentRef, input, select, checkbox, submit, form, shadowButton };
}

test('classic extractor emits bounded, serializable page semantics with open shadow and media inventory', () => {
  const context = loadExtractor();
  const fixture = buildFixture();
  const api = context.ToolBraidUniversalPageExtractor;
  assert.equal(api, context.ToolBraidUniversal.pageExtractor);
  const snapshot = api.extract({ documentRef: fixture.documentRef });

  assert.equal(snapshot.version, 1);
  assert.equal(snapshot.metadata.title, 'Universal fixture');
  assert.equal(snapshot.metadata.description, 'Bounded extractor fixture.');
  assert.equal(snapshot.metadata.origin, 'https://fixture.example.test');
  assert.equal(snapshot.headings[0].text, 'Incident status');
  assert.match(snapshot.mainText, /All systems are healthy/);
  assert.equal(snapshot.links[0].href, 'https://fixture.example.test/status');
  assert.equal(snapshot.forms[0].method, 'POST');
  assert.ok(snapshot.forms[0].fields.some((field) => field.name === 'Message'));
  assert.ok(snapshot.accessibleControls.some((control) => control.name === 'Refresh shadow'));
  assert.equal(snapshot.mediaInventory[0].kind, 'image');
  assert.equal(snapshot.mediaInventory[0].alt, 'Healthy chart');
  assert.match(snapshot.pageFingerprint, /^[a-f0-9]{64}$/);
  const serialized = JSON.stringify(snapshot);
  assert.equal(serialized, JSON.stringify(JSON.parse(serialized)));

  const second = api.extract({ documentRef: fixture.documentRef });
  assert.equal(second.pageFingerprint, snapshot.pageFingerprint);
  fixture.input.value = 'Changed';
  const changed = api.extract({ documentRef: fixture.documentRef });
  assert.notEqual(changed.pageFingerprint, snapshot.pageFingerprint);
});

test('classic extractor enforces traversal and collection bounds', () => {
  const context = loadExtractor();
  const fixture = buildFixture();
  const snapshot = context.ToolBraidUniversalPageExtractor.extract({
    documentRef: fixture.documentRef,
    maxNodes: 3,
    maxElements: 2,
    maxItems: 1,
    maxTextCharacters: 12,
  });
  assert.equal(snapshot.stats.truncated, true);
  assert.ok(snapshot.stats.nodesVisited <= 3);
  assert.ok(snapshot.elementRefs.length <= 2);
  assert.ok(snapshot.mainText.length <= 12);
});
