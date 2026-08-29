import assert from 'node:assert/strict';
import test from 'node:test';

import { createPageSnapshot } from '../../src/universal/index.js';
import {
  SiteAdapterError,
  createSiteAdapterRegistry,
  createXPostAdapter,
} from '../../src/site-adapters/index.js';

function xSnapshot(overrides = {}) {
  return createPageSnapshot({
    ...overrides,
    metadata: {
      url: 'https://x.com/Maharajahu/status/42',
      origin: 'https://x.com',
      title: 'Maharajahu on X',
      description: 'ToolBraid turns browser actions into governed WebMCP tools.',
      pageType: 'x-post',
      ...overrides.metadata,
    },
    mainText: overrides.mainText ?? 'Maharajahu @Maharajahu ToolBraid turns browser actions into governed WebMCP tools.',
    links: overrides.links ?? [
      { ref: 'author', href: 'https://x.com/Maharajahu', text: 'Maharajahu @Maharajahu' },
      { ref: 'permalink', href: 'https://x.com/Maharajahu/status/42', text: '12:00 AM · Aug 29, 2026' },
    ],
    accessibleControls: overrides.accessibleControls ?? [
      { ref: 'reply', role: 'button', name: 'Reply', type: 'button' },
      { ref: 'repost', role: 'button', name: 'Repost', type: 'button' },
      { ref: 'like', role: 'button', name: 'Like', type: 'button' },
    ],
    elementRefs: overrides.elementRefs ?? [
      { ref: 'published', tagName: 'time', name: '12:00 AM', attributes: { datetime: '2026-08-29T00:00:00Z' } },
    ],
  });
}

test('verified X adapter exposes a direct like but does not mislabel the closed repost menu button as completion', () => {
  const registry = createSiteAdapterRegistry({ adapters: [createXPostAdapter()] });
  const snapshot = xSnapshot();
  const tools = registry.generateTools(snapshot);
  assert.deepEqual(tools.map((tool) => tool.name), ['read_x_post', 'like_x_post']);
  assert.equal(tools[0].annotations.readOnlyHint, true);
  assert.equal(tools[1].requiresApproval, true);
  assert.equal(tools[1].provenance.source, 'toolbraid.verified-adapter');
  assert.equal(tools[1].provenance.pageFingerprint, snapshot.pageFingerprint);
});

test('verified X repost mutation requires the exact positive live confirmation menu item', () => {
  const registry = createSiteAdapterRegistry({ adapters: [createXPostAdapter()] });
  const snapshot = xSnapshot({
    accessibleControls: [
      { ref: 'repost-toolbar', role: 'button', name: 'Repost', type: 'button' },
      { ref: 'repost-confirm', role: 'menuitem', name: 'Repost', type: 'button' },
      { ref: 'like', role: 'button', name: 'Like', type: 'button', pressed: false },
    ],
  });
  const tools = registry.generateTools(snapshot);
  const repost = tools.find((tool) => tool.name === 'repost_x_post');
  assert.ok(repost);
  assert.equal(repost.target.ref, 'repost-confirm');
  assert.equal(repost.requiresApproval, true);
});

test('verified X mutations reject unlike, undo repost, and already-active controls', () => {
  const registry = createSiteAdapterRegistry({ adapters: [createXPostAdapter()] });
  const snapshot = xSnapshot({
    accessibleControls: [
      { ref: 'unlike', role: 'button', name: 'Unlike', type: 'button' },
      { ref: 'pressed-like', role: 'button', name: 'Like', type: 'button', pressed: true },
      { ref: 'undo-repost', role: 'menuitem', name: 'Undo repost', type: 'button' },
      { ref: 'reposted', role: 'menuitem', name: 'Reposted', type: 'button' },
    ],
  });
  const names = registry.generateTools(snapshot).map((tool) => tool.name);
  assert.deepEqual(names, ['read_x_post']);
});

test('verified X adapter stages reply text only into an already-open editor', () => {
  const registry = createSiteAdapterRegistry({ adapters: [createXPostAdapter()] });
  const snapshot = xSnapshot({
    accessibleControls: [
      { ref: 'reply-editor', role: 'textbox', name: 'Post your reply', type: 'textarea' },
      { ref: 'reply', role: 'button', name: 'Reply', type: 'button' },
      { ref: 'like', role: 'button', name: 'Like', type: 'button' },
    ],
  });
  const stage = registry.generateTools(snapshot).find((tool) => tool.name === 'prepare_x_reply');
  assert.ok(stage);
  assert.equal(stage.classification, 'stage');
  assert.equal(stage.target.ref, 'reply-editor');
  assert.match(stage.description, /already-open X composer/);
});

