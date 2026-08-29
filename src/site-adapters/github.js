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
import { elementFingerprint } from '../universal/snapshot.js';
import { validateToolDescriptor } from '../universal/tools.js';
import { freezeDeep } from '../universal/canonical.js';

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

const POSTCONDITION_IDS = Object.freeze({
  star: 'github.repository.star.v1',
  unstar: 'github.repository.unstar.v1',
  issueComment: 'github.issue.comment.v1',
  pullRequestComment: 'github.pull-request.comment.v1',
  issueClose: 'github.issue.close.v1',
  issueReopen: 'github.issue.reopen.v1',
  pullRequestClose: 'github.pull-request.close.v1',
  pullRequestReopen: 'github.pull-request.reopen.v1',
});

const COMMENT_INPUT_MAX = 10_000;
const STAR_TEST_IDS = new Set(['star-button', 'repo-star-button', 'repository-star-button']);
const UNSTAR_TEST_IDS = new Set(['unstar-button', 'repo-unstar-button', 'repository-unstar-button']);
const COMMENT_SUBMIT_TEST_IDS = new Set(['comment-button', 'submit-comment-button', 'submit-review-comment-button']);
const CLOSE_ISSUE_TEST_IDS = new Set(['close-issue-button', 'issue-close-button']);
const REOPEN_ISSUE_TEST_IDS = new Set(['reopen-issue-button', 'issue-reopen-button']);
const CLOSE_PULL_REQUEST_TEST_IDS = new Set(['close-pr-button', 'close-pull-request-button', 'pull-request-close-button']);
const REOPEN_PULL_REQUEST_TEST_IDS = new Set(['reopen-pr-button', 'reopen-pull-request-button', 'pull-request-reopen-button']);

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

function normalizedText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function normalizedLower(value) {
  return normalizedText(value).toLowerCase();
}

function attribute(control, name) {
  return plainObject(control?.attributes) ? control.attributes[name] ?? null : null;
}

function dataTestId(control) {
  return normalizedLower(attribute(control, 'data-testid') ?? attribute(control, 'dataTestId'));
}

function controlLabels(control) {
  return [
    control?.name,
    attribute(control, 'aria-label'),
    attribute(control, 'title'),
  ].map(normalizedLower).filter(Boolean);
}

function booleanAttribute(value, { empty = false } = {}) {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return false;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return empty;
  return ['true', '1', 'yes', 'disabled', 'on'].includes(normalized);
}

function controlFlag(control, field, attributeNames = []) {
  if (typeof control?.[field] === 'boolean') return control[field];
  for (const name of attributeNames) {
    const value = attribute(control, name);
    if (value !== null && value !== undefined) return booleanAttribute(value);
  }
  return null;
}

function controlEnabled(control) {
  if (!control || control.disabled === true) return false;
  if (attribute(control, 'disabled') !== null && booleanAttribute(attribute(control, 'disabled'), { empty: true })) return false;
  if (booleanAttribute(attribute(control, 'aria-disabled'))) return false;
  return true;
}

function buttonControl(control) {
  const role = normalizedLower(control?.role);
  const type = normalizedLower(control?.type);
  return role === 'button' || ['button', 'submit'].includes(type);
}

function formActionKind(snapshot, route, control) {
  if (!control?.formRef) return null;
  const form = (snapshot?.forms ?? []).find((entry) => entry?.ref === control.formRef);
  if (!form || normalizedLower(form.method) !== 'post') return null;
  let action;
  try { action = new URL(form.action, route.url.href); } catch { return null; }
  if (action.origin !== route.url.origin) return null;
  const segments = exactPathSegments(action);
  if (!segments || segments.length !== 3 || segments[0] !== route.owner || segments[1] !== route.repository) return null;
  return segments[2] === 'star' || segments[2] === 'unstar' ? segments[2] : null;
}

