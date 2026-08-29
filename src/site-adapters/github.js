import {
  boundedBoolean,
  boundedInteger,
  boundedJson,
  boundedNumber,
  boundedStringArray,
  boundedText,
  canonicalUrl,
  exactPathSegments,
  firstHeading,
  freezeUntrusted,
  metadataRecord,
  plainObject,
  readDescriptor,
  safeHttpUrl,
} from './common.js';

export const GITHUB_HOSTS = Object.freeze(['github.com', 'www.github.com']);
export const GITHUB_ADAPTER_VERSION = '1';

const OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const SHA_PATTERN = /^[A-Fa-f0-9]{7,64}$/;
const NUMBER_PATTERN = /^[1-9][0-9]{0,8}$/;
const RESERVED_ROOTS = new Set([
  'about', 'apps', 'collections', 'contact', 'customer-stories', 'enterprise', 'events',
  'explore', 'features', 'github-sponsors', 'issues', 'join', 'login', 'marketplace',
  'new', 'notifications', 'orgs', 'organizations', 'pricing', 'pulls', 'search',
  'security', 'settings', 'site', 'sponsors', 'team', 'topics', 'trending', 'users',
]);

function text(value, fallback = null, limit = 4096) {
  return boundedText(value, fallback, limit);
}

function identityText(value, fallback = null, limit = 4096) {
  if (plainObject(value)) {
    return text(
      value.login ?? value.username ?? value.slug ?? value.handle ?? value.name ?? value.displayName ?? value.fullName ?? value.text ?? value.label ?? value.value,
      fallback,
      limit,
    );
  }
  return text(value, fallback, limit);
}

function numeric(value, fallback = null) {
  return boundedNumber(value, fallback, { min: 0, max: Number.MAX_SAFE_INTEGER });
}

function count(value, fallback = null) {
  return boundedInteger(value, fallback, { min: 0, max: Number.MAX_SAFE_INTEGER });
}

function routeFor(snapshot, hosts = GITHUB_HOSTS) {
  const allowedHosts = hosts instanceof Set
    ? hosts
    : new Set([...hosts].map((host) => String(host).toLowerCase()));
  const url = canonicalUrl(snapshot, allowedHosts);
  if (!url) return null;
  const segments = exactPathSegments(url);
  if (!segments || segments.length < 2 || segments.length > 4) return null;
  const [owner, repository, category, identifier] = segments;
  if (!OWNER_PATTERN.test(owner) || !REPOSITORY_PATTERN.test(repository) || RESERVED_ROOTS.has(owner.toLowerCase())) return null;
  const base = { url, owner, repository, fullName: `${owner}/${repository}` };
  if (segments.length === 2) return { ...base, kind: 'repository' };
  if (segments.length === 4 && category === 'commit' && SHA_PATTERN.test(identifier)) {
    return { ...base, kind: 'commit', sha: identifier.toLowerCase() };
  }
  if (segments.length === 4 && category === 'issues' && NUMBER_PATTERN.test(identifier)) {
    return { ...base, kind: 'issue', number: Number(identifier) };
  }
  if (segments.length === 4 && category === 'pull' && NUMBER_PATTERN.test(identifier)) {
    return { ...base, kind: 'pull-request', number: Number(identifier) };
  }
  return null;
}

function sourceRecord(snapshot) {
  const metadata = plainObject(snapshot?.metadata) ? snapshot.metadata : {};
  const github = metadataRecord(snapshot, 'github');
  const nested = plainObject(github.repository) ? github.repository : {};
  return { metadata, github, nested };
}

function sourceValue(source, key, ...fallbacks) {
  if (plainObject(source) && Object.hasOwn(source, key) && source[key] !== undefined && source[key] !== null) return source[key];
  for (const fallback of fallbacks) {
    if (fallback !== undefined && fallback !== null) return fallback;
  }
  return null;
}

function linkFor(snapshot, pattern) {
  if (!Array.isArray(snapshot?.links)) return null;
  return snapshot.links.find((link) => {
    try { return pattern.test(new URL(String(link?.href ?? '')).pathname); } catch { return false; }
  }) ?? null;
}

