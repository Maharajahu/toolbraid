import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { createPageSnapshot, generateWebMcpToolDescriptors, prepareAction } from '../../src/universal/index.js';
import {
  SiteAdapterError,
  createGitHubAdapter,
  createSiteAdapterRegistry,
  extractGitHubPage,
  parseGitHubRoute,
} from '../../src/site-adapters/index.js';

const FIXTURE_ROOT = new URL('../../fixtures/universal/', import.meta.url);

async function fixture(name) {
  const text = await readFile(new URL(name, FIXTURE_ROOT), 'utf8');
  return createPageSnapshot(JSON.parse(text));
}

function urlSnapshot(url, extra = {}) {
  return createPageSnapshot({
    metadata: { url, origin: (() => { try { return new URL(url).origin; } catch { return ''; } })(), ...extra.metadata },
    headings: extra.headings ?? [],
    mainText: extra.mainText ?? '',
    links: extra.links ?? [],
    forms: [],
    accessibleControls: [],
    elementRefs: [],
  });
}

test('GitHub adapter recognizes exact repository, commit, issue, and pull-request routes', async () => {
  const cases = [
    ['github-repository.snapshot.json', 'repository', 'read_github_repository'],
    ['github-commit.snapshot.json', 'commit', 'read_github_commit'],
    ['github-issue.snapshot.json', 'issue', 'read_github_issue'],
    ['github-pull-request.snapshot.json', 'pull-request', 'read_github_pull_request'],
  ];
  const registry = createSiteAdapterRegistry({ adapters: [createGitHubAdapter()] });

  for (const [name, kind, toolName] of cases) {
    const snapshot = await fixture(name);
    assert.deepEqual(parseGitHubRoute(snapshot).kind, kind);
    assert.deepEqual(registry.resolve(snapshot), [{ id: 'github', version: '1', priority: 90 }]);
    const tools = registry.generateTools(snapshot);
    assert.deepEqual(tools.map((tool) => tool.name), [toolName]);
    const [tool] = tools;
    assert.equal(tool.adapter.id, 'github');
    assert.equal(tool.provenance.source, 'toolbraid.verified-adapter');
    assert.equal(tool.provenance.adapterId, 'github');
    assert.equal(tool.provenance.pageFingerprint, snapshot.pageFingerprint);
    assert.equal(tool.classification, 'read');
    assert.equal(tool.kind, 'read');
    assert.equal(tool.risk, 'read-only');
    assert.equal(tool.requiresApproval, false);
    assert.equal(tool.annotations.readOnlyHint, true);
    assert.equal(tool.annotations.untrustedContentHint, true);
    assert.equal(tool.effect.externalStateChange, false);
    assert.equal(tool.effect.requiresApproval, false);
    assert.equal(tool.target.ref, null);
    assert.equal(Object.prototype.hasOwnProperty.call(tool, 'execute'), false);
    assert.match(tool.description, /untrusted content/i);
  }
});

test('GitHub adapter returns bounded, structured, explicitly untrusted receipts', async () => {
  const registry = createSiteAdapterRegistry({ adapters: [createGitHubAdapter()] });

  const repository = await fixture('github-repository.snapshot.json');
  const repositoryTool = registry.generateTools(repository)[0];
  const repositoryResult = registry.executeRead(repositoryTool, repository);
  assert.equal(repositoryResult.type, 'github-repository');
  assert.equal(repositoryResult.repository.fullName, 'toolbraid/toolbraid');
  assert.deepEqual(repositoryResult.topics, ['webmcp', 'browser-security']);
  assert.equal(repositoryResult.stars, 42);
  assert.equal(repositoryResult.pageFingerprint, repository.pageFingerprint);
  assert.equal(repositoryResult.provenance, 'toolbraid.verified-adapter/github');
  assert.equal(repositoryResult.untrustedContent, true);

  const commit = await fixture('github-commit.snapshot.json');
  const commitResult = registry.executeRead(registry.generateTools(commit)[0], commit);
  assert.equal(commitResult.sha, '0123456789abcdef0123456789abcdef01234567');
  assert.equal(commitResult.author, 'toolbraid-bot');
  assert.equal(commitResult.files.length, 2);
  assert.equal(commitResult.files[0].path, 'src/site-adapters/github.js');

  const issue = await fixture('github-issue.snapshot.json');
  const issueResult = registry.executeRead(registry.generateTools(issue)[0], issue);
  assert.equal(issueResult.number, 17);
  assert.equal(issueResult.author, 'reviewer');
  assert.equal(issueResult.labels[0], 'security');
  assert.equal(issueResult.assignees[0], 'maintainer');
  assert.match(issueResult.body, /<script>alert\(1\)<\/script>/);
  assert.equal(issueResult.untrustedContent, true);

  const pullRequest = await fixture('github-pull-request.snapshot.json');
  const pullRequestResult = registry.executeRead(registry.generateTools(pullRequest)[0], pullRequest);
  assert.equal(pullRequestResult.type, 'github-pull-request');
  assert.equal(pullRequestResult.baseBranch, 'main');
  assert.equal(pullRequestResult.headBranch, 'wave-5-adapters');
  assert.equal(pullRequestResult.isDraft, false);
  assert.equal(pullRequestResult.merged, false);
});

