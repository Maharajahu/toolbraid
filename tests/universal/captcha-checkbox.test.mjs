import test from 'node:test';
import assert from 'node:assert/strict';

import { clickVisibleCaptchaCheckbox } from '../../extension/captcha-checkbox.js';

function checkbox({ label = 'I am not a robot', visible = true, role = undefined, captcha = true } = {}) {
  let clicked = 0;
  const attributes = {
    id: captcha ? 'captcha-checkbox' : 'terms-checkbox',
    name: captcha ? 'captcha' : 'terms',
    'aria-label': label,
    type: 'checkbox',
    ...(role === undefined ? {} : { role }),
  };
  const node = {
    checked: false,
    disabled: false,
    hidden: !visible,
    labels: [],
    parentElement: null,
    getAttribute(name) { return attributes[name] ?? null; },
    getBoundingClientRect() { return { width: visible ? 20 : 0, height: visible ? 20 : 0 }; },
    click() { clicked += 1; },
  };
  Object.defineProperty(node, 'clicks', { get: () => clicked });
  return node;
}

function documentFor(nodes) {
  return {
    body: {},
    defaultView: { getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }) },
    querySelectorAll() { return nodes; },
    getElementById() { return null; },
  };
}

test('clicks exactly one visible top-frame CAPTCHA checkbox', () => {
  const target = checkbox();

  const result = clickVisibleCaptchaCheckbox(documentFor([target]));

  assert.deepEqual(result, { ok: true, clicked: true });
  assert.equal(target.clicks, 1);
});

test('fails closed without clicking when the visible CAPTCHA target is ambiguous or absent', () => {
  const first = checkbox();
  const second = checkbox({ label: 'Verify human' });
  const ambiguous = clickVisibleCaptchaCheckbox(documentFor([first, second]));
  assert.equal(ambiguous.ok, false);
  assert.equal(ambiguous.error.code, 'CAPTCHA_CHECKBOX_TARGET_INVALID');
  assert.equal(first.clicks, 0);
  assert.equal(second.clicks, 0);

  const generic = checkbox({ label: 'Accept terms', captcha: false });
  const genericSecond = checkbox({ label: 'Accept privacy policy', captcha: false });
  const absent = clickVisibleCaptchaCheckbox(documentFor([generic, genericSecond]));
  assert.equal(absent.ok, false);
  assert.equal(absent.error.code, 'CAPTCHA_CHECKBOX_TARGET_INVALID');
  assert.equal(generic.clicks, 0);
  assert.equal(genericSecond.clicks, 0);

  const loneGeneric = checkbox({ label: 'Remember me', captcha: false });
  const unrelated = clickVisibleCaptchaCheckbox(documentFor([loneGeneric]));
  assert.equal(unrelated.ok, false);
  assert.equal(unrelated.error.code, 'CAPTCHA_CHECKBOX_TARGET_INVALID');
  assert.equal(loneGeneric.clicks, 0);
});

test('ignores hidden controls and does not traverse iframe documents', () => {
  const hidden = checkbox({ visible: false });
  const iframeCheckbox = checkbox();
  const iframe = { contentDocument: documentFor([iframeCheckbox]) };

  const result = clickVisibleCaptchaCheckbox(documentFor([hidden, iframe]));

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'CAPTCHA_CHECKBOX_TARGET_INVALID');
  assert.equal(hidden.clicks, 0);
  assert.equal(iframeCheckbox.clicks, 0);
});