function inferState(snapshot, fallback = null) {
  const words = text(snapshot?.mainText, '', 16_384)?.toLowerCase() ?? '';
  if (/\bmerged\b/.test(words)) return 'merged';
  if (/\bclosed\b/.test(words)) return 'closed';
  if (/\bopen\b/.test(words)) return 'open';
  return fallback;
}

function inferAuthor(snapshot) {
  const link = linkFor(snapshot, /^\/[^/]+(?:\/|$)/);
  return text(link?.text, null, 256);
}

function labelsFrom(source) {
  const raw = sourceValue(source, 'labels', source.labels?.items);
  if (!Array.isArray(raw)) return [];
  return boundedStringArray(raw.map((entry) => plainObject(entry) ? entry.name ?? entry.title ?? entry.text : entry), {
    max: 64,
    itemLimit: 128,
  });
}

function repositoryEvidence(snapshot, route) {
  const { metadata, github, nested } = sourceRecord(snapshot);
  const repository = {
    owner: route.owner,
    name: route.repository,
    fullName: route.fullName,
  };
  return freezeUntrusted({
    type: 'github-repository',
    repository,
    url: route.url.href,
    title: text(sourceValue(nested, 'title', sourceValue(github, 'title'), firstHeading(snapshot)), route.fullName, 512),
    description: text(sourceValue(nested, 'description', sourceValue(github, 'description'), metadata.description), null, 4096),
    defaultBranch: text(sourceValue(nested, 'defaultBranch', sourceValue(nested, 'default_branch'), sourceValue(github, 'defaultBranch'), sourceValue(github, 'default_branch')), null, 256),
    visibility: text(sourceValue(nested, 'visibility', sourceValue(github, 'visibility')), null, 64),
    language: text(sourceValue(nested, 'language', sourceValue(github, 'language')), null, 128),
    topics: boundedStringArray(sourceValue(nested, 'topics', sourceValue(github, 'topics')), {
      max: 64,
      itemLimit: 128,
    }),
    stars: count(sourceValue(nested, 'stars', sourceValue(nested, 'stargazers_count'), sourceValue(github, 'stars'), sourceValue(github, 'stargazers_count'))),
    forks: count(sourceValue(nested, 'forks', sourceValue(nested, 'forks_count'), sourceValue(github, 'forks'), sourceValue(github, 'forks_count'))),
    openIssues: count(sourceValue(nested, 'openIssues', sourceValue(nested, 'open_issues_count'), sourceValue(github, 'openIssues'), sourceValue(github, 'open_issues_count'))),
    watchers: count(sourceValue(nested, 'watchers', sourceValue(github, 'watchers'))),
    homepage: safeHttpUrl(sourceValue(nested, 'homepage', sourceValue(github, 'homepage'))),
    evidence: boundedJson(sourceValue(github, 'evidence'), { maxDepth: 3, maxEntries: 24, maxArray: 32 }),
    pageFingerprint: snapshot.pageFingerprint,
    provenance: 'toolbraid.verified-adapter/github',
    untrustedContent: true,
  });
}