function exactRepositoryStarKind(control, snapshot = null, route = null) {
  if (!buttonControl(control) || !controlEnabled(control)) return null;
  const labels = controlLabels(control);
  const starLabel = labels.some((label) => /^star(?: this)? repository$/.test(label));
  const unstarLabel = labels.some((label) => /^unstar(?: this)? repository$/.test(label));
  const routeLabel = normalizedLower(route?.fullName);
  const repositoryStarLabel = Boolean(routeLabel) && labels.includes(`star ${routeLabel}`);
  const repositoryUnstarLabel = Boolean(routeLabel) && labels.includes(`unstar ${routeLabel}`);
  const shortStarLabel = labels.some((label) => /^star$/.test(label));
  const shortUnstarLabel = labels.some((label) => /^unstar$/.test(label));
  const testId = dataTestId(control);
  const starTestId = STAR_TEST_IDS.has(testId);
  const unstarTestId = UNSTAR_TEST_IDS.has(testId);
  const contextual = snapshot && route ? formActionKind(snapshot, route, control) : null;
  const hasStarWord = labels.some((label) => /\bstar\b/.test(label));
  const hasUnstarWord = labels.some((label) => /\bunstar\b/.test(label));
  if (((starLabel || repositoryStarLabel) && (unstarLabel || repositoryUnstarLabel || unstarTestId || contextual === 'unstar'))
    || ((unstarLabel || repositoryUnstarLabel) && (starTestId || contextual === 'star'))
    || ((starLabel || repositoryStarLabel) && hasUnstarWord) || ((unstarLabel || repositoryUnstarLabel) && hasStarWord)
    || (shortStarLabel && shortUnstarLabel)
    || (shortStarLabel && contextual === 'unstar') || (shortUnstarLabel && contextual === 'star')) return null;
  if (unstarLabel || repositoryUnstarLabel || (shortUnstarLabel && contextual === 'unstar') || contextual === 'unstar'
    || (unstarTestId && labels.some((label) => /\bunstar\b/.test(label)))) return 'unstar';
  if (starLabel || repositoryStarLabel || (shortStarLabel && contextual === 'star') || contextual === 'star'
    || (starTestId && labels.some((label) => /\bstar\b/.test(label) && !/\bunstar\b/.test(label)))) return 'star';
  return null;
}

function repositoryStarControl(snapshot, desired, route = routeFor(snapshot)) {
  const matches = (snapshot?.accessibleControls ?? []).filter((control) => exactRepositoryStarKind(control, snapshot, route) === desired);
  if (matches.length !== 1) return null;
  const control = matches[0];
  const pressed = controlFlag(control, 'pressed', ['aria-pressed']);
  const checked = controlFlag(control, 'checked', ['aria-checked']);
  if (desired === 'star' && (pressed === true || checked === true)) return null;
  if (desired === 'unstar' && (pressed === false || checked === false)) return null;
  return control;
}

function issueSource(snapshot, route) {
  const { github } = sourceRecord(snapshot);
  return route.kind === 'issue'
    ? (plainObject(github.issue) ? github.issue : null)
    : (plainObject(github.pullRequest) ? github.pullRequest : null);
}

function issueState(snapshot, route) {
  const source = issueSource(snapshot, route);
  const merged = boundedBoolean(sourceValue(source, 'merged'), null);
  if (merged === true) return 'merged';
  const explicit = normalizedLower(sourceValue(source, 'state', sourceValue(source, 'state_reason')));
  if (explicit === 'open' || explicit === 'closed' || explicit === 'merged') return explicit;
  return null;
}

function exactIssueActionKind(control, route, desired) {
  if (!buttonControl(control) || !controlEnabled(control)) return null;
  const labels = controlLabels(control);
  const subject = route.kind === 'issue' ? 'issue' : 'pull request';
  const labelMatch = labels.some((label) => new RegExp(`^${desired}(?: this)? ${subject}$`).test(label));
  const testId = dataTestId(control);
  const testIds = route.kind === 'issue'
    ? (desired === 'close' ? CLOSE_ISSUE_TEST_IDS : REOPEN_ISSUE_TEST_IDS)
    : (desired === 'close' ? CLOSE_PULL_REQUEST_TEST_IDS : REOPEN_PULL_REQUEST_TEST_IDS);
  const testIdMatch = testIds.has(testId) && labels.some((label) => label.includes(desired));
  if (!labelMatch && !testIdMatch) return null;
  const opposite = desired === 'close' ? 'reopen' : 'close';
  if (labels.some((label) => label.includes(opposite))) return null;
  if (controlFlag(control, 'pressed', ['aria-pressed']) === true
    || controlFlag(control, 'checked', ['aria-checked']) === true) return null;
  return desired;
}