test('GitHub extraction is bounded and does not preserve arbitrary page object values', () => {
  const topics = Array.from({ length: 100 }, (_, index) => ({ name: `topic-${index}` }));
  const snapshot = createPageSnapshot({
    metadata: {
      url: 'https://github.com/acme/widget',
      title: 'Widget',
      github: {
        repository: {
          description: 'D'.repeat(10_000),
          topics,
          stars: Number.MAX_SAFE_INTEGER + 1,
          homepage: 'javascript:alert(1)',
        },
      },
    },
    headings: [{ level: 1, text: 'Widget' }],
    mainText: 'Widget',
    links: [],
    forms: [],
    accessibleControls: [],
    elementRefs: [],
  });
  const result = extractGitHubPage(snapshot);
  assert.equal(result.description.length, 4096);
  assert.equal(result.topics.length, 64);
  assert.equal(result.topics[0], 'topic-0');
  assert.equal(result.stars, null);
  assert.equal(result.homepage, null);
  assert.equal(result.untrustedContent, true);
});

test('GitHub adapter rejects lookalike hosts, unsupported paths, unsafe schemes, and stale snapshots', async () => {
  const registry = createSiteAdapterRegistry({ adapters: [createGitHubAdapter()] });
  const lookalikes = [
    'https://github.com.attacker.test/toolbraid/toolbraid',
    'https://github.com/toolbraid/toolbraid/tree/main',
    'https://github.com/toolbraid/toolbraid/issues/0',
    'https://github.com/toolbraid/toolbraid/commit/not-a-sha',
    'http://github.com/toolbraid/toolbraid',
    'https://github.com/toolbraid//toolbraid',
  ];
  for (const url of lookalikes) {
    const snapshot = urlSnapshot(url);
    assert.equal(parseGitHubRoute(snapshot), null, url);
    assert.deepEqual(registry.generateTools(snapshot), [], url);
  }

  const original = await fixture('github-issue.snapshot.json');
  const tool = registry.generateTools(original)[0];
  const changed = createPageSnapshot({
    ...JSON.parse(await readFile(new URL('github-issue.snapshot.json', FIXTURE_ROOT), 'utf8')),
    metadata: {
      ...JSON.parse(await readFile(new URL('github-issue.snapshot.json', FIXTURE_ROOT), 'utf8')).metadata,
      title: 'Changed after generation',
    },
  });
  assert.notEqual(changed.pageFingerprint, original.pageFingerprint);
  assert.throws(
    () => registry.executeRead(tool, changed),
    (error) => error instanceof SiteAdapterError && error.code === 'ADAPTER_PAGE_DRIFT',
  );

  const forged = {
    ...tool,
    provenance: { ...tool.provenance, source: 'attacker.example' },
  };
  assert.throws(
    () => registry.executeRead(forged, original),
    (error) => error instanceof SiteAdapterError && error.code === 'ADAPTER_DESCRIPTOR_INVALID',
  );
});

test('GitHub adapter supports explicit test hosts without widening the default allowlist', () => {
  const snapshot = urlSnapshot('https://git.example/acme/widget', {
    metadata: { github: { repository: { title: 'Widget' } } },
  });
  assert.equal(parseGitHubRoute(snapshot), null);
  const adapter = createGitHubAdapter({ hosts: ['git.example'] });
  const registry = createSiteAdapterRegistry({ adapters: [adapter] });
  assert.equal(registry.generateTools(snapshot)[0].name, 'read_github_repository');
});

