/**
 * Perform one deliberately narrow CAPTCHA checkbox interaction in the target
 * document.  This function is also passed to chrome.scripting.executeScript,
 * so it must remain self-contained: Chrome serializes the function body into
 * the isolated top-frame world.
 */
export function clickVisibleCaptchaCheckbox(documentRef = globalThis.document) {
  const failure = (code, message) => ({
    ok: false,
    error: { code, message, details: {} },
  });

  if (!documentRef || typeof documentRef.querySelectorAll !== 'function') {
    return failure('CAPTCHA_DOCUMENT_UNAVAILABLE', 'The CAPTCHA surface document is unavailable.');
  }

  const marker = /(?:captcha|re[\s-]?captcha|hcaptcha|turnstile|cloudflare|not\s+a\s+robot|human\s+verification|security\s+check|bot\s+check)/iu;
  const values = (element) => {
    const result = [];
    const attributes = [
      'id', 'name', 'class', 'title', 'aria-label', 'aria-labelledby',
      'data-testid', 'data-sitekey', 'data-callback', 'data-widget-id',
    ];
    for (const attribute of attributes) {
      try {
        const value = element.getAttribute?.(attribute);
        if (typeof value === 'string' && value.length > 0) result.push(value.slice(0, 512));
      } catch { /* an inaccessible attribute is not evidence */ }
    }
    try {
      for (const label of element.labels ?? []) {
        if (typeof label?.textContent === 'string') result.push(label.textContent.slice(0, 512));
      }
    } catch { /* labels are optional */ }
    try {
      const label = element.closest?.('label');
      if (typeof label?.textContent === 'string') result.push(label.textContent.slice(0, 512));
    } catch { /* a detached node has no label */ }
    try {
      const labelledBy = element.getAttribute?.('aria-labelledby') ?? '';
      for (const id of labelledBy.split(/\s+/u).filter(Boolean).slice(0, 8)) {
        const label = documentRef.getElementById?.(id);
        if (typeof label?.textContent === 'string') result.push(label.textContent.slice(0, 512));
      }
    } catch { /* malformed ARIA references are ignored */ }
    // A number of widgets put the marker on a small wrapper around the
    // checkbox. Limit the walk to avoid treating an entire page as a label.
    let ancestor = element.parentElement;
    for (let depth = 0; ancestor && depth < 3 && ancestor !== documentRef.body; depth += 1) {
      for (const attribute of ['id', 'class', 'title', 'aria-label', 'data-sitekey', 'data-callback']) {
        try {
          const value = ancestor.getAttribute?.(attribute);
          if (typeof value === 'string' && value.length > 0) result.push(value.slice(0, 512));
        } catch { /* optional wrapper metadata */ }
      }
      ancestor = ancestor.parentElement;
    }
    return result.join(' ').slice(0, 4_096);
  };

  const visible = (element) => {
    if (!element || element.hidden === true || element.disabled === true) return false;
    try {
      if (element.getAttribute?.('aria-hidden') === 'true'
        || element.getAttribute?.('aria-disabled') === 'true') return false;
    } catch { return false; }
    let style = null;
    try {
      style = documentRef.defaultView?.getComputedStyle?.(element)
        ?? globalThis.getComputedStyle?.(element)
        ?? null;
    } catch { /* geometry below remains authoritative */ }
    if (style && (style.display === 'none'
      || style.visibility === 'hidden'
      || style.visibility === 'collapse'
      || style.opacity === '0')) return false;
    try {
      const rect = element.getBoundingClientRect?.();
      if (rect && Number.isFinite(rect.width) && Number.isFinite(rect.height)) {
        return rect.width > 0 && rect.height > 0;
      }
    } catch { return false; }
    const width = Number(element.offsetWidth);
    const height = Number(element.offsetHeight);
    return Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0;
  };

  let nodes;
  try {
    nodes = documentRef.querySelectorAll('input[type="checkbox"], [role="checkbox"]');
  } catch {
    return failure('CAPTCHA_DOCUMENT_UNAVAILABLE', 'The CAPTCHA surface could not be inspected.');
  }
  const markedCandidates = [];
  const seen = new Set();
  for (const element of nodes) {
    if (!element || seen.has(element) || !visible(element)) continue;
    seen.add(element);
    let type = '';
    let role = '';
    try {
      type = String(element.getAttribute?.('type') ?? element.type ?? '').toLowerCase();
      role = String(element.getAttribute?.('role') ?? '').toLowerCase();
    } catch { continue; }
    if (type !== 'checkbox' && role !== 'checkbox') continue;
    if (typeof element.click !== 'function') continue;
    if (marker.test(values(element))) markedCandidates.push(element);
  }

  // A CAPTCHA handoff is not authority to click an unrelated lone checkbox
  // such as "remember me" or terms acceptance. Require page-visible CAPTCHA
  // evidence even when there is only one checkbox.
  const candidates = markedCandidates;

  if (candidates.length !== 1) {
    return failure(
      'CAPTCHA_CHECKBOX_TARGET_INVALID',
      'Exactly one visible top-frame CAPTCHA checkbox is required; no click was dispatched.',
    );
  }
  const target = candidates[0];
  if (target.checked === true) {
    return failure('CAPTCHA_CHECKBOX_ALREADY_CHECKED', 'The CAPTCHA checkbox is already checked; no click was dispatched.');
  }
  try {
    target.click();
  } catch {
    return failure('CAPTCHA_CHECKBOX_CLICK_FAILED', 'The CAPTCHA checkbox rejected the bounded click.');
  }
  return { ok: true, clicked: true };
}