function issueActionControl(snapshot, route, desired) {
  const matches = (snapshot?.accessibleControls ?? []).filter((control) => exactIssueActionKind(control, route, desired) === desired);
  return matches.length === 1 ? matches[0] : null;
}

function formControls(snapshot, form) {
  const controls = new Map();
  for (const field of form?.fields ?? []) if (field?.ref) controls.set(field.ref, field);
  for (const control of snapshot?.accessibleControls ?? []) {
    if (control?.formRef === form?.ref && control?.ref) controls.set(control.ref, control);
  }
  return [...controls.values()];
}

function commentEditor(control) {
  if (!controlEnabled(control)) return false;
  const role = normalizedLower(control?.role);
  const type = normalizedLower(control?.type);
  if (type !== 'textarea' && role !== 'textbox') return false;
  const labels = controlLabels(control);
  return labels.some((label) => /comment|reply|leave a comment|new[_ -]?comment[_ -]?field/.test(label));
}

function commentSubmit(control) {
  if (!buttonControl(control) || !controlEnabled(control)) return false;
  const labels = controlLabels(control);
  const testId = dataTestId(control);
  return labels.some((label) => /^(?:comment|add comment|submit comment|post comment|reply|submit reply)$/.test(label))
    || (COMMENT_SUBMIT_TEST_IDS.has(testId) && labels.some((label) => /comment|reply/.test(label)));
}

function commentFormFor(snapshot, route) {
  const contextualForms = (snapshot?.forms ?? []).filter((form) => {
    if (normalizedLower(form?.method) !== 'post') return false;
    let action;
    try { action = new URL(form.action, route.url.href); } catch { return false; }
    if (action.origin !== route.url.origin) return false;
    const actionSegments = exactPathSegments(action);
    const routeSegments = route.kind === 'issue' ? new Set(['issues']) : new Set(['issues', 'pull']);
    const exactIssueCommentPath = actionSegments?.length === 5
      && actionSegments[0] === route.owner && actionSegments[1] === route.repository
      && routeSegments.has(actionSegments[2]) && actionSegments[3] === String(route.number)
      && actionSegments[4] === 'comments';
    const sharedIssueCommentPath = actionSegments?.length === 3
      && actionSegments[0] === route.owner && actionSegments[1] === route.repository
      && actionSegments[2] === 'issue_comments';
    if (!exactIssueCommentPath && !sharedIssueCommentPath) return false;
    const identity = `${normalizedLower(form?.name)} ${normalizedLower(form?.action)}`;
    return /comment|reply/.test(identity);
  });
  if (contextualForms.length !== 1) return null;
  const forms = contextualForms.filter((form) => {
    const controls = formControls(snapshot, form);
    const editors = controls.filter(commentEditor);
    const submits = controls.filter(commentSubmit);
    return editors.length === 1 && submits.length === 1 && editors[0].disabled !== true;
  });
  if (forms.length !== 1) return null;
  const form = forms[0];
  const controls = formControls(snapshot, form);
  return {
    form,
    editor: controls.find(commentEditor),
    submit: controls.find(commentSubmit),
    route,
  };
}

function commentInputProperty(field) {
  const source = normalizedText(field?.name)
    || normalizedText(attribute(field, 'name'))
    || normalizedText(attribute(field, 'id'))
    || normalizedText(field?.ref)
    || 'comment';
  let value = source
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
  if (!value) value = 'comment';
  if (/^\d/.test(value)) value = `field_${value}`;
  return value.slice(0, 128);
}

function mutationContract(id, version) {
  return {
    version: 1,
    id,
    adapterId: 'github',
    adapterVersion: String(version),
    observation: 'page-snapshot',
  };
}