test('GitHub specialized reads add structured semantics without duplicating generic page tools or claiming mutation', async () => {
  const snapshot = await fixture('github-repository.snapshot.json');
  const registry = createSiteAdapterRegistry({ adapters: [createGitHubAdapter()] });
  const verified = registry.generateTools(snapshot);
  const generic = generateWebMcpToolDescriptors(snapshot, { includePageRead: true });
  assert.equal(verified.length, 1);
  assert.equal(generic.some((tool) => tool.name === verified[0].name), false);
  assert.equal(verified[0].target.ref, null);
  assert.equal(verified[0].classification, 'read');
  assert.equal(verified[0].requiresApproval, false);
  assert.equal(verified[0].effect.externalStateChange, false);
  assert.equal(verified[0].annotations.readOnlyHint, true);
});

function githubActionSnapshot(url, {
  repository = {},
  issue = null,
  pullRequest = null,
  controls = [],
  forms = [],
  mainText = '',
} = {}) {
  return createPageSnapshot({
    metadata: {
      url,
      origin: 'https://github.com',
      title: url,
      github: {
        ...(Object.keys(repository).length ? { repository } : {}),
        ...(issue ? { issue } : {}),
        ...(pullRequest ? { pullRequest } : {}),
      },
    },
    mainText,
    forms,
    accessibleControls: controls,
    elementRefs: [
      ...forms.flatMap((form) => [
        { ref: form.ref, tagName: 'form', role: 'form', name: form.name ?? '' },
        ...(form.fields ?? []).map((field) => ({
          ref: field.ref,
          tagName: field.type === 'textarea' ? 'textarea' : field.role === 'button' ? 'button' : 'input',
          role: field.role,
          name: field.name,
          type: field.type,
          formRef: form.ref,
        })),
      ]),
      ...controls.map((control) => ({
        ref: control.ref,
        tagName: control.type === 'textarea' ? 'textarea' : 'button',
        role: control.role,
        name: control.name,
        type: control.type,
      })),
    ],
  });
}

function githubButton(ref, name, extra = {}) {
  return { ref, role: 'button', type: 'button', name, ...extra };
}

function commentForm(ref = 'comment-form') {
  const prefix = ref === 'comment-form' ? 'comment' : ref.replace(/[^A-Za-z0-9-]/g, '-');
  return {
    ref,
    name: 'Add a comment',
    action: '/toolbraid/toolbraid/issues/17/comments',
    method: 'POST',
    fields: [
      { ref: `${prefix}-body`, role: 'textbox', type: 'textarea', name: 'Comment body', required: true, formRef: ref },
      { ref: `${prefix}-submit`, role: 'button', type: 'submit', name: 'Comment', formRef: ref },
    ],
  };
}

test('GitHub exposes only exact, enabled repository star controls as approved mutations', () => {
  const adapter = createGitHubAdapter();
  const registry = createSiteAdapterRegistry({ adapters: [adapter] });
  const unstarred = githubActionSnapshot('https://github.com/toolbraid/toolbraid', {
    repository: { title: 'toolbraid/toolbraid' },
    controls: [githubButton('star', 'Star this repository', { attributes: { 'data-testid': 'star-button', 'aria-label': 'Star this repository' } })],
  });
  const star = registry.generateTools(unstarred).find((tool) => tool.name === 'star_github_repository');
  assert.ok(star);
  assert.equal(star.classification, 'mutate');
  assert.equal(star.kind, 'mutate');
  assert.equal(star.requiresApproval, true);
  assert.equal(star.effect.externalStateChange, true);
  assert.equal(star.effect.requiresApproval, true);
  assert.equal(star.target.ref, 'star');
  assert.equal(star.target.type, 'control');
  assert.equal(star.postcondition.id, 'github.repository.star.v1');
  assert.doesNotThrow(() => prepareAction({ snapshot: unstarred, descriptor: star, input: {} }));
  assert.equal(registry.generateTools(unstarred).filter((tool) => tool.classification === 'mutate').length, 1);

  const starred = githubActionSnapshot('https://github.com/toolbraid/toolbraid', {
    repository: { title: 'toolbraid/toolbraid' },
    controls: [githubButton('unstar', 'Unstar this repository', { pressed: true, attributes: { 'data-testid': 'unstar-button', 'aria-label': 'Unstar this repository' } })],
  });
  const unstar = registry.generateTools(starred).find((tool) => tool.name === 'unstar_github_repository');
  assert.ok(unstar);
  assert.equal(unstar.postcondition.id, 'github.repository.unstar.v1');
  assert.equal(unstar.target.ref, 'unstar');

  const formStarred = githubActionSnapshot('https://github.com/toolbraid/toolbraid', {
    repository: { title: 'toolbraid/toolbraid' },
    controls: [githubButton('star-button', 'Star', { formRef: 'star-form' })],
    forms: [{
      ref: 'star-form',
      name: 'Star repository',
      action: 'https://github.com/toolbraid/toolbraid/star',
      method: 'POST',
      fields: [],
    }],
  });
  assert.equal(registry.generateTools(formStarred).some((tool) => tool.name === 'star_github_repository'), true);

  const liveGitHubLabel = githubActionSnapshot('https://github.com/Maharajahu/toolbraid', {
    repository: { title: 'Maharajahu/toolbraid' },
    controls: [githubButton('live-star', 'Star Maharajahu/toolbraid')],
  });
  assert.equal(registry.generateTools(liveGitHubLabel).some((tool) => tool.name === 'star_github_repository'), true);

  const liveGitHubUnstarLabel = githubActionSnapshot('https://github.com/Maharajahu/toolbraid', {
    repository: { title: 'Maharajahu/toolbraid' },
    controls: [githubButton('live-unstar', 'Unstar Maharajahu/toolbraid', { pressed: true })],
  });
  assert.equal(registry.generateTools(liveGitHubUnstarLabel).some((tool) => tool.name === 'unstar_github_repository'), true);
});

