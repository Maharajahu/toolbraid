import { createNonce, ProtocolError } from './protocol.js';

function assertTabId(tabId) {
  if (!Number.isInteger(tabId) || tabId < 0) {
    throw new ProtocolError('TAB_ID_INVALID', 'A non-negative integer tab id is required.', { tabId });
  }
}

function assertFrameId(frameId) {
  if (!Number.isInteger(frameId) || frameId < 0) {
    throw new ProtocolError('FRAME_ID_INVALID', 'A non-negative integer frame id is required.', { frameId });
  }
}

function sessionKey(tabId, frameId) {
  return `${tabId}:${frameId}`;
}

function cloneSession(session) {
  return Object.freeze({ ...session });
}

/**
 * Ephemeral lifecycle registry. Sessions are deliberately kept in memory only:
 * a service-worker restart loses the nonce and forces a fresh page handshake.
 * That prevents a persisted nonce from authorizing a later document.
 */
export class TabLifecycleRegistry {
  #sessions = new Map();

  #sequence = 0;

  #nonceFactory;

  constructor({ nonceFactory = createNonce } = {}) {
    if (typeof nonceFactory !== 'function') throw new TypeError('nonceFactory must be a function.');
    this.#nonceFactory = nonceFactory;
  }

  get(tabId, frameId = 0) {
    assertTabId(tabId);
    assertFrameId(frameId);
    const session = this.#sessions.get(sessionKey(tabId, frameId));
    return session ? cloneSession(session) : null;
  }

  open(tabId, { frameId = 0, documentId = null, pageInstanceId = null, url = null } = {}) {
    assertTabId(tabId);
    assertFrameId(frameId);
    const key = sessionKey(tabId, frameId);
    const previous = this.#sessions.get(key);
    if (previous) this.#sessions.delete(key);
    this.#sequence += 1;
    const nonce = this.#nonceFactory();
    const session = {
      tabId,
      frameId,
      documentId: typeof documentId === 'string' && documentId.length > 0 ? documentId : null,
      pageInstanceId: typeof pageInstanceId === 'string' && pageInstanceId.length > 0 ? pageInstanceId : null,
      url: typeof url === 'string' ? url : null,
      nonce,
      sessionId: `tab-${tabId}-${this.#sequence.toString(36)}-${nonce.slice(0, 12)}`,
      state: 'active',
      createdAt: Date.now(),
    };
    this.#sessions.set(key, session);
    return cloneSession(session);
  }

  /**
   * Accept a content-script hello. A browser document id (or the page-side
   * instance id fallback) is the navigation boundary. Repeated hellos for the
   * same document reuse its nonce; a new document always replaces the old one.
   */
  acceptPageReady(tabId, {
    frameId = 0,
    documentId = null,
    pageInstanceId = null,
    url = null,
  } = {}) {
    assertTabId(tabId);
    assertFrameId(frameId);
    const current = this.#sessions.get(sessionKey(tabId, frameId));
    const currentBoundary = current?.documentId ?? current?.pageInstanceId;
    const nextBoundary = (typeof documentId === 'string' && documentId.length > 0)
      ? documentId
      : (typeof pageInstanceId === 'string' && pageInstanceId.length > 0 ? pageInstanceId : null);
    if (current && currentBoundary && nextBoundary && currentBoundary === nextBoundary) {
      if (typeof url === 'string') current.url = url;
      return { session: cloneSession(current), reused: true };
    }
    return { session: this.open(tabId, { frameId, documentId, pageInstanceId, url }), reused: false };
  }

  invalidate(tabId, reason = 'navigation', frameId = undefined) {
    assertTabId(tabId);
    if (frameId !== undefined) assertFrameId(frameId);
    const invalidated = [];
    for (const [key, session] of this.#sessions.entries()) {
      if (session.tabId !== tabId || (frameId !== undefined && session.frameId !== frameId)) continue;
      this.#sessions.delete(key);
      invalidated.push(Object.freeze({ ...session, state: 'closed', closeReason: reason, closedAt: Date.now() }));
    }
    return Object.freeze(invalidated);
  }

  closeSession(tabId, sessionId, reason = 'closed') {
    assertTabId(tabId);
    if (typeof sessionId !== 'string' || sessionId.length === 0) return null;
    for (const [key, session] of this.#sessions.entries()) {
      if (session.tabId !== tabId || session.sessionId !== sessionId) continue;
      this.#sessions.delete(key);
      return Object.freeze({ ...session, state: 'closed', closeReason: reason, closedAt: Date.now() });
    }
    return null;
  }

  list(tabId = undefined) {
    if (tabId !== undefined) assertTabId(tabId);
    return Object.freeze([...this.#sessions.values()]
      .filter((session) => tabId === undefined || session.tabId === tabId)
      .map(cloneSession));
  }

  clear() {
    const sessions = this.list();
    this.#sessions.clear();
    return sessions;
  }
}

export function sessionBinding(session) {
  if (!session || typeof session !== 'object') throw new TypeError('A session is required.');
  return Object.freeze({
    nonce: session.nonce,
    sessionId: session.sessionId,
    tabId: session.tabId,
    frameId: session.frameId,
  });
}