function mutationDescriptor(snapshot, route, version, {
  name,
  title,
  description,
  target,
  sourceType,
  inputSchema = { type: 'object', properties: {}, additionalProperties: false },
  postconditionId,
  summary,
}) {
  const targetBinding = sourceType === 'form'
    ? { role: 'form', name: normalizedText(target.name), formRef: null }
    : {
      role: normalizedLower(target.role) || 'button',
      name: normalizedText(target.name),
      formRef: target.formRef ?? null,
      ...(target.type ? { type: normalizedLower(target.type) } : {}),
    };
  if (!target.ref || targetBinding.name.length > 512) return null;
  const descriptor = {
    version: 1,
    name,
    title,
    description: `${description} The exact visible target and page fingerprint are bound before execution; page content remains untrusted.`,
    classification: 'mutate',
    kind: 'mutate',
    risk: 'transactional',
    sourceType,
    requiresApproval: true,
    inputSchema,
    annotations: { readOnlyHint: false, untrustedContentHint: true },
    provenance: {
      source: 'toolbraid.verified-adapter',
      adapterId: 'github',
      adapterVersion: String(version),
      generatorVersion: 1,
      pageFingerprint: snapshot.pageFingerprint,
      snapshotFingerprint: snapshot.pageFingerprint,
      url: route.url.href,
      origin: route.url.origin,
      sourceType,
      elementRef: target.ref,
      targetFingerprint: elementFingerprint(target),
    },
    pageFingerprint: snapshot.pageFingerprint,
    target: {
      ref: target.ref,
      elementRef: target.ref,
      type: sourceType,
      targetFingerprint: elementFingerprint(target),
      binding: targetBinding,
    },
    elementRef: target.ref,
    effect: {
      classification: 'mutate',
      summary,
      externalStateChange: true,
      requiresApproval: true,
    },
    postcondition: mutationContract(postconditionId, version),
    semanticEvidence: [{ source: 'verified-adapter', code: 'GITHUB_EXACT_VISIBLE_MUTATION', adapterVersion: String(version) }],
  };
  validateToolDescriptor(descriptor);
  return freezeDeep(descriptor);
}

function commentCount(snapshot, route) {
  const raw = sourceValue(issueSource(snapshot, route), 'comments', sourceValue(issueSource(snapshot, route), 'commentCount'));
  if (Array.isArray(raw)) return { count: raw.length, list: raw };
  if (plainObject(raw)) {
    const nested = sourceValue(raw, 'totalCount', sourceValue(raw, 'count', sourceValue(raw, 'total')));
    const value = count(nested);
    return value === null ? { count: null, list: null } : { count: value, list: null };
  }
  return { count: count(raw), list: null };
}

function sameGitHubRoute(left, right) {
  if (!left || !right || left.kind !== right.kind || left.owner !== right.owner) return false;
  if (left.repository !== right.repository) return false;
  if (left.kind === 'commit') return left.sha === right.sha;
  if (left.kind === 'issue' || left.kind === 'pull-request') return left.number === right.number;
  return true;
}

function postconditionResult(status, reasonCode, afterSnapshot, evidence = {}) {
  return {
    status,
    reasonCode,
    evidence,
    ...(typeof afterSnapshot?.pageFingerprint === 'string' ? { afterPageFingerprint: afterSnapshot.pageFingerprint } : {}),
  };
}

