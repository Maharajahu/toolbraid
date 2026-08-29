/*
 * ToolBraid Universal page extractor.
 *
 * This file is intentionally a classic script: Chrome's
 * chrome.scripting.executeScript({ files: [...] }) does not resolve ES module
 * imports in an injected page function.  It has no extension permissions and
 * never mutates the document.  The API is exposed through
 * globalThis.ToolBraidUniversalPageExtractor and the namespaced
 * globalThis.ToolBraidUniversal.pageExtractor object.
 */
(function installToolBraidPageExtractor(global) {
  if (!global || global.ToolBraidUniversalPageExtractor) return;

  const VERSION = 1;
  const DEFAULTS = Object.freeze({
    maxNodes: 512,
    maxElements: 384,
    maxItems: 256,
    maxTextCharacters: 16_384,
    maxShadowDepth: 4,
  });

  function extractorError(code, message, details) {
    const error = new Error(message);
    error.name = 'ToolBraidPageExtractorError';
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
    return prototype === Object.prototype || prototype === null;
  }

  function finiteNumber(value) {
    return typeof value === 'number' && Number.isFinite(value);
  }

  function integerOption(value, fallback) {
    const result = Number(value);
    return Number.isInteger(result) && result > 0 ? result : fallback;
  }

  function normalizeOptions(options) {
    const source = isRecord(options) ? options : {};
    return {
      maxNodes: integerOption(source.maxNodes, DEFAULTS.maxNodes),
      maxElements: integerOption(source.maxElements, DEFAULTS.maxElements),
      maxItems: integerOption(source.maxItems, DEFAULTS.maxItems),
      maxTextCharacters: integerOption(source.maxTextCharacters, DEFAULTS.maxTextCharacters),
      maxShadowDepth: integerOption(source.maxShadowDepth, DEFAULTS.maxShadowDepth),
    };
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
    const value = safeCall(element, 'hasAttribute', [name], null);
    if (value !== null) return value === true;
    return attr(element, name, null) !== null;
  }

  function trimText(value) {
    return String(value ?? '').replace(/\s+/g, ' ').trim();
  }

  function boundedText(value, limit) {
    const text = trimText(value);
    return text.length > limit ? text.slice(0, limit) : text;
  }

  function tagName(element) {
    return String(safeGet(element, 'localName', safeGet(element, 'tagName', '')) || '').toLowerCase();
  }

  function isElement(value) {
    return Boolean(value && (value.nodeType === 1 || typeof value.tagName === 'string' || typeof value.localName === 'string'));
  }

  function isTextNode(value) {
    return Boolean(value && value.nodeType === 3);
  }

  function isHidden(element) {
    if (!isElement(element)) return false;
    if (safeGet(element, 'hidden', false) === true) return true;
    return attr(element, 'aria-hidden', '') === 'true';
  }

  function childNodes(element) {
    const children = safeGet(element, 'children', null);
    if (children && typeof children.length === 'number') return toArray(children);
    return toArray(safeGet(element, 'childNodes', []));
  }

  function openShadowRoot(element) {
    const root = safeGet(element, 'shadowRoot', null);
    if (!root) return null;
    // Closed roots are not exposed through shadowRoot.  When a fake DOM gives
    // us a mode property, honor it so tests model the browser boundary.
    const mode = safeGet(root, 'mode', 'open');
    return mode === 'closed' ? null : root;
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

  function traverseDocument(documentRef, options) {
    const elements = [];
    const seen = new Set();
    let nodesVisited = 0;
    let shadowRootsVisited = 0;
    let truncated = false;
    const queue = semanticRoots(documentRef).map((node) => ({ node, shadowDepth: 0 }));

    const visit = (node, shadowDepth) => {
      if (!node || seen.has(node)) return;
      if (nodesVisited >= options.maxNodes) {
        truncated = true;
        return;
      }
      seen.add(node);
      nodesVisited += 1;
      if (isElement(node)) elements.push(node);

      for (const child of childNodes(node)) visit(child, shadowDepth);
      const root = isElement(node) ? openShadowRoot(node) : null;
      if (root && shadowDepth < options.maxShadowDepth) {
        shadowRootsVisited += 1;
        for (const child of childNodes(root)) visit(child, shadowDepth + 1);
      } else if (root) {
        truncated = true;
      }
    };
    while (queue.length) {
      const item = queue.shift();
      visit(item.node, item.shadowDepth);
    }

    // Minimal/fake DOMs sometimes expose querySelectorAll without a connected
    // documentElement tree.  Use it only to fill the traversal, never to
    // bypass the node bound.
    if (elements.length === 0 && typeof documentRef?.querySelectorAll === 'function') {
      for (const node of toArray(safeCall(documentRef, 'querySelectorAll', ['*'], []))) {
        if (nodesVisited >= options.maxNodes) {
          truncated = true;
          break;
        }
        if (isElement(node) && !seen.has(node)) {
          seen.add(node);
          nodesVisited += 1;
          elements.push(node);
        }
      }
    }
    return { elements, nodesVisited, shadowRootsVisited, truncated };
  }

  function normalizeJson(value, path, seen) {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number') return finiteNumber(value) ? (Object.is(value, -0) ? 0 : value) : null;
    if (!value || typeof value !== 'object') return null;
    const ancestry = seen || new Set();
    if (ancestry.has(value)) throw extractorError('SNAPSHOT_VALUE_CYCLE', `Circular value at ${path || '$'}.`);
    ancestry.add(value);
    try {
      if (Array.isArray(value)) return value.map((entry, index) => normalizeJson(entry, `${path || '$'}[${index}]`, ancestry));
      if (!isPlain(value)) return null;
      const result = {};
      for (const key of Object.keys(value).sort()) result[key] = normalizeJson(value[key], `${path || '$'}.${key}`, ancestry);
      return result;
    } finally {
      ancestry.delete(value);
    }
  }

  function stableStringify(value) {
    return JSON.stringify(normalizeJson(value, '$', new Set()));
  }

  function encodeUtf8(value) {
    if (typeof global.TextEncoder === 'function') return new global.TextEncoder().encode(value);
    const encoded = unescape(encodeURIComponent(value));
    const bytes = new Array(encoded.length);
    for (let index = 0; index < encoded.length; index += 1) bytes[index] = encoded.charCodeAt(index);
    return bytes;
  }

  // Synchronous SHA-256 keeps extraction available in a page world without
  // relying on asynchronous crypto.subtle or a bundled dependency.
  function sha256Hex(value) {
    const text = typeof value === 'string' ? value : stableStringify(value);
    const bytes = encodeUtf8(text);
    const bitLength = bytes.length * 8;
    const wordCount = (((bytes.length + 9 + 63) >> 6) << 4);
    const words = new Array(wordCount).fill(0);
    for (let index = 0; index < bytes.length; index += 1) {
      words[index >> 2] |= bytes[index] << (24 - (index % 4) * 8);
    }
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
    const hash = [
      0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
      0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
    ];
    const rotateRight = (number, amount) => (number >>> amount) | (number << (32 - amount));
    for (let offset = 0; offset < wordCount; offset += 16) {
      const schedule = new Array(64).fill(0);
      for (let index = 0; index < 64; index += 1) {
        if (index < 16) schedule[index] = words[offset + index] | 0;
        else {
          const x = schedule[index - 15];
          const y = schedule[index - 2];
          const sigma0 = rotateRight(x, 7) ^ rotateRight(x, 18) ^ (x >>> 3);
          const sigma1 = rotateRight(y, 17) ^ rotateRight(y, 19) ^ (y >>> 10);
          schedule[index] = (schedule[index - 16] + sigma0 + schedule[index - 7] + sigma1) | 0;
        }
      }
      let [a, b, c, d, e, f, g, h] = hash;
      for (let index = 0; index < 64; index += 1) {
        const bigSigma1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
        const choice = (e & f) ^ (~e & g);
        const temp1 = (h + bigSigma1 + choice + constants[index] + schedule[index]) | 0;
        const bigSigma0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
        const majority = (a & b) ^ (a & c) ^ (b & c);
        const temp2 = (bigSigma0 + majority) | 0;
        h = g;
        g = f;
        f = e;
        e = (d + temp1) | 0;
        d = c;
        c = b;
        b = a;
        a = (temp1 + temp2) | 0;
      }
      hash[0] = (hash[0] + a) | 0;
      hash[1] = (hash[1] + b) | 0;
      hash[2] = (hash[2] + c) | 0;
      hash[3] = (hash[3] + d) | 0;
      hash[4] = (hash[4] + e) | 0;
      hash[5] = (hash[5] + f) | 0;
      hash[6] = (hash[6] + g) | 0;
      hash[7] = (hash[7] + h) | 0;
    }
    return hash.map((number) => (number >>> 0).toString(16).padStart(8, '0')).join('');
  }

  function pageCore(snapshot) {
    return {
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
  }

  function fingerprintPageSnapshot(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') throw extractorError('SNAPSHOT_REQUIRED', 'A page snapshot object is required.');
    return sha256Hex(stableStringify(pageCore(snapshot)));
  }

  function locationFor(documentRef, options) {
    const location = options.locationRef || safeGet(documentRef, 'location', null) || safeGet(global, 'location', null) || {};
    const url = String(safeGet(location, 'href', safeGet(documentRef, 'URL', '')) || '');
    let origin = String(safeGet(location, 'origin', '') || '');
    if (!origin && url) {
      try { origin = new URL(url).origin; } catch { origin = ''; }
    }
    return { url, origin };
  }

  function absoluteUrl(value, baseUrl) {
    const raw = String(value ?? '').trim();
    if (!raw) return '';
    try { return new URL(raw, baseUrl || undefined).href; } catch { return raw; }
  }

  function idMap(elements) {
    const map = new Map();
    for (const element of elements) {
      const id = attr(element, 'id', '');
      if (id && !map.has(id)) map.set(id, element);
    }
    return map;
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

  function elementCounts(elements) {
    const counts = { ids: new Map(), names: new Map(), dataRefs: new Map() };
    for (const element of elements) {
      const id = attr(element, 'id', '');
      const name = attr(element, 'name', '');
      const dataRef = attr(element, 'data-toolbraid-ref', '');
      if (id) counts.ids.set(id, (counts.ids.get(id) || 0) + 1);
      if (name) counts.names.set(name, (counts.names.get(name) || 0) + 1);
      if (dataRef) counts.dataRefs.set(dataRef, (counts.dataRefs.get(dataRef) || 0) + 1);
    }
    return counts;
  }

  function refTable(elements) {
    const counts = elementCounts(elements);
    const refs = new Map();
    const reverse = new Map();
    elements.forEach((element, index) => {
      const dataRef = attr(element, 'data-toolbraid-ref', '');
      const id = attr(element, 'id', '');
      const name = attr(element, 'name', '');
      let ref = '';
      if (dataRef && counts.dataRefs.get(dataRef) === 1) ref = `data:${dataRef}`;
      else if (id && counts.ids.get(id) === 1) ref = `id:${id}`;
      else if (name && counts.names.get(name) === 1) ref = `name:${name}`;
      else ref = `el-${index + 1}`;
      refs.set(element, ref);
      if (!reverse.has(ref)) reverse.set(ref, []);
      reverse.get(ref).push(element);
    });
    return { refs, reverse };
  }

  function implicitRole(element) {
    const tag = tagName(element);
    if (tag === 'a' && attr(element, 'href', null) !== null) return 'link';
    if (tag === 'button') return 'button';
    if (tag === 'form') return 'form';
    if (/^h[1-6]$/.test(tag)) return 'heading';
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
    if (hasAttr(element, 'contenteditable')) return 'textbox';
    return '';
  }

  function accessibleName(element, elements, byId) {
    const ariaLabel = attr(element, 'aria-label', '');
    if (ariaLabel) return trimText(ariaLabel);
    const labelledBy = attr(element, 'aria-labelledby', '');
    if (labelledBy) {
      const labels = labelledBy.split(/\s+/).map((id) => byId.get(id)).filter(Boolean).map((node) => nodeText(node, { includeShadow: false, max: 512 }));
      if (labels.length) return trimText(labels.join(' '));
    }
    const id = attr(element, 'id', '');
    if (id) {
      const label = elements.find((candidate) => tagName(candidate) === 'label' && attr(candidate, 'for', '') === id);
      if (label) return nodeText(label, { includeShadow: false, max: 512 });
    }
    const parentLabel = ancestor(element, (candidate) => tagName(candidate) === 'label');
    if (parentLabel) {
      const value = nodeText(parentLabel, { includeShadow: false, max: 512 });
      if (value) return value;
    }
    const tag = tagName(element);
    if (tag === 'img') return trimText(attr(element, 'alt', '') || attr(element, 'title', ''));
    if (['button', 'a', 'summary'].includes(tag)) return nodeText(element, { includeShadow: false, max: 512 });
    return trimText(attr(element, 'placeholder', '') || attr(element, 'title', '') || attr(element, 'name', '') || safeGet(element, 'value', ''));
  }

  function nodeText(node, { includeShadow = true, max = 16_384 } = {}, state) {
    if (!node || max <= 0) return '';
    if (isTextNode(node)) return boundedText(safeGet(node, 'nodeValue', ''), max);
    if (!isElement(node)) return '';
    const tag = tagName(node);
    if (['script', 'style', 'noscript', 'template', 'svg', 'canvas'].includes(tag) || isHidden(node)) return '';
    const parts = [];
    let length = 0;
    const append = (value) => {
      const text = trimText(value);
      if (!text || length >= max) return;
      const remaining = max - length;
      parts.push(text.slice(0, remaining));
      length += Math.min(remaining, text.length);
    };
    const children = childNodes(node);
    for (const child of children) {
      if (length >= max) break;
      append(nodeText(child, { includeShadow, max: max - length }, state));
    }
    if (includeShadow) {
      const root = openShadowRoot(node);
      if (root && length < max) {
        for (const child of childNodes(root)) {
          if (length >= max) break;
          append(nodeText(child, { includeShadow, max: max - length }, state));
        }
      }
    }
    if (parts.length) return trimText(parts.join(' '));
    const own = safeGet(node, 'innerText', safeGet(node, 'textContent', ''));
    return boundedText(own, max);
  }

  function fieldType(element) {
    const tag = tagName(element);
    if (tag === 'textarea') return 'textarea';
    if (tag === 'select') return 'select';
    if (tag === 'button') return (attr(element, 'type', 'submit') || 'submit').toLowerCase();
    if (tag === 'input') return (attr(element, 'type', 'text') || 'text').toLowerCase();
    return attr(element, 'type', '') || '';
  }

  function isControl(element) {
    const tag = tagName(element);
    if (['button', 'input', 'select', 'textarea', 'summary'].includes(tag)) return true;
    const role = attr(element, 'role', '').toLowerCase();
    if (['button', 'checkbox', 'combobox', 'link', 'menuitem', 'radio', 'slider', 'switch', 'tab', 'textbox'].includes(role)) return true;
    return hasAttr(element, 'contenteditable');
  }

  function isPaymentField(element) {
    const combined = [attr(element, 'name', ''), attr(element, 'id', ''), attr(element, 'autocomplete', ''), attr(element, 'aria-label', '')].join(' ').toLowerCase();
    return /(?:cc-|card|cvv|cvc|security.?code|iban|routing|account.?number|payment|paypal|venmo)/i.test(combined);
  }

  function safeValue(element) {
    const type = fieldType(element);
    if (type === 'password' || type === 'file' || isPaymentField(element)) return undefined;
    const value = safeGet(element, 'value', undefined);
    return value === undefined || value === null ? undefined : String(value);
  }

  function formFor(element, refs) {
    const form = ancestor(element, (candidate) => tagName(candidate) === 'form');
    return form ? refs.get(form) || null : null;
  }

  function optionsForSelect(element, limit) {
    const result = [];
    for (const option of toArray(safeGet(element, 'options', []))) {
      if (result.length >= limit) break;
      result.push({
        label: trimText(safeGet(option, 'text', safeGet(option, 'label', safeGet(option, 'textContent', '')))),
        value: String(safeGet(option, 'value', '')),
        disabled: Boolean(safeGet(option, 'disabled', false)),
      });
    }
    if (!result.length) {
      for (const option of childNodes(element)) {
        if (tagName(option) !== 'option' || result.length >= limit) continue;
        result.push({ label: nodeText(option, { includeShadow: false, max: 256 }), value: attr(option, 'value', '') });
      }
    }
    return result;
  }

  function controlRecord(element, refs, elements, byId, options) {
    const type = fieldType(element);
    const role = attr(element, 'role', '').toLowerCase() || implicitRole(element) || null;
    const record = {
      ref: refs.get(element),
      role,
      name: accessibleName(element, elements, byId),
      type: type || null,
      description: attr(element, 'aria-description', '') || attr(element, 'title', '') || null,
      formRef: formFor(element, refs),
      disabled: Boolean(safeGet(element, 'disabled', false)) || hasAttr(element, 'disabled'),
      required: Boolean(safeGet(element, 'required', false)) || hasAttr(element, 'required') || attr(element, 'aria-required', '') === 'true',
    };
    const value = safeValue(element);
    if (value !== undefined) record.value = value;
    if (type === 'checkbox' || type === 'radio' || role === 'switch') record.checked = Boolean(safeGet(element, 'checked', false));
    const expanded = attr(element, 'aria-expanded', null);
    if (expanded !== null) record.expanded = expanded === 'true';
    const pressed = attr(element, 'aria-pressed', null);
    if (pressed !== null) record.pressed = pressed === 'true';
    const testId = trimText(attr(element, 'data-testid', '')).slice(0, 128);
    if (testId) record.attributes = { 'data-testid': testId };
    if (tagName(element) === 'select') record.options = optionsForSelect(element, options.maxItems);
    return record;
  }

  function elementRecord(element, refs, elements, byId, options) {
    const role = attr(element, 'role', '').toLowerCase() || implicitRole(element) || null;
    const record = {
      ref: refs.get(element),
      tagName: tagName(element),
      role,
      name: accessibleName(element, elements, byId),
      locator: attr(element, 'id', '') ? `#${attr(element, 'id', '')}` : refs.get(element),
      parentRef: refs.get(safeGet(element, 'parentElement', null)) || null,
    };
    const attributes = {};
    const testId = trimText(attr(element, 'data-testid', '')).slice(0, 128);
    const datetime = trimText(attr(element, 'datetime', '')).slice(0, 128);
    const timezone = trimText(attr(element, 'data-timezone', '')).slice(0, 128);
    if (testId) attributes['data-testid'] = testId;
    if (datetime) attributes.datetime = datetime;
    if (timezone) attributes['data-timezone'] = timezone;
    if (Object.keys(attributes).length) record.attributes = attributes;
    const textLimit = testId === 'tweetText' ? options.maxTextCharacters : 512;
    const text = nodeText(element, { includeShadow: false, max: textLimit });
    if (text) record.text = text;
    return record;
  }

  function mediaRecord(element, refs, baseUrl, options) {
    const tag = tagName(element);
    const kind = tag === 'img' ? 'image' : tag;
    const record = {
      ref: refs.get(element),
      kind,
      src: absoluteUrl(safeGet(element, 'currentSrc', '') || attr(element, 'src', ''), baseUrl),
      alt: trimText(attr(element, 'alt', '') || attr(element, 'aria-label', '')),
    };
    if (tag === 'audio' || tag === 'video') {
      const sources = [];
      for (const child of childNodes(element)) {
        if (tagName(child) !== 'source' || sources.length >= options.maxItems) continue;
        sources.push({ src: absoluteUrl(attr(child, 'src', ''), baseUrl), type: attr(child, 'type', '') });
      }
      if (sources.length) record.sources = sources;
      const tracks = [];
      for (const child of childNodes(element)) {
        if (tagName(child) !== 'track' || tracks.length >= options.maxItems) continue;
        tracks.push({
          kind: attr(child, 'kind', ''),
          src: absoluteUrl(attr(child, 'src', ''), baseUrl),
          srclang: attr(child, 'srclang', ''),
          label: attr(child, 'label', ''),
        });
      }
      if (tracks.length) record.tracks = tracks;
      const poster = attr(element, 'poster', '');
      if (poster) record.poster = absoluteUrl(poster, baseUrl);
      record.controls = Boolean(safeGet(element, 'controls', false)) || hasAttr(element, 'controls');
      const duration = Number(safeGet(element, 'duration', NaN));
      if (finiteNumber(duration)) record.duration = duration;
    } else {
      const width = Number(safeGet(element, 'naturalWidth', safeGet(element, 'width', NaN)));
      const height = Number(safeGet(element, 'naturalHeight', safeGet(element, 'height', NaN)));
      if (finiteNumber(width)) record.width = width;
      if (finiteNumber(height)) record.height = height;
    }
    const caption = ancestor(element, (candidate) => tagName(candidate) === 'figure');
    if (caption) {
      const figcaption = childNodes(caption).find((candidate) => tagName(candidate) === 'figcaption');
      if (figcaption) record.caption = nodeText(figcaption, { includeShadow: false, max: 512 });
    }
    return record;
  }

  function extract(input) {
    const inputIsDocument = input && (input.nodeType === 9 || typeof input.querySelectorAll === 'function' || input.documentElement);
    const source = inputIsDocument ? { documentRef: input } : (isRecord(input) ? input : {});
    const documentRef = source.documentRef || source.document || safeGet(global, 'document', null);
    if (!documentRef) throw extractorError('PAGE_DOCUMENT_UNAVAILABLE', 'A document reference is required for page extraction.');
    const options = normalizeOptions(source);
    const location = locationFor(documentRef, source);
    const traversal = traverseDocument(documentRef, options);
    const elements = traversal.elements;
    const byId = idMap(elements);
    const { refs, reverse } = refTable(elements);
    const limitedElements = elements.slice(0, options.maxElements);
    if (elements.length > options.maxElements) traversal.truncated = true;
    const items = (values) => values.slice(0, options.maxItems);
    const metadata = {
      url: location.url,
      origin: location.origin,
      title: trimText(safeGet(documentRef, 'title', '') || elements.find((element) => tagName(element) === 'title') && nodeText(elements.find((element) => tagName(element) === 'title'), { includeShadow: false, max: 512 })),
      description: trimText(elements.find((element) => tagName(element) === 'meta' && attr(element, 'name', '').toLowerCase() === 'description') ? attr(elements.find((element) => tagName(element) === 'meta' && attr(element, 'name', '').toLowerCase() === 'description'), 'content', '') : ''),
      language: attr(safeGet(documentRef, 'documentElement', null), 'lang', '') || null,
      canonicalUrl: (() => {
        const canonical = elements.find((element) => tagName(element) === 'link' && attr(element, 'rel', '').toLowerCase().split(/\s+/).includes('canonical'));
        return canonical ? absoluteUrl(attr(canonical, 'href', ''), location.url) : null;
      })(),
    };

    const headings = [];
    for (const element of items(limitedElements.filter((candidate) => /^h[1-6]$/.test(tagName(candidate)) || (attr(candidate, 'role', '').toLowerCase() === 'heading' && attr(candidate, 'aria-level', ''))))) {
      const tag = tagName(element);
      const level = /^h[1-6]$/.test(tag) ? Number(tag.slice(1)) : Math.max(1, Math.min(6, Number(attr(element, 'aria-level', '1')) || 1));
      headings.push({ ref: refs.get(element), level, text: nodeText(element, { includeShadow: false, max: 1024 }) });
    }

    const main = elements.find((element) => tagName(element) === 'main')
      || elements.find((element) => tagName(element) === 'article')
      || safeGet(documentRef, 'body', null)
      || safeGet(documentRef, 'documentElement', null);
    const mainText = boundedText(main ? nodeText(main, { includeShadow: true, max: options.maxTextCharacters }) : '', options.maxTextCharacters);

    const links = [];
    for (const element of items(limitedElements.filter((candidate) => tagName(candidate) === 'a' && attr(candidate, 'href', null) !== null))) {
      links.push({
        ref: refs.get(element),
        href: absoluteUrl(attr(element, 'href', ''), location.url),
        text: accessibleName(element, elements, byId),
        ariaLabel: attr(element, 'aria-label', '') || null,
        target: attr(element, 'target', '') || null,
        rel: attr(element, 'rel', '') || null,
        ...(hasAttr(element, 'download') ? { download: true } : {}),
      });
    }

    const controls = limitedElements.filter(isControl).filter((element) => !isHidden(element));
    const accessibleControls = items(controls.map((element) => controlRecord(element, refs, elements, byId, options)));
    const forms = [];
    for (const form of items(limitedElements.filter((candidate) => tagName(candidate) === 'form'))) {
      const fields = controls
        .filter((control) => formFor(control, refs) === refs.get(form))
        .slice(0, options.maxItems)
        .map((control) => controlRecord(control, refs, elements, byId, options));
      forms.push({
        ref: refs.get(form),
        name: accessibleName(form, elements, byId),
        action: absoluteUrl(attr(form, 'action', ''), location.url),
        method: (attr(form, 'method', 'GET') || 'GET').toUpperCase(),
        encType: attr(form, 'enctype', '') || null,
        fields,
      });
    }

    const elementRefs = items(limitedElements.map((element) => elementRecord(element, refs, elements, byId, options)));
    const mediaInventory = items(limitedElements
      .filter((element) => ['img', 'audio', 'video'].includes(tagName(element)))
      .map((element) => mediaRecord(element, refs, location.url, options)));
    const core = {
      version: VERSION,
      metadata,
      headings,
      mainText,
      links,
      forms,
      accessibleControls,
      elementRefs,
      mediaInventory,
    };
    const snapshot = {
      ...core,
      pageFingerprint: fingerprintPageSnapshot(core),
      stats: {
        nodesVisited: traversal.nodesVisited,
        elementsCollected: elements.length,
        headings: headings.length,
        links: links.length,
        forms: forms.length,
        controls: accessibleControls.length,
        media: mediaInventory.length,
        shadowRootsVisited: traversal.shadowRootsVisited,
        truncated: traversal.truncated || elements.length > options.maxElements,
        limits: { ...options },
      },
    };
    // `reverse` is intentionally used only to retain the duplicate-ref proof
    // in diagnostics during development; no DOM object crosses the wire.
    snapshot.stats.duplicateRefs = [...reverse.entries()].filter(([, values]) => values.length > 1).map(([ref]) => ref);
    return snapshot;
  }

  function stableElementRef(documentRef, element, options) {
    const traversal = traverseDocument(documentRef || safeGet(global, 'document', null), normalizeOptions(options));
    const table = refTable(traversal.elements);
    return table.refs.get(element) || null;
  }

  const api = Object.freeze({
    version: VERSION,
    defaults: DEFAULTS,
    extract,
    extractPageSnapshot: extract,
    fingerprintPageSnapshot,
    stableStringify,
    sha256Hex,
    getStableElementRef: stableElementRef,
    error(code, message, details) { return extractorError(code, message, details); },
  });
  global.ToolBraidUniversalPageExtractor = api;
  const namespace = isRecord(global.ToolBraidUniversal) && !Object.isFrozen(global.ToolBraidUniversal)
    ? global.ToolBraidUniversal
    : {};
  namespace.pageExtractor = api;
  namespace.PageExtractor = api;
  namespace.extractPageSnapshot = extract;
  namespace.fingerprintPageSnapshot = fingerprintPageSnapshot;
  try { global.ToolBraidUniversal = namespace; } catch { /* a host may expose a frozen namespace */ }
}(typeof globalThis !== 'undefined' ? globalThis : this));