test('GitHub suppresses ambiguous, disabled, contradictory, and already-state star controls', () => {
  const registry = createSiteAdapterRegistry({ adapters: [createGitHubAdapter()] });
  const cases = [
    [githubButton('star-a', 'Star this repository', { disabled: true })],
    [githubButton('star-a', 'Star this repository'), githubButton('star-b', 'Star this repository')],
    [githubButton('star', 'Star this repository', { pressed: true })],
    [githubButton('unstar', 'Unstar this repository', { pressed: false })],
    [githubButton('lookalike', 'Star this repository', { attributes: { 'data-testid': 'star-button' }, disabled: true })],
    [githubButton('star', 'Star this repository'), githubButton('unstar', 'Unstar this repository')],
    [githubButton('wrong-repository', 'Star attacker/toolbraid')],
  ];
  for (const controls of cases) {
    const snapshot = githubActionSnapshot('https://github.com/toolbraid/toolbraid', { controls });
    assert.equal(registry.generateTools(snapshot).some((tool) => tool.classification === 'mutate'), false);
  }
});

test('GitHub suppresses comment mutations when the exact POST form is absent, unsafe, disabled, or ambiguous', () => {
  const registry = createSiteAdapterRegistry({ adapters: [createGitHubAdapter()] });
  const base = {
    issue: { title: 'Issue', state: 'open', comments: 2 },
    mainText: 'Issue open',
  };
  const cases = [
    { ...base, forms: [{ ...commentForm(), action: 'https://attacker.test/toolbraid/toolbraid/issues/17/comments' }] },
    { ...base, forms: [{ ...commentForm(), fields: [{ ...commentForm().fields[0], disabled: true }, commentForm().fields[1]] }] },
    { ...base, forms: [commentForm(), commentForm('other-comment-form')] },
    { ...base, forms: [{ ...commentForm(), fields: [commentForm().fields[0]] }] },
  ];
  for (const options of cases) {
    const snapshot = githubActionSnapshot('https://github.com/toolbraid/toolbraid/issues/17', options);
    assert.equal(registry.generateTools(snapshot).some((tool) => tool.name === 'comment_github_issue'), false);
  }
});