function verifyGitHubPostcondition({ tool, contract: suppliedContract, beforeSnapshot, afterSnapshot }, hosts) {
  const contract = suppliedContract ?? tool?.postcondition ?? null;
  const beforeRoute = routeFor(beforeSnapshot, hosts);
  const afterRoute = routeFor(afterSnapshot, hosts);
  if (!beforeRoute || !afterRoute || !sameGitHubRoute(beforeRoute, afterRoute)) {
    return postconditionResult('unverified', 'GITHUB_ROUTE_DRIFT', afterSnapshot);
  }
  const action = tool?.name;
  const expectedIds = {
    star_github_repository: POSTCONDITION_IDS.star,
    unstar_github_repository: POSTCONDITION_IDS.unstar,
    comment_github_issue: POSTCONDITION_IDS.issueComment,
    comment_github_pull_request: POSTCONDITION_IDS.pullRequestComment,
    close_github_issue: POSTCONDITION_IDS.issueClose,
    reopen_github_issue: POSTCONDITION_IDS.issueReopen,
    close_github_pull_request: POSTCONDITION_IDS.pullRequestClose,
    reopen_github_pull_request: POSTCONDITION_IDS.pullRequestReopen,
  };
  if (!expectedIds[action] || contract?.id !== expectedIds[action]) {
    return postconditionResult('unverified', 'GITHUB_CONTRACT_MISMATCH', afterSnapshot);
  }
  if (action === 'star_github_repository' || action === 'unstar_github_repository') {
    const desiredBefore = action === 'star_github_repository' ? 'star' : 'unstar';
    const desiredAfter = desiredBefore === 'star' ? 'unstar' : 'star';
    if (!repositoryStarControl(beforeSnapshot, desiredBefore)
      || !repositoryStarControl(afterSnapshot, desiredAfter)) {
      return postconditionResult('unverified', 'GITHUB_STAR_NOT_CONFIRMED', afterSnapshot);
    }
    return postconditionResult('verified-success', 'GITHUB_STAR_STATE_CONFIRMED', afterSnapshot, { action });
  }
  if (action.includes('comment')) {
    const beforeComments = commentCount(beforeSnapshot, beforeRoute);
    const afterComments = commentCount(afterSnapshot, afterRoute);
    if (beforeComments.count === null || afterComments.count !== beforeComments.count + 1) {
      return postconditionResult('unverified', 'GITHUB_COMMENT_NOT_CONFIRMED', afterSnapshot, {
        beforeCount: beforeComments.count,
        afterCount: afterComments.count,
      });
    }
    return postconditionResult('verified-success', 'GITHUB_COMMENT_COUNT_CONFIRMED', afterSnapshot, {
      beforeCount: beforeComments.count,
      afterCount: afterComments.count,
    });
  }
  const isClose = action.startsWith('close_');
  const beforeState = issueState(beforeSnapshot, beforeRoute);
  const afterState = issueState(afterSnapshot, afterRoute);
  const expectedBefore = isClose ? 'open' : 'closed';
  const expectedAfter = isClose ? 'closed' : 'open';
  if (beforeRoute.kind === 'pull-request'
    && (boundedBoolean(issueSource(beforeSnapshot, beforeRoute)?.merged, false)
      || boundedBoolean(issueSource(afterSnapshot, afterRoute)?.merged, false))) {
    return postconditionResult('unverified', 'GITHUB_MERGED_PR_STATE', afterSnapshot);
  }
  const expectedBeforeControl = issueActionControl(beforeSnapshot, beforeRoute, isClose ? 'close' : 'reopen');
  const expectedAfterControl = issueActionControl(afterSnapshot, afterRoute, isClose ? 'reopen' : 'close');
  const structuredStateConfirmed = beforeState === expectedBefore && afterState === expectedAfter;
  const controlTransitionConfirmed = Boolean(expectedBeforeControl && expectedAfterControl);
  if (!structuredStateConfirmed && !controlTransitionConfirmed) {
    return postconditionResult('unverified', 'GITHUB_STATE_NOT_CONFIRMED', afterSnapshot, {
      beforeState,
      afterState,
      controlTransitionConfirmed,
    });
  }
  return postconditionResult('verified-success', 'GITHUB_STATE_CONFIRMED', afterSnapshot, {
    beforeState,
    afterState,
    controlTransitionConfirmed,
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
      const tools = [descriptorFor(snapshot, route, version)];
      if (route.kind === 'repository') {
        const star = repositoryStarControl(snapshot, 'star');
        const unstar = repositoryStarControl(snapshot, 'unstar');
        // A repository cannot truthfully expose both inverse states at once.
        // Treat that observation as ambiguous instead of allowing either
        // mutation to be selected from a contradictory page.
        if (star && !unstar) tools.push(mutationDescriptor(snapshot, route, version, {
          name: 'star_github_repository',
          title: 'Star GitHub repository',
          description: 'Star the exact visible GitHub repository after explicit human approval.',
          target: star,
          sourceType: 'control',
          postconditionId: POSTCONDITION_IDS.star,
          summary: 'Change the exact visible GitHub repository star state.',
        }));
        if (unstar && !star) tools.push(mutationDescriptor(snapshot, route, version, {
          name: 'unstar_github_repository',
          title: 'Unstar GitHub repository',
          description: 'Remove the star from the exact visible GitHub repository after explicit human approval.',
          target: unstar,
          sourceType: 'control',
          postconditionId: POSTCONDITION_IDS.unstar,
          summary: 'Change the exact visible GitHub repository star state.',
        }));
      } else {
        const comment = commentFormFor(snapshot, route);
        if (comment) {
          const inputProperty = commentInputProperty(comment.editor);
          const commentId = route.kind === 'issue' ? POSTCONDITION_IDS.issueComment : POSTCONDITION_IDS.pullRequestComment;
          tools.push(mutationDescriptor(snapshot, route, version, {
            name: route.kind === 'issue' ? 'comment_github_issue' : 'comment_github_pull_request',
            title: route.kind === 'issue' ? 'Comment on GitHub issue' : 'Comment on GitHub pull request',
            description: `Post a comment to the exact visible GitHub ${route.kind === 'issue' ? 'issue' : 'pull request'} after explicit human approval.`,
            target: comment.form,
            sourceType: 'form',
            inputSchema: {
              type: 'object',
              properties: {
                [inputProperty]: {
                  type: 'string',
                  minLength: 1,
                  maxLength: COMMENT_INPUT_MAX,
                  description: 'Comment text to submit to the exact visible GitHub page.',
                },
              },
              required: [inputProperty],
              additionalProperties: false,
            },
            postconditionId: commentId,
            summary: `Post a comment to the exact visible GitHub ${route.kind === 'issue' ? 'issue' : 'pull request'}.`,
          }));
        }
        const state = issueState(snapshot, route);
        const close = issueActionControl(snapshot, route, 'close');
        const reopen = issueActionControl(snapshot, route, 'reopen');
        if (state !== 'merged' && close && !reopen && (state === null || state === 'open')) {
          tools.push(mutationDescriptor(snapshot, route, version, {
            name: route.kind === 'issue' ? 'close_github_issue' : 'close_github_pull_request',
            title: route.kind === 'issue' ? 'Close GitHub issue' : 'Close GitHub pull request',
            description: `Close the exact visible GitHub ${route.kind === 'issue' ? 'issue' : 'pull request'} after explicit human approval.`,
            target: close,
            sourceType: 'control',
            postconditionId: route.kind === 'issue' ? POSTCONDITION_IDS.issueClose : POSTCONDITION_IDS.pullRequestClose,
            summary: `Close the exact visible GitHub ${route.kind === 'issue' ? 'issue' : 'pull request'}.`,
          }));
        } else if (state !== 'merged' && reopen && !close && (state === null || state === 'closed')) {
          tools.push(mutationDescriptor(snapshot, route, version, {
            name: route.kind === 'issue' ? 'reopen_github_issue' : 'reopen_github_pull_request',
            title: route.kind === 'issue' ? 'Reopen GitHub issue' : 'Reopen GitHub pull request',
            description: `Reopen the exact visible GitHub ${route.kind === 'issue' ? 'issue' : 'pull request'} after explicit human approval.`,
            target: reopen,
            sourceType: 'control',
            postconditionId: route.kind === 'issue' ? POSTCONDITION_IDS.issueReopen : POSTCONDITION_IDS.pullRequestReopen,
            summary: `Reopen the exact visible GitHub ${route.kind === 'issue' ? 'issue' : 'pull request'}.`,
          }));
        }
      }
      return Object.freeze(tools.filter(Boolean));
    },
    verifyPostcondition(context) {
      return verifyGitHubPostcondition(context, allowedHosts);
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