function commitEvidence(snapshot, route) {
  const { metadata, github, nested } = sourceRecord(snapshot);
  const commit = plainObject(github.commit) ? github.commit : github;
  const details = plainObject(commit.commit) ? commit.commit : commit;
  const message = text(sourceValue(commit, 'message', sourceValue(details, 'message'), sourceValue(commit, 'title'), metadata.description, firstHeading(snapshot)), null, 8192);
  const author = identityText(sourceValue(commit, 'author', sourceValue(details, 'author'), sourceValue(commit, 'committer'), sourceValue(details, 'committer'), inferAuthor(snapshot)), null, 256);
  const filesValue = sourceValue(commit, 'files');
  const files = Array.isArray(filesValue)
    ? filesValue.slice(0, 128).map((file) => {
      if (!plainObject(file)) return null;
      return {
        path: text(file.path ?? file.filename, null, 512),
        status: text(file.status, null, 64),
        additions: count(file.additions),
        deletions: count(file.deletions),
        changes: count(file.changes),
      };
    }).filter((file) => file?.path)
    : [];
  return freezeUntrusted({
    type: 'github-commit',
    repository: { owner: route.owner, name: route.repository, fullName: route.fullName },
    url: route.url.href,
    sha: route.sha,
    abbreviatedSha: route.sha.slice(0, 12),
    message,
    author,
    committedAt: text(sourceValue(commit, 'committedAt', sourceValue(commit, 'committed_at'), sourceValue(commit, 'date'), sourceValue(commit, 'timestamp'), sourceValue(details, 'date'), sourceValue(details.author, 'date'), sourceValue(details.committer, 'date')), null, 128),
    parents: Array.isArray(sourceValue(commit, 'parents'))
      ? count(sourceValue(commit, 'parents').length)
      : count(sourceValue(commit, 'parentCount', sourceValue(commit, 'parentsCount'))),
    additions: count(sourceValue(commit, 'additions', sourceValue(commit.stats, 'additions'))),
    deletions: count(sourceValue(commit, 'deletions', sourceValue(commit.stats, 'deletions'))),
    changedFiles: count(sourceValue(commit, 'changedFiles', sourceValue(commit, 'changed_files'), sourceValue(commit, 'filesCount'), sourceValue(commit.stats, 'total'))),
    files,
    pageFingerprint: snapshot.pageFingerprint,
    provenance: 'toolbraid.verified-adapter/github',
    untrustedContent: true,
  });
}

function issueEvidence(snapshot, route, kind) {
  const { metadata, github, nested } = sourceRecord(snapshot);
  const issue = plainObject(github.issue) ? github.issue : (kind === 'pull-request' && plainObject(github.pullRequest) ? github.pullRequest : github);
  const title = text(sourceValue(issue, 'title', firstHeading(snapshot), metadata.title), `${route.fullName} #${route.number}`, 1024);
  const body = text(sourceValue(issue, 'body', sourceValue(issue, 'description'), metadata.description, snapshot.mainText), null, 8192);
  const state = text(sourceValue(issue, 'state', sourceValue(issue, 'state_reason')), inferState(snapshot), 32)?.toLowerCase() ?? null;
  const labels = labelsFrom(issue);
  const commentsValue = sourceValue(issue, 'comments', sourceValue(issue, 'commentCount'));
  const assigneesValue = sourceValue(issue, 'assignees');
  const common = {
    repository: { owner: route.owner, name: route.repository, fullName: route.fullName },
    url: route.url.href,
    number: route.number,
    title,
    state,
    author: identityText(sourceValue(issue, 'author', sourceValue(issue, 'user'), inferAuthor(snapshot)), null, 256),
    body,
    labels,
    comments: Array.isArray(commentsValue) ? count(commentsValue.length) : count(commentsValue),
    assignees: boundedStringArray(assigneesValue, { max: 32, itemLimit: 256 }),
    milestone: identityText(sourceValue(issue, 'milestone'), null, 256),
  };
  if (kind === 'pull-request') {
    common.type = 'github-pull-request';
    const base = sourceValue(issue, 'base');
    const head = sourceValue(issue, 'head');
    common.baseBranch = identityText(sourceValue(issue, 'baseBranch', sourceValue(issue, 'base_branch'), plainObject(base) ? base.ref : base), null, 256);
    common.headBranch = identityText(sourceValue(issue, 'headBranch', sourceValue(issue, 'head_branch'), plainObject(head) ? head.ref : head), null, 256);
    common.isDraft = boundedBoolean(sourceValue(issue, 'isDraft', sourceValue(issue, 'draft'), sourceValue(issue, 'is_draft')));
    common.merged = boundedBoolean(sourceValue(issue, 'merged'));
    common.reviewDecision = text(sourceValue(issue, 'reviewDecision', sourceValue(issue, 'review_decision'), sourceValue(issue, 'reviews')), null, 128);
    common.changedFiles = count(sourceValue(issue, 'changedFiles', sourceValue(issue, 'changed_files'), sourceValue(issue, 'filesCount')));
    common.additions = count(sourceValue(issue, 'additions', sourceValue(issue.stats, 'additions')));
    common.deletions = count(sourceValue(issue, 'deletions', sourceValue(issue.stats, 'deletions')));
  } else {
    common.type = 'github-issue';
  }
  common.pageFingerprint = snapshot.pageFingerprint;
  common.provenance = 'toolbraid.verified-adapter/github';
  common.untrustedContent = true;
  return freezeUntrusted(common);
}