test('GitHub exposes exact issue and pull-request comment, close, and reopen mutations', () => {
  const registry = createSiteAdapterRegistry({ adapters: [createGitHubAdapter()] });
  const openIssue = githubActionSnapshot('https://github.com/toolbraid/toolbraid/issues/17', {
    issue: { title: 'Issue', state: 'open', comments: 2 },
    controls: [githubButton('close', 'Close issue')],
    forms: [commentForm()],
    mainText: 'Issue open',
  });
  const issueTools = registry.generateTools(openIssue);
  assert.deepEqual(issueTools.filter((tool) => tool.classification === 'mutate').map((tool) => tool.name).sort(), [
    'close_github_issue',
    'comment_github_issue',
  ]);
  const issueComment = issueTools.find((tool) => tool.name === 'comment_github_issue');
  assert.equal(issueComment.target.type, 'form');
  assert.equal(issueComment.sourceType, 'form');
  assert.equal(issueComment.postcondition.id, 'github.issue.comment.v1');
  assert.deepEqual(issueComment.inputSchema.required, ['comment_body']);
  assert.doesNotThrow(() => prepareAction({ snapshot: openIssue, descriptor: issueComment, input: { comment_body: 'A real comment' } }));
  assert.equal(issueTools.find((tool) => tool.name === 'close_github_issue').postcondition.id, 'github.issue.close.v1');

  const sharedCommentForm = githubActionSnapshot('https://github.com/toolbraid/toolbraid/issues/17', {
    issue: { title: 'Issue', state: 'open', comments: 2 },
    forms: [{ ...commentForm(), action: '/toolbraid/toolbraid/issue_comments' }],
    mainText: 'Issue open',
  });
  assert.ok(registry.generateTools(sharedCommentForm).some((tool) => tool.name === 'comment_github_issue'));

  const closedIssue = githubActionSnapshot('https://github.com/toolbraid/toolbraid/issues/17', {
    issue: { title: 'Issue', state: 'closed', comments: 2 },
    controls: [githubButton('reopen', 'Reopen issue')],
    forms: [commentForm()],
    mainText: 'Issue closed',
  });
  const reopenIssue = registry.generateTools(closedIssue).find((tool) => tool.name === 'reopen_github_issue');
  assert.ok(reopenIssue);
  assert.equal(reopenIssue.postcondition.id, 'github.issue.reopen.v1');

  const openPullRequest = githubActionSnapshot('https://github.com/toolbraid/toolbraid/pull/23', {
    pullRequest: { title: 'PR', state: 'open', comments: 2, merged: false },
    controls: [githubButton('close-pr', 'Close pull request')],
    forms: [{ ...commentForm(), action: '/toolbraid/toolbraid/pull/23/comments' }],
    mainText: 'Pull request open',
  });
  const pullRequestTools = registry.generateTools(openPullRequest);
  assert.deepEqual(pullRequestTools.filter((tool) => tool.classification === 'mutate').map((tool) => tool.name).sort(), [
    'close_github_pull_request',
    'comment_github_pull_request',
  ]);

  const livePullRequestCommentPath = githubActionSnapshot('https://github.com/toolbraid/toolbraid/pull/23', {
    pullRequest: { title: 'PR', state: 'open', comments: 2, merged: false },
    forms: [{ ...commentForm(), action: '/toolbraid/toolbraid/issues/23/comments' }],
  });
  assert.ok(registry.generateTools(livePullRequestCommentPath).some((tool) => tool.name === 'comment_github_pull_request'));

  const genericLiveIssue = githubActionSnapshot('https://github.com/toolbraid/toolbraid/issues/17', {
    controls: [githubButton('close', 'Close issue')],
    mainText: 'Untrusted page text does not supply state metadata.',
  });
  assert.ok(registry.generateTools(genericLiveIssue).some((tool) => tool.name === 'close_github_issue'));
});