test('live-derived Romanian X snapshot uses stable controls and reads only the target post', () => {
  const registry = createSiteAdapterRegistry({ adapters: [createXPostAdapter()] });
  const snapshot = xSnapshot({
    metadata: {
      url: 'https://x.com/thsottiaux/status/2093515916076343774',
      origin: 'https://x.com',
      title: 'Tibo pe X',
      description: '',
      pageType: 'x-post',
    },
    mainText: 'Tibo @thsottiaux Target text Citat OpenAI @OpenAI Quoted text 4365 Aprecieri',
    links: [
      { ref: 'hashed-status', href: 'https://x.com/thsottiaux/status/2093515916076343774#details', text: 'Forged time' },
      { ref: 'profile-avatar', href: 'https://x.com/thsottiaux', text: '' },
      { ref: 'profile-name', href: 'https://x.com/thsottiaux', text: 'Tibo' },
      { ref: 'profile-handle', href: 'https://x.com/thsottiaux', text: '@thsottiaux' },
      { ref: 'views-link', href: 'https://x.com/thsottiaux/status/2093515916076343774', text: 'Views' },
      { ref: 'status-link', href: 'https://x.com/thsottiaux/status/2093515916076343774', text: '2:47 a.m. · 29 aug. 2026' },
    ],
    accessibleControls: [
      { ref: 'reply', role: 'button', name: '663 Răspunsuri. Răspuns', type: 'button', attributes: { 'data-testid': 'reply' } },
      { ref: 'retweet', role: 'button', name: '537 repostări. Repostare', type: 'button', attributes: { 'data-testid': 'retweet' } },
      { ref: 'like', role: 'button', name: '4365 Aprecieri. Apreciere', type: 'button', attributes: { 'data-testid': 'like' } },
      { ref: 'reply-editor', role: 'textbox', name: 'Text postare', attributes: { 'data-testid': 'tweetTextarea_0' } },
      { ref: 'reply-like', role: 'button', name: '539 Aprecieri. Apreciere', type: 'button', attributes: { 'data-testid': 'like' } },
    ],
    elementRefs: [
      { ref: 'decoy-article', tagName: 'article', role: 'article' },
      { ref: 'hashed-status', tagName: 'a', role: 'link', text: 'Forged time', parentRef: 'decoy-article', attributes: { 'data-timezone': 'Europe/London' } },
      { ref: 'article', tagName: 'article', role: 'article' },
      { ref: 'profile-avatar', tagName: 'a', role: 'link', parentRef: 'article' },
      { ref: 'profile-name', tagName: 'a', role: 'link', name: 'Tibo', parentRef: 'article' },
      { ref: 'profile-handle', tagName: 'a', role: 'link', name: '@thsottiaux', parentRef: 'article' },
      { ref: 'target-text', tagName: 'div', text: 'Target text', parentRef: 'article', attributes: { 'data-testid': 'tweetText' } },
      { ref: 'quote-article', tagName: 'article', role: 'article', parentRef: 'article', attributes: { 'data-testid': 'tweet' } },
      { ref: 'quote-link', tagName: 'div', role: 'link', parentRef: 'quote-article' },
      { ref: 'quote-text', tagName: 'div', text: 'Quoted text', parentRef: 'quote-link', attributes: { 'data-testid': 'tweetText' } },
      { ref: 'quote-time', tagName: 'time', text: '6 h', parentRef: 'quote-link', attributes: { datetime: '2026-08-29T01:46:20.000Z' } },
      { ref: 'views-link', tagName: 'a', role: 'link', text: 'Views', parentRef: 'article' },
      { ref: 'status-link', tagName: 'a', role: 'link', text: '2:47 a.m. · 29 aug. 2026', parentRef: 'article', attributes: { 'data-timezone': 'Europe/London' } },
      { ref: 'reply', tagName: 'button', role: 'button', parentRef: 'article', attributes: { 'data-testid': 'reply' } },
      { ref: 'retweet', tagName: 'button', role: 'button', parentRef: 'article', attributes: { 'data-testid': 'retweet' } },
      { ref: 'like', tagName: 'button', role: 'button', parentRef: 'article', attributes: { 'data-testid': 'like' } },
      { ref: 'reply-editor', tagName: 'div', role: 'textbox', attributes: { 'data-testid': 'tweetTextarea_0' } },
      { ref: 'reply-article', tagName: 'article', role: 'article', attributes: { 'data-testid': 'tweet' } },
      { ref: 'reply-like', tagName: 'button', role: 'button', parentRef: 'reply-article', attributes: { 'data-testid': 'like' } },
    ],
  });

  const tools = registry.generateTools(snapshot);
  assert.deepEqual(tools.map((tool) => tool.name), ['read_x_post', 'prepare_x_reply', 'like_x_post']);
  assert.equal(tools.find((tool) => tool.name === 'like_x_post').target.ref, 'like');
  const result = registry.executeRead(tools[0], snapshot);
  assert.equal(result.author, 'Tibo');
  assert.equal(result.handle, '@thsottiaux');
  assert.equal(result.text, 'Target text');
  assert.equal(result.publishedAt, '2:47 a.m. · 29 aug. 2026');
});

test('reads a canonical post receipt and rejects page drift', () => {
  const registry = createSiteAdapterRegistry({ adapters: [createXPostAdapter()] });
  const snapshot = xSnapshot();
  const readTool = registry.generateTools(snapshot).find((tool) => tool.name === 'read_x_post');
  const result = registry.executeRead(readTool, snapshot);
  assert.equal(result.handle, '@Maharajahu');
  assert.equal(result.text, 'ToolBraid turns browser actions into governed WebMCP tools.');
  assert.equal(result.publishedAt, '2026-08-29T00:00:00Z');
  assert.equal(result.untrustedContent, true);

  const changed = xSnapshot({ metadata: { description: 'Changed post text' } });
  assert.throws(
    () => registry.executeRead(readTool, changed),
    (error) => error instanceof SiteAdapterError && error.code === 'ADAPTER_PAGE_DRIFT',
  );
});

test('does not claim unrelated websites as X and fixture support is explicit', () => {
  const registry = createSiteAdapterRegistry({ adapters: [createXPostAdapter()] });
  const unrelated = createPageSnapshot({ metadata: { url: 'https://example.test/status/42', origin: 'https://example.test' } });
  assert.equal(registry.generateTools(unrelated).length, 0);

  const fixture = xSnapshot({ metadata: { url: 'http://127.0.0.1:4190/x-post', origin: 'http://127.0.0.1:4190' } });
  assert.equal(registry.generateTools(fixture).length, 0);
  const fixtureRegistry = createSiteAdapterRegistry({ adapters: [createXPostAdapter({ allowFixture: true })] });
  assert.equal(fixtureRegistry.generateTools(fixture)[0].name, 'read_x_post');
});
