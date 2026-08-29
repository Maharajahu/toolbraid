import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { createPageSnapshot, generateWebMcpToolDescriptors } from '../../src/universal/index.js';
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
