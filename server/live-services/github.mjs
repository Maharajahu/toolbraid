import { createHash } from 'node:crypto';

import { githubConfig } from './config.mjs';
import { liveServiceError, upstreamError } from './errors.mjs';

const GITHUB_API = 'https://api.github.com';
const GITHUB_API_VERSION = '2026-03-10';
const LIVE_TARGET_ALIAS = 'checkout';

function boundedInteger(value, fallback, { minimum = 1, maximum = 20 } = {}) {
  if (value === undefined || value === null || value === '') return fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
    throw liveServiceError('LIVE_INPUT_INVALID', `Expected an integer from ${minimum} to ${maximum}.`);
  }
  return number;
}

function requiredText(value, field, maximum) {
  if (typeof value !== 'string' || value.trim() === '' || value.length > maximum) {
    throw liveServiceError('LIVE_INPUT_INVALID', `${field} must be a non-empty string of at most ${maximum} characters.`);
  }
  return value;
}

function issuePhase(issue) {
  if (issue.state === 'closed') return 'resolved';
  const labels = Array.isArray(issue.labels)
    ? issue.labels.map((label) => String(typeof label === 'string' ? label : label?.name ?? '').toLowerCase())
    : [];
  if (labels.some((label) => label.includes('degraded') || label.includes('incident'))) return 'degraded';
  return 'investigating';
}

function markerFor(requestId) {
  const digest = createHash('sha256').update(requestId, 'utf8').digest('hex');
  return `<!-- toolbraid-idempotency:${digest} -->`;
}

async function parseJson(response, provider) {
  if (!response.ok) throw upstreamError(provider, response);
  try {
    return await response.json();
  } catch (cause) {
    throw liveServiceError(
      `${provider.toUpperCase()}_RESPONSE_INVALID`,
      `${provider} returned an invalid JSON response.`,
      { status: 502, cause },
    );
  }
}

export function createGitHubService({
  fetchImpl = globalThis.fetch,
  env = process.env,
  config = githubConfig(env),
} = {}) {
  if (typeof fetchImpl !== 'function') {
    throw liveServiceError('LIVE_FETCH_MISSING', 'A fetch implementation is required.', { status: 503 });
  }

  const repositoryPath = `${encodeURIComponent(config.repository.owner)}/${encodeURIComponent(config.repository.repo)}`;
  const issueNumber = config.incidentIssueNumber;
  const expectedIncidentId = `github:${LIVE_TARGET_ALIAS}#${issueNumber}`;
  const headers = Object.freeze({
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${config.token}`,
    'User-Agent': 'ToolBraid-live-services',
    'X-GitHub-Api-Version': GITHUB_API_VERSION,
  });

  function assertTarget(alias) {
    if (alias !== LIVE_TARGET_ALIAS) {
      throw liveServiceError('TARGET_DENIED', 'The requested service alias is not allowlisted.', { status: 403 });
    }
  }

  async function request(path, { method = 'GET', body } = {}) {
    let response;
    try {
      response = await fetchImpl(`${GITHUB_API}${path}`, {
        method,
        headers: body === undefined ? headers : { ...headers, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (cause) {
      throw liveServiceError('GITHUB_UNAVAILABLE', 'GitHub could not be reached.', { status: 502, cause });
    }
    return parseJson(response, 'GitHub');
  }

  async function getIssue() {
    return request(`/repos/${repositoryPath}/issues/${issueNumber}`);
  }

  async function getComments() {
    const query = new URLSearchParams({ per_page: '100', page: '1' });
    const comments = await request(`/repos/${repositoryPath}/issues/${issueNumber}/comments?${query}`);
    if (!Array.isArray(comments)) {
      throw liveServiceError('GITHUB_RESPONSE_INVALID', 'GitHub returned an invalid issue comment list.', {
        status: 502,
      });
    }
    return comments;
  }

  function incidentOutput(issue) {
    if (!issue || typeof issue !== 'object' || !Number.isInteger(issue.number)) {
      throw liveServiceError('GITHUB_RESPONSE_INVALID', 'GitHub returned an invalid incident issue.', {
        status: 502,
      });
    }
    return {
      incident_id: expectedIncidentId,
      headline: String(issue.title ?? `GitHub issue #${issueNumber}`),
      message: String(issue.body ?? ''),
      phase: issuePhase(issue),
      version: String(issue.updated_at ?? issue.created_at ?? ''),
      modified_at: String(issue.updated_at ?? issue.created_at ?? ''),
    };
  }

  return Object.freeze({
    async readCommitHistory({ repository, max_results: maxResults } = {}) {
      assertTarget(repository);
      const limit = boundedInteger(maxResults, 5);
      const query = new URLSearchParams({ per_page: String(limit) });
      if (config.ref) query.set('sha', config.ref);
      const commits = await request(`/repos/${repositoryPath}/commits?${query}`);
      if (!Array.isArray(commits)) {
        throw liveServiceError('GITHUB_RESPONSE_INVALID', 'GitHub returned an invalid commit history.', {
          status: 502,
        });
      }
      return {
        changes: commits.slice(0, limit).map((commit) => ({
          revision: String(commit?.sha ?? ''),
          change_summary: String(commit?.commit?.message ?? '').split(/\r?\n/, 1)[0],
          created_at: String(commit?.commit?.author?.date ?? commit?.commit?.committer?.date ?? ''),
          created_by: String(commit?.author?.login ?? commit?.commit?.author?.name ?? 'unknown'),
        })),
      };
    },

    async readIncidentIssue({ product } = {}) {
      assertTarget(product);
      return incidentOutput(await getIssue());
    },

    async publishIncidentUpdate(input = {}) {
      const incidentId = requiredText(input.incident_id, 'incident_id', 256);
      const version = requiredText(input.version, 'version', 128);
      const content = requiredText(input.content, 'content', 5000);
      const requestId = requiredText(input.request_id, 'request_id', 128);
      const headline = input.headline === undefined || input.headline === ''
        ? ''
        : requiredText(input.headline, 'headline', 200);
      if (incidentId !== expectedIncidentId) {
        throw liveServiceError('GITHUB_INCIDENT_DENIED', 'The requested incident issue is not allowlisted.', {
          status: 403,
        });
      }

      const marker = markerFor(requestId);
      const currentIssue = await getIssue();
      const existing = (await getComments()).find((comment) => String(comment?.body ?? '').includes(marker));
      if (existing) {
        return {
          update_id: `github-comment-${existing.id}`,
          outcome: 'published',
          created_at: String(existing.created_at ?? existing.updated_at ?? currentIssue.updated_at ?? ''),
          version: String(currentIssue.updated_at ?? version),
        };
      }
      if (String(currentIssue.updated_at ?? '') !== version) {
        throw liveServiceError(
          'GITHUB_INCIDENT_VERSION_STALE',
          'The GitHub incident changed after approval.',
          { status: 409 },
        );
      }

      const visibleBody = headline ? `### ${headline}\n\n${content}` : content;
      const comment = await request(`/repos/${repositoryPath}/issues/${issueNumber}/comments`, {
        method: 'POST',
        body: { body: `${visibleBody}\n\n${marker}` },
      });
      const updatedIssue = await getIssue();
      return {
        update_id: `github-comment-${comment.id}`,
        outcome: 'published',
        created_at: String(comment.created_at ?? comment.updated_at ?? updatedIssue.updated_at ?? ''),
        version: String(updatedIssue.updated_at ?? comment.updated_at ?? version),
      };
    },

    configSummary() {
      return Object.freeze({
        repository: config.repository.fullName,
        ref: config.ref,
        incidentIssueNumber: issueNumber,
      });
    },
  });
}