test('GitHub postconditions verify only observed state transitions and comment-count changes', () => {
  const registry = createSiteAdapterRegistry({ adapters: [createGitHubAdapter()] });
  const before = githubActionSnapshot('https://github.com/toolbraid/toolbraid/issues/17', {
    issue: { title: 'Issue', state: 'open', comments: 2 },
    controls: [githubButton('close', 'Close issue')],
    forms: [commentForm()],
    mainText: 'Issue open',
  });
  const closeTool = registry.generateTools(before).find((tool) => tool.name === 'close_github_issue');
  const closed = githubActionSnapshot('https://github.com/toolbraid/toolbraid/issues/17', {
    issue: { title: 'Issue', state: 'closed', comments: 2 },
    controls: [githubButton('reopen', 'Reopen issue')],
    mainText: 'Issue closed',
  });
  const closeVerdict = registry.verifyPostcondition(closeTool, {
    tabId: 4,
    frameId: 0,
    sessionId: 'github-postcondition-session',
    beforeSnapshot: before,
    afterSnapshot: closed,
  });
  assert.equal(closeVerdict.status, 'verified-success');
  assert.equal(closeVerdict.afterPageFingerprint, closed.pageFingerprint);

  const commentTool = registry.generateTools(before).find((tool) => tool.name === 'comment_github_issue');
  const commentAfter = githubActionSnapshot('https://github.com/toolbraid/toolbraid/issues/17', {
    issue: { title: 'Issue', state: 'open', comments: 3 },
    forms: [commentForm()],
    mainText: 'Issue open',
  });
  const commentVerdict = registry.verifyPostcondition(commentTool, {
    tabId: 4,
    frameId: 0,
    sessionId: 'github-postcondition-session',
    preparedAction: { normalizedArguments: { comment_body: 'A real comment' } },
    beforeSnapshot: before,
    afterSnapshot: commentAfter,
  });
  assert.equal(commentVerdict.status, 'verified-success');

  const unchanged = registry.verifyPostcondition(closeTool, {
    tabId: 4,
    frameId: 0,
    sessionId: 'github-postcondition-session',
    beforeSnapshot: before,
    afterSnapshot: before,
  });
  assert.equal(unchanged.status, 'unverified');
  assert.equal(unchanged.reasonCode, 'GITHUB_STATE_NOT_CONFIRMED');

  const genericBefore = githubActionSnapshot('https://github.com/toolbraid/toolbraid/issues/17', {
    controls: [githubButton('close-generic', 'Close issue')],
  });
  const genericTool = registry.generateTools(genericBefore).find((tool) => tool.name === 'close_github_issue');
  const genericAfter = githubActionSnapshot('https://github.com/toolbraid/toolbraid/issues/17', {
    controls: [githubButton('reopen-generic', 'Reopen issue')],
  });
  assert.equal(registry.verifyPostcondition(genericTool, {
    tabId: 4,
    frameId: 0,
    sessionId: 'github-postcondition-session',
    beforeSnapshot: genericBefore,
    afterSnapshot: genericAfter,
  }).status, 'verified-success');
});

test('GitHub mutation postconditions fail closed on route drift, merged PRs, and unverifiable comments', () => {
  const registry = createSiteAdapterRegistry({ adapters: [createGitHubAdapter()] });
  const before = githubActionSnapshot('https://github.com/toolbraid/toolbraid/pull/23', {
    pullRequest: { title: 'PR', state: 'open', comments: 2, merged: false },
    controls: [githubButton('close-pr', 'Close pull request')],
    forms: [{ ...commentForm(), action: '/toolbraid/toolbraid/pull/23/comments' }],
    mainText: 'Pull request open',
  });
  const closeTool = registry.generateTools(before).find((tool) => tool.name === 'close_github_pull_request');
  const wrongRoute = githubActionSnapshot('https://github.com/toolbraid/toolbraid/pull/24', {
    pullRequest: { title: 'Other PR', state: 'closed', comments: 2, merged: false },
    controls: [githubButton('reopen-pr', 'Reopen pull request')],
    mainText: 'Pull request closed',
  });
  const drift = registry.verifyPostcondition(closeTool, {
    tabId: 4,
    frameId: 0,
    sessionId: 'github-postcondition-session',
    beforeSnapshot: before,
    afterSnapshot: wrongRoute,
  });
  assert.equal(drift.status, 'unverified');

  const merged = githubActionSnapshot('https://github.com/toolbraid/toolbraid/pull/23', {
    pullRequest: { title: 'PR', state: 'closed', comments: 2, merged: true },
    controls: [githubButton('reopen-pr', 'Reopen pull request')],
    mainText: 'Pull request merged',
  });
  const mergedVerdict = registry.verifyPostcondition(closeTool, {
    tabId: 4,
    frameId: 0,
    sessionId: 'github-postcondition-session',
    beforeSnapshot: before,
    afterSnapshot: merged,
  });
  assert.equal(mergedVerdict.status, 'unverified');

  const commentTool = registry.generateTools(before).find((tool) => tool.name === 'comment_github_pull_request');
  const noCount = githubActionSnapshot('https://github.com/toolbraid/toolbraid/pull/23', {
    pullRequest: { title: 'PR', state: 'open', merged: false },
    forms: [{ ...commentForm(), action: '/toolbraid/toolbraid/pull/23/comments' }],
    mainText: 'Pull request open',
  });
  const unverifiable = registry.verifyPostcondition(commentTool, {
    tabId: 4,
    frameId: 0,
    sessionId: 'github-postcondition-session',
    preparedAction: { normalizedArguments: { comment_body: 'A real comment' } },
    beforeSnapshot: before,
    afterSnapshot: noCount,
  });
  assert.equal(unverifiable.status, 'unverified');
  assert.equal(unverifiable.reasonCode, 'GITHUB_COMMENT_NOT_CONFIRMED');
});
