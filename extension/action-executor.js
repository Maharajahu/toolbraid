/*
 * ToolBraid Universal action executor.
 *
 * Classic-script/UMD-compatible runtime for chrome.scripting.executeScript.
 * It resolves one live element ref, revalidates page and target bindings, and
 * performs only the small set of browser operations exposed by this module.
 * External callers retain the human approval boundary: mutation requests must
 * carry approved: true plus an exact binding object.
 */
(function installToolBraidActionExecutor(global) {
  if (!global || global.ToolBraidUniversalActionExecutor) return;

  const VERSION = 1;
  const CLASS_READ = 'read';
  const CLASS_STAGE = 'stage';
  const CLASS_MUTATE = 'mutate';
  const INTERACTIVE_ROLES = new Set(['button', 'checkbox', 'combobox', 'link', 'menuitem', 'radio', 'slider', 'switch', 'tab', 'textbox']);
  const DESTRUCTIVE_WORDS = /\b(?:delete|remove|destroy|erase|withdraw|transfer|purchase|buy|pay|checkout|publish|send|close\s+account|revoke|disable)\b/i;

  function executionError(code, message, details) {
    const error = new Error(message);
    error.name = 'ToolBraidActionExecutorError';
    error.code = code;
    error.details = details || {};
    return error;
  }

  function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  function isPlain(value) {
    if (!isRecord(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    if (prototype === null || prototype === Object.prototype) return true;
    // Requests can cross the isolated/page realm boundary.  Native
    // structured-clone objects keep the ordinary Object constructor but do
    // not share this realm's Object.prototype identity.
    return prototype?.constructor?.name === 'Object';
  }

  function safeGet(target, property, fallback) {
    try {
      const value = target?.[property];
      return value === undefined || value === null ? fallback : value;
    } catch {
      return fallback;
    }
  }

  function safeCall(target, method, args, fallback) {
    try {
      if (typeof target?.[method] !== 'function') return fallback;
      const value = target[method](...(args || []));
      return value === undefined || value === null ? fallback : value;
    } catch {
      return fallback;
    }
  }

  function toArray(value) {
    if (!value) return [];
    if (Array.isArray(value)) return value.slice();
    try { return Array.from(value); } catch { return []; }
  }

  function attr(element, name, fallback) {
    const value = safeCall(element, 'getAttribute', [name], null);
    return value === null || value === undefined ? fallback : String(value);
  }

  function hasAttr(element, name) {
    const result = safeCall(element, 'hasAttribute', [name], null);
    return result === null ? attr(element, name, null) !== null : result === true;
  }

  function tagName(element) {
    return String(safeGet(element, 'localName', safeGet(element, 'tagName', '')) || '').toLowerCase();
  }

  function isElement(value) {
    return Boolean(value && (value.nodeType === 1 || typeof value.tagName === 'string' || typeof value.localName === 'string'));
  }

  function childrenOf(node) {
    const children = safeGet(node, 'children', null);
    if (children && typeof children.length === 'number') return toArray(children);
    return toArray(safeGet(node, 'childNodes', []));
  }

  function shadowRootOf(element) {
    const root = safeGet(element, 'shadowRoot', null);
    if (!root || safeGet(root, 'mode', 'open') === 'closed') return null;
    return root;
  }

  const SEMANTIC_SCAN_NODE_LIMIT = 4_096;
  const SEMANTIC_ANCESTOR_SCAN_LIMIT = 64;

  function isXStatusUrl(url) {
    const host = url.hostname.toLowerCase();
    return ['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com'].includes(host)
      && /^\/[A-Za-z0-9_]+\/status\/[A-Za-z0-9_-]+\/?$/.test(url.pathname);
  }

  function resourceIdentity(url) {
    const xStatus = isXStatusUrl(url);
    return `${url.origin}${url.pathname}${xStatus ? '' : url.search}`;
  }

  function semanticParent(node) {
    let parent = safeGet(node, 'parentElement', null) || safeGet(node, 'parentNode', null);
    if (parent && !isElement(parent)) parent = safeGet(parent, 'host', null);
    return parent;
  }

  function indexedChildren(node) {
    const children = safeGet(node, 'children', null);
    if (children && Number.isFinite(Number(safeGet(children, 'length', NaN)))) return children;
    const childNodeList = safeGet(node, 'childNodes', null);
    return childNodeList && Number.isFinite(Number(safeGet(childNodeList, 'length', NaN))) ? childNodeList : null;
  }

  function walkNodesBounded(root, limit, visitor) {
    if (!root || !Number.isInteger(limit) || limit <= 0) return null;
    const frame = (node) => ({ node, entered: false, children: null, length: 0, index: 0 });
    const stack = [frame(root)];
    const seen = new Set();
    let inspected = 0;
    let childSlots = 0;
    while (stack.length && inspected < limit && childSlots < limit) {
      const currentFrame = stack[stack.length - 1];
      if (!currentFrame.entered) {
        const node = currentFrame.node;
        if (!node || seen.has(node)) {
          stack.pop();
          continue;
        }
        seen.add(node);
        inspected += 1;
        const result = visitor(node);
        if (result) return result;
        currentFrame.entered = true;
        currentFrame.children = indexedChildren(node);
        const length = Number(safeGet(currentFrame.children, 'length', 0));
        currentFrame.length = Number.isFinite(length) && length > 0 ? Math.min(Math.floor(length), limit) : 0;
        continue;
      }
      if (currentFrame.index >= currentFrame.length) {
        stack.pop();
        continue;
      }
      const child = safeGet(currentFrame.children, currentFrame.index, null);
      currentFrame.index += 1;
      childSlots += 1;
      if (child && !seen.has(child)) stack.push(frame(child));
    }
    return null;
  }

  function permalinkArticle(linkElement) {
    let article = null;
    let current = linkElement;
    for (let depth = 0; current && depth < SEMANTIC_ANCESTOR_SCAN_LIMIT; depth += 1) {
      if (isElement(current) && tagName(current) === 'article') {
        if (article) return null;
        article = current;
      }
      current = semanticParent(current);
    }
    return article;
  }

  function timestampLink(timeElement) {
    if (!trimText(attr(timeElement, 'datetime', ''))) return null;
    let current = timeElement;
    for (let depth = 0; current && depth < SEMANTIC_ANCESTOR_SCAN_LIMIT; depth += 1) {
      if (isElement(current) && tagName(current) === 'a') return current;
      if (current !== timeElement && isElement(current) && tagName(current) === 'article') return null;
      current = semanticParent(current);
    }
    return null;
  }

  function preferredArticleRoot(documentRef) {
    const href = String(safeGet(safeGet(documentRef, 'location', null), 'href', safeGet(documentRef, 'URL', '')) || '');
    let currentUrl = null;
    try { currentUrl = href ? new URL(href) : null; } catch { currentUrl = null; }
    if (!currentUrl) return null;

    currentUrl.hash = '';
    const targetIdentity = resourceIdentity(currentUrl);
    const currentIsXStatus = isXStatusUrl(currentUrl);
    const root = safeGet(documentRef, 'body', null) || safeGet(documentRef, 'documentElement', null);
    return walkNodesBounded(root, SEMANTIC_SCAN_NODE_LIMIT, (node) => {
      let linkElement = null;
      if (currentIsXStatus) {
        if (!isElement(node)) return null;
        if (tagName(node) === 'time') linkElement = timestampLink(node);
        else if (tagName(node) === 'a' && trimText(attr(node, 'data-timezone', ''))) linkElement = node;
        else return null;
      } else if (isElement(node) && tagName(node) === 'a') {
        linkElement = node;
      }
      if (linkElement) {
        const rawHref = attr(linkElement, 'href', null);
        const trimmedHref = typeof rawHref === 'string' ? rawHref.trim() : '';
        if (trimmedHref && !trimmedHref.startsWith('#') && !trimmedHref.startsWith('?')) {
          let linkUrl = null;
          try { linkUrl = new URL(trimmedHref, currentUrl.href); } catch { linkUrl = null; }
          if (linkUrl && !linkUrl.hash && resourceIdentity(linkUrl) === targetIdentity) {
            return permalinkArticle(linkElement);
          }
        }
      }
      return null;
    });
  }

  function semanticRoots(documentRef) {
    const documentElement = safeGet(documentRef, 'documentElement', null);
    const body = safeGet(documentRef, 'body', null);
    const preferredArticle = preferredArticleRoot(documentRef);
    let main = null;
    if (preferredArticle) {
      let current = preferredArticle;
      for (let depth = 0; current && depth < SEMANTIC_ANCESTOR_SCAN_LIMIT; depth += 1) {
        if (isElement(current) && tagName(current) === 'main') {
          main = current;
          break;
        }
        current = semanticParent(current);
      }
    }
    const roots = [];
    for (const root of preferredArticle
      ? [preferredArticle, main, documentElement || body]
      : [documentElement || body]) {
      if (root && !roots.includes(root)) roots.push(root);
    }
    return roots;
  }

  function collectElements(documentRef, maxNodes = 1024) {
    const elements = [];
    const seen = new Set();
    const visit = (node, shadowDepth = 0) => {
      if (!node || seen.has(node) || elements.length >= maxNodes) return;
      seen.add(node);
      if (isElement(node)) elements.push(node);
      for (const child of childrenOf(node)) visit(child, shadowDepth);
      const shadow = isElement(node) ? shadowRootOf(node) : null;
      if (shadow && shadowDepth < 4) for (const child of childrenOf(shadow)) visit(child, shadowDepth + 1);
    };
    for (const root of semanticRoots(documentRef)) visit(root);
    if (!elements.length && typeof documentRef?.querySelectorAll === 'function') {
      for (const element of toArray(safeCall(documentRef, 'querySelectorAll', ['*'], []))) {
        if (elements.length >= maxNodes) break;
        if (isElement(element) && !seen.has(element)) {
          seen.add(element);
          elements.push(element);
        }
      }
    }
    return elements;
  }

  function countsFor(elements) {
    const counts = { id: new Map(), name: new Map(), data: new Map() };
    for (const element of elements) {
      const id = attr(element, 'id', '');
      const name = attr(element, 'name', '');
      const data = attr(element, 'data-toolbraid-ref', '');
      if (id) counts.id.set(id, (counts.id.get(id) || 0) + 1);
      if (name) counts.name.set(name, (counts.name.get(name) || 0) + 1);
      if (data) counts.data.set(data, (counts.data.get(data) || 0) + 1);
    }
    return counts;
  }

  function refTable(elements) {
    const counts = countsFor(elements);
    const refs = new Map();
    const reverse = new Map();
    elements.forEach((element, index) => {
      const data = attr(element, 'data-toolbraid-ref', '');
      const id = attr(element, 'id', '');
      const name = attr(element, 'name', '');
      const ref = data && counts.data.get(data) === 1
        ? `data:${data}`
        : id && counts.id.get(id) === 1
          ? `id:${id}`
          : name && counts.name.get(name) === 1
            ? `name:${name}`
            : `el-${index + 1}`;
      refs.set(element, ref);
      if (!reverse.has(ref)) reverse.set(ref, []);
      reverse.get(ref).push(element);
    });
    return { refs, reverse, counts };
  }

  function trimText(value) {
    return String(value ?? '').replace(/\s+/g, ' ').trim();
  }

  function textOf(node, max = 1024) {
    if (!node || max <= 0) return '';
    if (node.nodeType === 3) return trimText(safeGet(node, 'nodeValue', '')).slice(0, max);
    if (!isElement(node)) return '';
    const tag = tagName(node);
    if (['script', 'style', 'noscript', 'template', 'svg', 'canvas'].includes(tag)) return '';
    const parts = [];
    let length = 0;
    for (const child of childrenOf(node)) {
      if (length >= max) break;
      const value = textOf(child, max - length);
      if (!value) continue;
      parts.push(value);
      length += value.length;
    }
    const shadow = shadowRootOf(node);
    if (shadow && length < max) {
      for (const child of childrenOf(shadow)) {
        if (length >= max) break;
        const value = textOf(child, max - length);
        if (!value) continue;
        parts.push(value);
        length += value.length;
      }
    }
    return trimText(parts.join(' ') || safeGet(node, 'innerText', safeGet(node, 'textContent', ''))).slice(0, max);
  }

  function implicitRole(element) {
    const tag = tagName(element);
    if (tag === 'a' && attr(element, 'href', null) !== null) return 'link';
    if (tag === 'button') return 'button';
    if (tag === 'form') return 'form';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'select') return hasAttr(element, 'multiple') ? 'listbox' : 'combobox';
    if (tag === 'input') {
      const type = (attr(element, 'type', 'text') || 'text').toLowerCase();
      if (['button', 'submit', 'reset', 'image'].includes(type)) return 'button';
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'range') return 'slider';
      return 'textbox';
    }
    return hasAttr(element, 'contenteditable') ? 'textbox' : '';
  }

  function ancestor(element, predicate) {
    let current = element;
    const seen = new Set();
    while (current && !seen.has(current)) {
      seen.add(current);
      if (predicate(current)) return current;
      current = safeGet(current, 'parentElement', null) || safeGet(current, 'parentNode', null);
      if (current && !isElement(current)) current = safeGet(current, 'host', null);
    }
    return null;
  }

  function idMap(elements) {
    const map = new Map();
    for (const element of elements) {
      const id = attr(element, 'id', '');
      if (id && !map.has(id)) map.set(id, element);
    }
    return map;
  }

  function accessibleName(element, elements, byId) {
    const aria = attr(element, 'aria-label', '');
    if (aria) return trimText(aria);
    const labelledBy = attr(element, 'aria-labelledby', '');
    if (labelledBy) {
      const value = labelledBy.split(/\s+/).map((id) => byId.get(id)).filter(Boolean).map((item) => textOf(item, 512)).join(' ');
      if (value) return trimText(value);
    }
    const id = attr(element, 'id', '');
    if (id) {
      const label = elements.find((candidate) => tagName(candidate) === 'label' && attr(candidate, 'for', '') === id);
      if (label) return textOf(label, 512);
    }
    const parentLabel = ancestor(element, (candidate) => tagName(candidate) === 'label');
    if (parentLabel) return textOf(parentLabel, 512);
    const tag = tagName(element);
    if (['button', 'a', 'summary'].includes(tag)) return textOf(element, 512);
    return trimText(attr(element, 'placeholder', '') || attr(element, 'title', '') || attr(element, 'name', '') || safeGet(element, 'value', ''));
  }

  function fieldType(element) {
    const tag = tagName(element);
    if (tag === 'textarea') return 'textarea';
    if (tag === 'select') return 'select';
    if (tag === 'button') return (attr(element, 'type', 'submit') || 'submit').toLowerCase();
    if (tag === 'input') return (attr(element, 'type', 'text') || 'text').toLowerCase();
    return attr(element, 'type', '') || '';
  }

  function formRefFor(element, refs) {
    const form = tagName(element) === 'form' ? null : ancestor(element, (candidate) => tagName(candidate) === 'form');
    return form ? refs.get(form) || null : null;
  }

  function liveTargetRecord(element, refs, elements, byId) {
    const role = attr(element, 'role', '').toLowerCase() || implicitRole(element) || null;
    return {
      ref: refs.get(element),
      tagName: tagName(element),
      type: fieldType(element) || null,
      role,
      name: accessibleName(element, elements, byId),
      formRef: formRefFor(element, refs),
    };
  }

  function targetElements(documentRef, ref, maxNodes) {
    if (typeof ref !== 'string' || !ref) throw executionError('ACTION_REF_REQUIRED', 'An exact element ref is required.');
    const elements = collectElements(documentRef, maxNodes);
    const table = refTable(elements);
    const matches = table.reverse.get(ref) || [];
    if (matches.length > 1) throw executionError('ACTION_TARGET_AMBIGUOUS', `Element ref ${ref} resolves to multiple live elements.`, { ref });
    if (matches.length === 1) return { element: matches[0], elements, table };

    // A duplicate id/data/name must never silently resolve to one arbitrary
    // node.  The ref table intentionally falls back to positional refs for
    // duplicates, so report a specific ambiguity if the caller supplied the
    // non-canonical shorthand.
    if (ref.startsWith('id:') && table.counts.id.get(ref.slice(3)) > 1) {
      throw executionError('ACTION_TARGET_AMBIGUOUS', `Element id ${ref.slice(3)} is not unique.`, { ref });
    }
    if (ref.startsWith('name:') && table.counts.name.get(ref.slice(5)) > 1) {
      throw executionError('ACTION_TARGET_AMBIGUOUS', `Element name ${ref.slice(5)} is not unique.`, { ref });
    }
    if (ref.startsWith('data:') && table.counts.data.get(ref.slice(5)) > 1) {
      throw executionError('ACTION_TARGET_AMBIGUOUS', `ToolBraid data ref ${ref.slice(5)} is not unique.`, { ref });
    }
    throw executionError('ACTION_TARGET_NOT_FOUND', `Element ref ${ref} is not present in the live document.`, { ref });
  }

  function normalizeClass(value) {
    if (value === undefined || value === null || value === '') return null;
    const normalized = String(value).trim().toLowerCase().replace(/[\s_]+/g, '-');
    if (['read', 'read-only', 'readonly'].includes(normalized)) return CLASS_READ;
    if (['stage', 'staged', 'prepare', 'preview', 'draft'].includes(normalized)) return CLASS_STAGE;
    if (['mutate', 'mutation', 'write', 'transaction', 'transactional'].includes(normalized)) return CLASS_MUTATE;
    throw executionError('ACTION_CLASS_INVALID', `Unsupported action classification: ${value}.`, { value });
  }

  function classifyLiveTarget(target, request) {
    const explicit = normalizeClass(request.classification ?? request.kind ?? request.actionClass);
    if (explicit) return explicit;
    const operation = String(request.operation ?? '').toLowerCase();
    if (['click', 'submit'].includes(operation)) return CLASS_MUTATE;
    if (['input', 'set', 'select', 'check', 'stage'].includes(operation)) return CLASS_STAGE;
    if (target.tagName === 'form' || target.role === 'button' || ['button', 'submit', 'reset', 'image'].includes(target.type)) return CLASS_MUTATE;
    if (['input', 'textarea', 'select'].includes(target.tagName) || ['checkbox', 'combobox', 'radio', 'slider', 'switch', 'textbox'].includes(target.role)) return CLASS_STAGE;
    return CLASS_READ;
  }

  function documentFrom(request) {
    const documentRef = request.documentRef || request.document || safeGet(global, 'document', null);
    if (!documentRef) throw executionError('PAGE_DOCUMENT_UNAVAILABLE', 'A live document reference is required.');
    return documentRef;
  }

  function snapshotFromExtractor(documentRef, request) {
    const extractor = global.ToolBraidUniversalPageExtractor;
    if (extractor && typeof extractor.extract === 'function') {
      try { return extractor.extract({ documentRef, maxNodes: request.maxNodes, maxElements: request.maxElements, maxItems: request.maxItems }); } catch (error) {
        if (error?.code === 'PAGE_DOCUMENT_UNAVAILABLE') throw error;
      }
    }
    return fallbackLiveSnapshot(documentRef, request);
  }

  function fallbackLiveSnapshot(documentRef, request) {
    const elements = collectElements(documentRef, Number.isInteger(request.maxNodes) ? request.maxNodes : 1024);
    const table = refTable(elements);
    const refs = table.refs;
    const byId = idMap(elements);
    const location = safeGet(documentRef, 'location', null) || safeGet(global, 'location', null) || {};
    const url = String(safeGet(location, 'href', safeGet(documentRef, 'URL', '')) || '');
    let origin = String(safeGet(location, 'origin', '') || '');
    if (!origin && url) { try { origin = new URL(url).origin; } catch { origin = ''; } }
    const metadata = {
      url,
      origin,
      title: trimText(safeGet(documentRef, 'title', '')),
      description: '',
      language: attr(safeGet(documentRef, 'documentElement', null), 'lang', '') || null,
      canonicalUrl: null,
    };
    const headings = elements.filter((element) => /^h[1-6]$/.test(tagName(element))).map((element) => ({ ref: refs.get(element), level: Number(tagName(element).slice(1)), text: textOf(element) }));
    const main = elements.find((element) => tagName(element) === 'main') || elements.find((element) => tagName(element) === 'article') || safeGet(documentRef, 'body', null);
    const mainText = textOf(main, Number.isInteger(request.maxTextCharacters) ? request.maxTextCharacters : 16384);
    const links = elements.filter((element) => tagName(element) === 'a' && attr(element, 'href', null) !== null).map((element) => ({
      ref: refs.get(element), href: attr(element, 'href', ''), text: accessibleName(element, elements, byId), ariaLabel: attr(element, 'aria-label', '') || null, target: attr(element, 'target', '') || null, rel: attr(element, 'rel', '') || null,
    }));
    const controls = elements.filter((element) => ['button', 'input', 'select', 'textarea', 'summary'].includes(tagName(element)) || INTERACTIVE_ROLES.has(attr(element, 'role', '').toLowerCase()));
    const controlRecord = (element) => ({
      ref: refs.get(element), role: attr(element, 'role', '').toLowerCase() || implicitRole(element) || null, name: accessibleName(element, elements, byId), type: fieldType(element) || null, description: null, formRef: formRefFor(element, refs), disabled: Boolean(safeGet(element, 'disabled', false)), required: Boolean(safeGet(element, 'required', false)),
    });
    const accessibleControls = controls.map(controlRecord);
    const forms = elements.filter((element) => tagName(element) === 'form').map((form) => ({ ref: refs.get(form), name: accessibleName(form, elements, byId), action: attr(form, 'action', ''), method: (attr(form, 'method', 'GET') || 'GET').toUpperCase(), encType: attr(form, 'enctype', '') || null, fields: controls.filter((control) => formRefFor(control, refs) === refs.get(form)).map(controlRecord) }));
    const elementRefs = elements.map((element) => liveTargetRecord(element, refs, elements, byId));
    const core = { version: VERSION, metadata, headings, mainText, links, forms, accessibleControls, elementRefs, mediaInventory: [] };
    return { ...core, pageFingerprint: fingerprintPageSnapshot(core) };
  }

  function normalizeJson(value, seen) {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number') return Number.isFinite(value) ? (Object.is(value, -0) ? 0 : value) : null;
    if (!value || typeof value !== 'object') return null;
    const ancestry = seen || new Set();
    if (ancestry.has(value)) throw executionError('SNAPSHOT_VALUE_CYCLE', 'Circular snapshot value.');
    ancestry.add(value);
    try {
      if (Array.isArray(value)) return value.map((entry) => normalizeJson(entry, ancestry));
      if (!isPlain(value)) return null;
      const result = {};
      for (const key of Object.keys(value).sort()) result[key] = normalizeJson(value[key], ancestry);
      return result;
    } finally { ancestry.delete(value); }
  }

  function stableStringify(value) { return JSON.stringify(normalizeJson(value, new Set())); }

  function sha256Hex(value) {
    const extractor = global.ToolBraidUniversalPageExtractor;
    if (extractor && typeof extractor.sha256Hex === 'function') return extractor.sha256Hex(value);
    const text = typeof value === 'string' ? value : stableStringify(value);
    const bytes = typeof TextEncoder === 'function' ? new TextEncoder().encode(text) : [...text].map((char) => char.charCodeAt(0) & 0xff);
    const bitLength = bytes.length * 8;
    const wordCount = (((bytes.length + 9 + 63) >> 6) << 4);
    const words = new Array(wordCount).fill(0);
    for (let index = 0; index < bytes.length; index += 1) words[index >> 2] |= bytes[index] << (24 - (index % 4) * 8);
    words[bytes.length >> 2] |= 0x80 << (24 - (bytes.length % 4) * 8);
    words[wordCount - 2] = Math.floor(bitLength / 0x100000000);
    words[wordCount - 1] = bitLength >>> 0;
    const constants = [
      0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
      0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
      0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
      0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
      0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
      0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
      0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
      0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
    ];
    const hash = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    const rotateRight = (number, amount) => (number >>> amount) | (number << (32 - amount));
    for (let offset = 0; offset < wordCount; offset += 16) {
      const schedule = new Array(64).fill(0);
      for (let index = 0; index < 64; index += 1) {
        if (index < 16) schedule[index] = words[offset + index] | 0;
        else {
          const x = schedule[index - 15]; const y = schedule[index - 2];
          schedule[index] = (schedule[index - 16] + (rotateRight(x, 7) ^ rotateRight(x, 18) ^ (x >>> 3)) + schedule[index - 7] + (rotateRight(y, 17) ^ rotateRight(y, 19) ^ (y >>> 10))) | 0;
        }
      }
      let [a, b, c, d, e, f, g, h] = hash;
      for (let index = 0; index < 64; index += 1) {
        const temp1 = (h + (rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25)) + ((e & f) ^ (~e & g)) + constants[index] + schedule[index]) | 0;
        const temp2 = ((rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
        h = g; g = f; f = e; e = (d + temp1) | 0; d = c; c = b; b = a; a = (temp1 + temp2) | 0;
      }
      hash[0] = (hash[0] + a) | 0; hash[1] = (hash[1] + b) | 0; hash[2] = (hash[2] + c) | 0; hash[3] = (hash[3] + d) | 0;
      hash[4] = (hash[4] + e) | 0; hash[5] = (hash[5] + f) | 0; hash[6] = (hash[6] + g) | 0; hash[7] = (hash[7] + h) | 0;
    }
    return hash.map((number) => (number >>> 0).toString(16).padStart(8, '0')).join('');
  }

  function fingerprintPageSnapshot(snapshot) {
    const core = {
      version: snapshot.version,
      metadata: snapshot.metadata,
      headings: snapshot.headings,
      mainText: snapshot.mainText,
      links: snapshot.links,
      forms: snapshot.forms,
      accessibleControls: snapshot.accessibleControls,
      elementRefs: snapshot.elementRefs,
      mediaInventory: snapshot.mediaInventory,
    };
    return sha256Hex(stableStringify(core));
  }

  function expectedBinding(request) {
    const binding = isPlain(request.binding) ? request.binding : {};
    const target = isPlain(request.target) ? request.target : {};
    const prepared = isPlain(request.preparedAction) ? request.preparedAction : {};
    const preparedTarget = isPlain(prepared.target) ? prepared.target : {};
    const preparedTargetBinding = isPlain(preparedTarget.binding) ? preparedTarget.binding : {};
    const preparedBinding = isPlain(prepared.binding) ? prepared.binding : {};
    const canonicalPageFingerprint = binding.canonicalPageFingerprint
      ?? request.canonicalPageFingerprint
      ?? target.canonicalPageFingerprint
      ?? preparedBinding.canonicalPageFingerprint
      ?? preparedTargetBinding.canonicalPageFingerprint
      ?? prepared.canonicalPageFingerprint
      // A prepared action produced by the privileged universal runtime carries
      // its canonical page fingerprint in `pageFingerprint`.  Keep this
      // separate from the extractor's raw page fingerprint below.
      ?? (prepared.pageFingerprint ?? prepared.provenance?.pageFingerprint ?? null);
    const explicitExtractorFingerprint = binding.extractorFingerprint
      ?? request.extractorFingerprint
      ?? request.extractorPageFingerprint
      ?? target.extractorFingerprint
      ?? preparedBinding.extractorFingerprint
      ?? preparedTargetBinding.extractorFingerprint
      ?? null;
    const legacyPageFingerprint = canonicalPageFingerprint
      ? null
      : binding.pageFingerprint
        ?? request.pageFingerprint
        ?? prepared.pageFingerprint
        ?? prepared.provenance?.pageFingerprint
        ?? null;
    const preparedSemanticType = ['form', 'control', 'element', 'link'].includes(String(preparedTarget.type ?? '').toLowerCase())
      ? undefined
      : preparedTarget.type;
    return {
      canonicalPageFingerprint,
      extractorFingerprint: explicitExtractorFingerprint || legacyPageFingerprint,
      pageFingerprint: legacyPageFingerprint,
      ref: binding.ref ?? binding.elementRef ?? target.ref ?? target.elementRef ?? request.ref ?? request.elementRef ?? request.targetRef ?? preparedTarget.ref ?? preparedTarget.elementRef ?? null,
      role: binding.role ?? target.role ?? preparedBinding.role ?? preparedTargetBinding.role ?? preparedTarget.role,
      name: binding.name ?? target.name ?? preparedBinding.name ?? preparedTargetBinding.name ?? preparedTarget.name,
      formRef: Object.hasOwn(binding, 'formRef')
        ? binding.formRef
        : Object.hasOwn(target, 'formRef')
          ? target.formRef
          : Object.hasOwn(preparedBinding, 'formRef')
            ? preparedBinding.formRef
            : Object.hasOwn(preparedTargetBinding, 'formRef')
              ? preparedTargetBinding.formRef
              : preparedTarget.formRef,
      type: binding.type ?? target.type ?? preparedBinding.type ?? preparedTargetBinding.type ?? preparedSemanticType,
      targetFingerprint: binding.targetFingerprint ?? target.targetFingerprint ?? preparedTarget.targetFingerprint ?? null,
    };
  }

  function assertRequestBindingConsistent(request, binding) {
    const suppliedBinding = isPlain(request.binding) ? request.binding : null;
    const suppliedTarget = isPlain(request.target) ? request.target : null;
    const prepared = isPlain(request.preparedAction) ? request.preparedAction : null;
    const preparedTarget = isPlain(prepared?.target) ? prepared.target : null;
    const preparedTargetBinding = isPlain(preparedTarget?.binding) ? preparedTarget.binding : null;
    const sourcePairs = [];
    if (suppliedBinding && suppliedTarget) {
      sourcePairs.push(['request', suppliedBinding, suppliedTarget]);
    }
    if (suppliedBinding && preparedTarget) {
      sourcePairs.push(['prepared', suppliedBinding, {
        ref: preparedTarget.ref ?? preparedTarget.elementRef,
        role: preparedTargetBinding?.role ?? preparedTarget.role,
        name: preparedTargetBinding?.name ?? preparedTarget.name,
        formRef: Object.hasOwn(preparedTargetBinding || {}, 'formRef') ? preparedTargetBinding.formRef : preparedTarget.formRef,
        type: preparedTargetBinding?.type,
        targetFingerprint: preparedTarget.targetFingerprint,
      }]);
    }
    for (const [source, left, right] of sourcePairs) {
      const pairs = [
        ['ref', left.ref ?? left.elementRef, right.ref ?? right.elementRef],
        ['role', left.role, right.role],
        ['name', left.name, right.name],
        ['formRef', left.formRef, right.formRef],
        ['type', left.type, right.type],
        ['targetFingerprint', left.targetFingerprint, right.targetFingerprint],
      ];
      for (const [field, leftValue, rightValue] of pairs) {
        if (leftValue !== undefined && rightValue !== undefined && leftValue !== rightValue) {
          throw executionError('ACTION_BINDING_MISMATCH', `${source} target ${field} conflicts with its binding.`, { field, binding: leftValue, target: rightValue });
        }
      }
    }
    const preparedFingerprint = prepared?.canonicalPageFingerprint ?? prepared?.pageFingerprint ?? prepared?.provenance?.pageFingerprint;
    if (suppliedBinding?.canonicalPageFingerprint && preparedFingerprint && suppliedBinding.canonicalPageFingerprint !== preparedFingerprint) {
      throw executionError('ACTION_BINDING_MISMATCH', 'The canonical page fingerprint conflicts with the prepared action.', { binding: suppliedBinding.canonicalPageFingerprint, prepared: preparedFingerprint });
    }
  }

  function requireBinding(request, binding, live) {
    if (request.approved !== true) throw executionError('APPROVAL_REQUIRED', 'Mutation execution requires approved: true.');
    const preparedTargetBinding = isPlain(request.preparedAction?.target?.binding)
      ? request.preparedAction.target.binding
      : null;
    const suppliedBinding = isPlain(request.binding)
      ? request.binding
      : isPlain(request.preparedAction?.binding)
        ? request.preparedAction.binding
        : preparedTargetBinding;
    if (!suppliedBinding) throw executionError('ACTION_BINDING_REQUIRED', 'Mutation execution requires an explicit exact binding object.');
    const expectedExtractorFingerprint = binding.extractorFingerprint || binding.pageFingerprint || null;
    if ((!binding.canonicalPageFingerprint && !expectedExtractorFingerprint) || !binding.ref) {
      throw executionError('ACTION_BINDING_REQUIRED', 'Mutation execution requires an exact page fingerprint and element ref.');
    }
    for (const field of ['role', 'name', 'formRef']) {
      if (!Object.hasOwn(suppliedBinding, field)) {
        throw executionError('ACTION_BINDING_REQUIRED', `Mutation binding must include ${field}.`, { field });
      }
    }
    if (expectedExtractorFingerprint && expectedExtractorFingerprint !== live.extractorFingerprint) {
      throw executionError('PAGE_FINGERPRINT_DRIFT', 'The live extractor fingerprint no longer matches the approved binding.', { expected: expectedExtractorFingerprint, actual: live.extractorFingerprint });
    }
    if (binding.ref !== live.target.ref) throw executionError('ACTION_BINDING_MISMATCH', 'The live target ref does not match the approved binding.', { expected: binding.ref, actual: live.target.ref });
    for (const field of ['role', 'name', 'formRef', 'type']) {
      if (binding[field] !== undefined && binding[field] !== live.target[field]) {
        throw executionError('ACTION_BINDING_MISMATCH', `The live target ${field} does not match the approved binding.`, { field, expected: binding[field], actual: live.target[field] });
      }
    }
    // The privileged PageSnapshot target digest and this runtime's live DOM
    // target record are intentionally different projections.  When the
    // service worker has freshly revalidated the canonical page fingerprint,
    // role/name/formRef remain the local semantic binding and the opaque
    // target digest must not be compared across projections.
    const canonicalBindingRevalidated = Boolean(binding.canonicalPageFingerprint);
    if (binding.targetFingerprint && binding.targetFingerprint !== live.targetFingerprint && !canonicalBindingRevalidated) {
      throw executionError('ACTION_TARGET_DRIFT', 'The live target fingerprint no longer matches the approved binding.', { expected: binding.targetFingerprint, actual: live.targetFingerprint });
    }
  }

  function targetDigest(target) {
    return sha256Hex(stableStringify(target));
  }

  function sensitiveField(element) {
    const type = fieldType(element);
    if (type === 'file') return 'file';
    if (type === 'password') return 'password';
    const combined = [attr(element, 'name', ''), attr(element, 'id', ''), attr(element, 'autocomplete', ''), attr(element, 'aria-label', '')].join(' ').toLowerCase();
    if (/(?:cc-|card|cvv|cvc|security.?code|iban|routing|account.?number|payment|paypal|venmo)/i.test(combined)) return 'payment';
    return null;
  }

  function actionArguments(request) {
    const direct = request.arguments ?? request.args ?? request.input;
    const prepared = request.preparedAction?.arguments ?? request.preparedAction?.normalizedArguments;
    if (direct !== undefined && prepared !== undefined && stableStringify(direct) !== stableStringify(prepared)) {
      throw executionError('ACTION_ARGUMENTS_MISMATCH', 'The supplied arguments do not match the approved prepared action.');
    }
    return direct ?? prepared ?? {};
  }

  function argumentValue(request, target, element) {
    const input = actionArguments(request);
    if (!isPlain(input)) throw executionError('ACTION_INPUT_INVALID', 'Action input must be a plain object.');
    if (Object.hasOwn(input, 'value')) return input.value;
    if (Object.hasOwn(input, 'checked')) return input.checked;
    if (Object.hasOwn(input, 'selected')) return input.selected;
    const fieldName = attr(element, 'name', '');
    if (fieldName && Object.hasOwn(input, fieldName)) return input[fieldName];
    const id = attr(element, 'id', '');
    if (id && Object.hasOwn(input, id)) return input[id];
    const keys = Object.keys(input);
    if (keys.length === 1) return input[keys[0]];
    return undefined;
  }

  function eventObject(documentRef, type) {
    const EventCtor = safeGet(documentRef, 'defaultView', null)?.Event || global.Event;
    try {
      if (typeof EventCtor === 'function') return new EventCtor(type, { bubbles: true, cancelable: true });
    } catch { /* fall through to a minimal event for fake DOMs */ }
    return { type, bubbles: true, cancelable: true, isTrusted: false };
  }

  function dispatch(element, documentRef, type, events) {
    if (typeof element?.dispatchEvent !== 'function') throw executionError('DOM_EVENT_UNAVAILABLE', `Target cannot dispatch ${type}.`);
    const event = eventObject(documentRef, type);
    element.dispatchEvent(event);
    events.push(type);
  }

  function normalizedSetValue(element, value) {
    const type = fieldType(element);
    if (type === 'checkbox' || type === 'radio' || targetRole(element) === 'switch') {
      if (typeof value !== 'boolean') throw executionError('ACTION_INPUT_INVALID', 'Checkbox/radio staging requires a boolean checked value.');
      return { property: 'checked', value, kind: 'checked' };
    }
    if (type === 'select') {
      if (Array.isArray(value)) {
        if (!hasAttr(element, 'multiple') && safeGet(element, 'multiple', false) !== true) throw executionError('ACTION_INPUT_INVALID', 'A non-multiple select accepts one value.');
        return { property: 'value', value: value.map(String), kind: 'select-multiple' };
      } else if (typeof value !== 'string' && typeof value !== 'number') {
        throw executionError('ACTION_INPUT_INVALID', 'Select staging requires a string or number value.');
      } else {
        return { property: 'value', value: String(value), kind: 'value' };
      }
    }
    if (typeof value !== 'string' && typeof value !== 'number') throw executionError('ACTION_INPUT_INVALID', 'Input staging requires a string or number value.');
    return { property: 'value', value: String(value), kind: 'value' };
  }

  function setValue(element, value) {
    const normalized = normalizedSetValue(element, value);
    if (normalized.kind === 'checked') {
      try { element.checked = normalized.value; } catch { throw executionError('ACTION_TARGET_READONLY', 'Checkbox target is not writable.'); }
      return { property: normalized.property, value: normalized.value };
    }
    if (normalized.kind === 'select-multiple') {
      const wanted = new Set(normalized.value);
      for (const option of toArray(safeGet(element, 'options', []))) {
        try { option.selected = wanted.has(String(safeGet(option, 'value', ''))); } catch { throw executionError('ACTION_TARGET_READONLY', 'Select target is not writable.'); }
      }
      return { property: normalized.property, value: normalized.value.slice() };
    }
    try { element.value = normalized.value; } catch { throw executionError('ACTION_TARGET_READONLY', 'Input target is not writable.'); }
    return { property: normalized.property, value: normalized.value };
  }

  function targetRole(element) {
    return attr(element, 'role', '').toLowerCase() || implicitRole(element) || '';
  }

  function readValue(element) {
    const sensitive = sensitiveField(element);
    if (sensitive) return { redacted: true, fieldType: sensitive };
    const type = fieldType(element);
    if (type === 'checkbox' || type === 'radio' || targetRole(element) === 'switch') return { checked: Boolean(safeGet(element, 'checked', false)) };
    if (type === 'select') return { value: safeGet(element, 'value', ''), selectedIndex: safeGet(element, 'selectedIndex', -1) };
    return { value: safeGet(element, 'value', null) };
  }

  function operationFor(request, classification, element) {
    const explicit = String(request.operation ?? '').toLowerCase();
    if (explicit) return explicit;
    if (classification === CLASS_READ) return 'read';
    if (classification === CLASS_STAGE) return 'set';
    if (tagName(element) === 'form') return 'submit';
    return 'click';
  }

  function formFor(element) {
    return ancestor(element, (candidate) => tagName(candidate) === 'form');
  }

  function isFormField(element) {
    const tag = tagName(element);
    if (['input', 'select', 'textarea'].includes(tag)) return true;
    const role = targetRole(element);
    return INTERACTIVE_ROLES.has(role) || hasAttr(element, 'contenteditable');
  }

  function formFields(form, elements) {
    return elements.filter((candidate) => candidate !== form && isFormField(candidate) && formFor(candidate) === form);
  }

  function slugFieldName(value, fallback) {
    let result = trimText(value)
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^A-Za-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .toLowerCase();
    if (!result) result = fallback;
    if (/^\d/.test(result)) result = `field_${result}`;
    return result;
  }

  function formFieldPropertyNames(fields, refs, elements, byId) {
    const used = new Set();
    return fields.map((element, index) => {
      const target = liveTargetRecord(element, refs, elements, byId);
      // Match the provider-neutral descriptor's nullish (rather than
      // truthy) field naming rule: an explicitly empty accessible name uses
      // the positional value_N fallback instead of silently switching to an
      // id that was not part of the approved schema.
      const source = target.name ?? attr(element, 'name', '') ?? attr(element, 'id', '') ?? target.ref ?? `value_${index + 1}`;
      const base = slugFieldName(source, `value_${index + 1}`);
      let property = base;
      let suffix = 2;
      while (used.has(property)) property = `${base}_${suffix++}`;
      used.add(property);
      return { element, target, property };
    });
  }

  function aliasMapForFields(fieldRecords) {
    const aliases = new Map();
    const add = (alias, field) => {
      const key = String(alias ?? '');
      if (!key) return;
      const values = aliases.get(key) || [];
      if (!values.includes(field)) values.push(field);
      aliases.set(key, values);
    };
    for (const field of fieldRecords) {
      add(field.property, field);
      add(field.target.name, field);
      add(attr(field.element, 'name', ''), field);
      add(attr(field.element, 'id', ''), field);
      add(field.target.ref, field);
    }
    return aliases;
  }

  function formInputSchema(request) {
    const prepared = isPlain(request.preparedAction) ? request.preparedAction : {};
    const descriptor = isPlain(prepared.descriptor) ? prepared.descriptor : {};
    const schema = request.inputSchema ?? prepared.inputSchema ?? descriptor.inputSchema;
    return isPlain(schema) ? schema : null;
  }

  function schemaValueMatches(value, schema) {
    if (!isPlain(schema) || !schema.type) return true;
    if (schema.type === 'string' && typeof value !== 'string') return false;
    if (schema.type === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) return false;
    if (schema.type === 'integer' && (typeof value !== 'number' || !Number.isInteger(value))) return false;
    if (schema.type === 'boolean' && typeof value !== 'boolean') return false;
    if (schema.type === 'array' && !Array.isArray(value)) return false;
    if (Array.isArray(schema.enum) && !schema.enum.some((candidate) => stableStringify(candidate) === stableStringify(value))) return false;
    return true;
  }

  function captureValue(element) {
    const type = fieldType(element);
    const capture = {
      type,
      value: safeGet(element, 'value', undefined),
      checked: safeGet(element, 'checked', undefined),
    };
    if (type === 'select') {
      capture.options = toArray(safeGet(element, 'options', [])).map((option) => Boolean(safeGet(option, 'selected', false)));
    }
    return capture;
  }

  function restoreValue(element, capture) {
    try {
      if (capture.type === 'checkbox' || capture.type === 'radio' || targetRole(element) === 'switch') {
        if (capture.checked !== undefined) element.checked = capture.checked;
      } else if (capture.type === 'select' && Array.isArray(capture.options)) {
        toArray(safeGet(element, 'options', [])).forEach((option, index) => { option.selected = capture.options[index] === true; });
        if (capture.value !== undefined) element.value = capture.value;
      } else if (capture.value !== undefined) {
        element.value = capture.value;
      }
    } catch { /* best-effort rollback after a failed atomic write */ }
  }

  function resolveFormArgumentPlan(request, form, elements, refs, byId) {
    const input = actionArguments(request);
    if (!isPlain(input)) throw executionError('ACTION_INPUT_INVALID', 'Form action input must be a plain object.');
    const schema = formInputSchema(request);
    const properties = schema && isPlain(schema.properties) ? schema.properties : null;
    if (schema?.additionalProperties === false && !properties) {
      throw executionError('ACTION_SCHEMA_INVALID', 'Form action schema must expose a properties object.');
    }
    if (properties) {
      for (const key of Object.keys(input)) {
        if (!Object.hasOwn(properties, key)) throw executionError('ACTION_FIELD_UNKNOWN', `Form argument ${key} does not map to an approved field.`, { key });
      }
      for (const key of schema.required || []) {
        if (!Object.hasOwn(input, key)) throw executionError('ACTION_FIELD_REQUIRED', `Required form argument ${key} is missing.`, { key });
      }
    }

    const records = formFieldPropertyNames(formFields(form, elements), refs, elements, byId);
    const aliases = aliasMapForFields(records);
    const requiredProperties = new Set((schema?.required || []).map(String));
    for (const record of records) if (safeGet(record.element, 'required', false) === true || hasAttr(record.element, 'required')) requiredProperties.add(record.property);

    // A form mutation may transmit every successful control, not just the
    // fields changed here.  Refuse forms containing credentials, file inputs,
    // or payment identifiers rather than allowing an approved submit to leak
    // one through an otherwise harmless-looking form target.
    for (const record of records) {
      const sensitive = sensitiveField(record.element);
      if (sensitive) throw executionError('SENSITIVE_FIELD_BLOCKED', `${sensitive} fields are not executable through the universal action runtime.`, { fieldType: sensitive, ref: record.target.ref });
    }

    const plan = [];
    for (const [key, value] of Object.entries(input)) {
      const candidates = aliases.get(key) || [];
      if (!candidates.length) throw executionError('ACTION_FIELD_UNKNOWN', `Form argument ${key} does not map to a live field.`, { key });
      if (candidates.length !== 1) throw executionError('ACTION_FIELD_AMBIGUOUS', `Form argument ${key} maps to multiple live fields.`, { key, refs: candidates.map((entry) => entry.target.ref) });
      const field = candidates[0];
      if (properties && !schemaValueMatches(value, properties[key])) throw executionError('ACTION_ARGUMENTS_INVALID', `Form argument ${key} has the wrong type or value.`, { key });
      if (['button', 'submit', 'reset', 'image'].includes(field.target.type) || field.target.role === 'button') {
        throw executionError('ACTION_FIELD_UNSUPPORTED', `Form argument ${key} targets a submit/control button.`, { key, ref: field.target.ref });
      }
      if (safeGet(field.element, 'disabled', false) === true || hasAttr(field.element, 'disabled')) {
        throw executionError('ACTION_TARGET_DISABLED', `Form argument ${key} targets a disabled field.`, { key, ref: field.target.ref });
      }
      const normalized = normalizedSetValue(field.element, value);
      if (typeof field.element?.dispatchEvent !== 'function') throw executionError('DOM_EVENT_UNAVAILABLE', `Field ${key} cannot dispatch native input/change events.`, { key });
      plan.push({ ...field, key, value, normalized });
    }
    for (const key of requiredProperties) {
      if (!Object.hasOwn(input, key)) throw executionError('ACTION_FIELD_REQUIRED', `Required form field ${key} is missing.`, { key });
    }
    return plan;
  }

  function applyFormArguments(request, form, elements, refs, byId, documentRef, events) {
    const plan = resolveFormArgumentPlan(request, form, elements, refs, byId);
    const captures = plan.map((entry) => captureValue(entry.element));
    const changed = [];
    try {
      for (const entry of plan) {
        setValue(entry.element, entry.value);
        dispatch(entry.element, documentRef, 'input', events);
        dispatch(entry.element, documentRef, 'change', events);
        changed.push({
          key: entry.key,
          ref: entry.target.ref,
          name: entry.target.name,
          type: entry.target.type,
          redacted: true,
        });
      }
    } catch (error) {
      plan.forEach((entry, index) => restoreValue(entry.element, captures[index]));
      throw error;
    }
    return changed;
  }

  function executeAction(request = {}) {
    if (!isPlain(request)) throw executionError('ACTION_REQUEST_INVALID', 'Action request must be a plain object.');
    const documentRef = documentFrom(request);
    const maxNodes = Number.isInteger(request.maxNodes) && request.maxNodes > 0 ? request.maxNodes : 1024;
    const binding = expectedBinding(request);
    assertRequestBindingConsistent(request, binding);
    const resolved = targetElements(documentRef, binding.ref, maxNodes);
    const { element, elements, table } = resolved;
    const byId = idMap(elements);
    const liveTarget = liveTargetRecord(element, table.refs, elements, byId);
    const liveSnapshot = snapshotFromExtractor(documentRef, request);
    const liveExtractorFingerprint = liveSnapshot.pageFingerprint || fingerprintPageSnapshot(liveSnapshot);
    const live = {
      extractorFingerprint: liveExtractorFingerprint,
      target: liveTarget,
      targetFingerprint: targetDigest(liveTarget),
    };
    const expectedExtractorFingerprint = binding.extractorFingerprint || binding.pageFingerprint || null;
    if (expectedExtractorFingerprint && expectedExtractorFingerprint !== liveExtractorFingerprint) {
      throw executionError('PAGE_FINGERPRINT_DRIFT', 'The live extractor fingerprint no longer matches the requested action.', { expected: expectedExtractorFingerprint, actual: liveExtractorFingerprint });
    }
    for (const field of ['role', 'name', 'formRef', 'type']) {
      if (binding[field] !== undefined && binding[field] !== liveTarget[field]) {
        throw executionError('ACTION_TARGET_DRIFT', `The live target ${field} changed.`, { field, expected: binding[field], actual: liveTarget[field] });
      }
    }

    const classification = classifyLiveTarget(liveTarget, request);
    const operation = operationFor(request, classification, element);
    const semanticText = `${liveTarget.name} ${liveTarget.role} ${liveTarget.type}`.trim();
    if (DESTRUCTIVE_WORDS.test(semanticText) && !request.operation) {
      throw executionError('DESTRUCTIVE_ACTION_UNKNOWN', 'Destructive action semantics require an explicit classification and operation.');
    }
    const sensitive = sensitiveField(element);
    if (sensitive) throw executionError('SENSITIVE_FIELD_BLOCKED', `${sensitive} fields are not executable through the universal action runtime.`, { fieldType: sensitive });
    if (classification === CLASS_MUTATE) requireBinding(request, binding, live);

    if (classification === CLASS_READ) {
      if (operation !== 'read') throw executionError('ACTION_OPERATION_INVALID', 'Read actions may only use the read operation.');
      return {
        ok: true,
        version: VERSION,
        classification,
        operation,
        ref: liveTarget.ref,
        pageFingerprint: binding.canonicalPageFingerprint || liveExtractorFingerprint,
        canonicalPageFingerprint: binding.canonicalPageFingerprint || null,
        extractorFingerprint: liveExtractorFingerprint,
        target: liveTarget,
        targetFingerprint: live.targetFingerprint,
        value: readValue(element),
        events: [],
      };
    }

    if (classification === CLASS_STAGE) {
      if (!['set', 'input', 'select', 'check', 'stage'].includes(operation)) throw executionError('ACTION_OPERATION_INVALID', 'Stage actions support only set/input/select/check.');
      if (!['input', 'textarea', 'select'].includes(tagName(element)) && !['checkbox', 'radio', 'switch'].includes(liveTarget.role)) {
        throw executionError('ACTION_TARGET_UNSUPPORTED', 'Stage actions require an input, select, textarea, checkbox, or switch target.');
      }
      const value = argumentValue(request, liveTarget, element);
      if (value === undefined) throw executionError('ACTION_INPUT_REQUIRED', 'Stage actions require an exact value or checked argument.');
      const events = [];
      const changed = setValue(element, value);
      dispatch(element, documentRef, 'input', events);
      dispatch(element, documentRef, 'change', events);
      return {
        ok: true,
        version: VERSION,
        classification,
        operation,
        ref: liveTarget.ref,
        pageFingerprint: binding.canonicalPageFingerprint || liveExtractorFingerprint,
        canonicalPageFingerprint: binding.canonicalPageFingerprint || null,
        extractorFingerprint: liveExtractorFingerprint,
        target: liveTarget,
        targetFingerprint: live.targetFingerprint,
        changed,
        events,
        value: readValue(element),
      };
    }

    if (!['click', 'submit', 'set'].includes(operation)) throw executionError('ACTION_OPERATION_INVALID', 'Mutation actions support only click, submit, or an approved value set.');
    const events = [];
    let changed = { operation };
    if (operation === 'set') {
      if (!['input', 'textarea', 'select'].includes(tagName(element)) && !['checkbox', 'combobox', 'radio', 'slider', 'switch', 'textbox'].includes(liveTarget.role)) {
        throw executionError('ACTION_TARGET_UNSUPPORTED', 'Approved value changes require an input, select, textarea, checkbox, or switch target.');
      }
      const value = argumentValue(request, liveTarget, element);
      if (value === undefined) throw executionError('ACTION_INPUT_REQUIRED', 'Approved value changes require an exact value or checked argument.');
      const applied = setValue(element, value);
      dispatch(element, documentRef, 'input', events);
      dispatch(element, documentRef, 'change', events);
      changed = { operation: 'set', property: applied.property, applied: true, value: '[redacted]' };
    } else if (operation === 'click') {
      const input = actionArguments(request);
      if (!isPlain(input) || Object.keys(input).length > 0) {
        throw executionError('ACTION_OPERATION_INVALID', 'Click mutations cannot carry form field arguments.');
      }
      if (typeof element.click === 'function') element.click();
      else dispatch(element, documentRef, 'click', events);
      if (typeof element.click === 'function') events.push('click');
    } else {
      const form = tagName(element) === 'form' ? element : formFor(element);
      if (!form) throw executionError('FORM_REQUIRED', 'Submit actions require a form target or a control inside a form.');
      const changedFields = applyFormArguments(request, form, elements, table.refs, byId, documentRef, events);
      if (typeof form.requestSubmit === 'function') {
        if (element !== form && ['submit', 'image'].includes(fieldType(element))) form.requestSubmit(element);
        else form.requestSubmit();
        events.push('submit');
      } else {
        dispatch(form, documentRef, 'submit', events);
        if (typeof form.submit === 'function') form.submit();
      }
      changed = { fields: changedFields, submit: true };
    }
    return {
      ok: true,
      version: VERSION,
      classification,
      operation,
      ref: liveTarget.ref,
      pageFingerprint: binding.canonicalPageFingerprint || liveExtractorFingerprint,
      canonicalPageFingerprint: binding.canonicalPageFingerprint || null,
      extractorFingerprint: liveExtractorFingerprint,
      target: liveTarget,
      targetFingerprint: live.targetFingerprint,
      changed,
      events,
    };
  }

  function safeExecute(request) {
    try { return executeAction(request); } catch (error) {
      return { ok: false, error: { code: error?.code || 'ACTION_EXECUTION_FAILED', message: error?.message || 'Action execution failed.', details: error?.details || {} } };
    }
  }

  const api = Object.freeze({
    version: VERSION,
    executeAction,
    execute: executeAction,
    safeExecute,
    resolveElement(documentRef, ref, options = {}) {
      const result = targetElements(documentRef || safeGet(global, 'document', null), ref, options.maxNodes || 1024);
      const elements = result.elements;
      const record = liveTargetRecord(result.element, result.table.refs, elements, idMap(elements));
      return { element: result.element, target: record, ref: record.ref };
    },
    fingerprintPageSnapshot,
    error: executionError,
  });
  global.ToolBraidUniversalActionExecutor = api;
  const namespace = isRecord(global.ToolBraidUniversal) && !Object.isFrozen(global.ToolBraidUniversal)
    ? global.ToolBraidUniversal
    : {};
  namespace.actionExecutor = api;
  namespace.ActionExecutor = api;
  namespace.executeAction = executeAction;
  try { global.ToolBraidUniversal = namespace; } catch { /* host namespace may be frozen */ }
}(typeof globalThis !== 'undefined' ? globalThis : this));