function descriptorFor(snapshot, route, version) {
  const labels = {
    repository: ['read_github_repository', 'Read GitHub repository', 'repository'],
    commit: ['read_github_commit', 'Read GitHub commit', 'commit'],
    issue: ['read_github_issue', 'Read GitHub issue', 'issue'],
    'pull-request': ['read_github_pull_request', 'Read GitHub pull request', 'pull request'],
  }[route.kind];
  return readDescriptor(snapshot, {
    adapterId: 'github',
    adapterVersion: version,
    sourceType: `github-${route.kind}`,
    name: labels[0],
    title: labels[1],
    description: `Read structured evidence from the visible GitHub ${labels[2]} page without changing GitHub state.`,
    effectSummary: `Read the visible GitHub ${labels[2]} as structured, untrusted evidence.`,
    evidence: [{ code: `GITHUB_${route.kind.toUpperCase().replace('-', '_')}_ROUTE`, owner: route.owner, repository: route.repository }],
  });
}

export function parseGitHubRoute(snapshot) {
  const route = routeFor(snapshot);
  return route ? Object.freeze({ ...route, url: route.url.href }) : null;
}

export function extractGitHubRepository(snapshot) {
  const route = routeFor(snapshot);
  return route?.kind === 'repository' ? repositoryEvidence(snapshot, route) : null;
}

export function extractGitHubCommit(snapshot) {
  const route = routeFor(snapshot);
  return route?.kind === 'commit' ? commitEvidence(snapshot, route) : null;
}

export function extractGitHubIssue(snapshot) {
  const route = routeFor(snapshot);
  return route?.kind === 'issue' ? issueEvidence(snapshot, route, 'issue') : null;
}

export function extractGitHubPullRequest(snapshot) {
  const route = routeFor(snapshot);
  return route?.kind === 'pull-request' ? issueEvidence(snapshot, route, 'pull-request') : null;
}

export function extractGitHubPage(snapshot) {
  const route = routeFor(snapshot);
  if (!route) return null;
  if (route.kind === 'repository') return repositoryEvidence(snapshot, route);
  if (route.kind === 'commit') return commitEvidence(snapshot, route);
  return issueEvidence(snapshot, route, route.kind);
}

export function createGitHubAdapter({ hosts = GITHUB_HOSTS, version = GITHUB_ADAPTER_VERSION } = {}) {
  const allowedHosts = new Set([...hosts].map((host) => String(host).toLowerCase()));
  return Object.freeze({
    id: 'github',
    version,
    priority: 90,
    matches(snapshot) {
      return Boolean(routeFor(snapshot, allowedHosts));
    },
    generateTools(snapshot) {
      const route = routeFor(snapshot, allowedHosts);
      if (!route) return Object.freeze([]);
      return Object.freeze([descriptorFor(snapshot, route, version)]);
    },
    executeRead(tool, snapshot) {
      const route = routeFor(snapshot, allowedHosts);
      if (!route) return null;
      const expected = `github-${route.kind}`;
      if (tool?.name !== descriptorFor(snapshot, route, version).name || tool?.sourceType !== expected) return null;
      return extractGitHubPage(snapshot);
    },
  });
}

export const createGithubAdapter = createGitHubAdapter;
export const createGitHubPageAdapter = createGitHubAdapter;
