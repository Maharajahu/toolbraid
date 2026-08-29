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
  firstText,
  freezeUntrusted,
  metadataRecord,
  plainObject,
  readDescriptor,
  safeHttpUrl,
  safeDomain,
} from './common.js';

export const VERCEL_HOSTS = Object.freeze(['vercel.com', 'www.vercel.com']);
export const VERCEL_ADAPTER_VERSION = '1';

const SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const RESERVED_ROOTS = new Set([
  'account', 'analytics', 'changelog', 'contact', 'dashboard', 'docs', 'domains', 'enterprise',
  'guides', 'help', 'login', 'new', 'pricing', 'recover', 'settings', 'templates', 'teams',
  'upgrade', 'usage', 'users', 'vc', 'api', 'integrations', 'support',
]);
const RESERVED_DEPLOYMENT_SEGMENTS = new Set([
  'analytics', 'deployments', 'domains', 'functions', 'logs', 'overview', 'settings', 'storage', 'team',
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

function count(value, fallback = null) {
  return boundedInteger(value, fallback, { min: 0, max: Number.MAX_SAFE_INTEGER });
}

function number(value, fallback = null) {
  return boundedNumber(value, fallback, { min: 0, max: Number.MAX_SAFE_INTEGER });
}

function sourceRecord(snapshot) {
  const metadata = plainObject(snapshot?.metadata) ? snapshot.metadata : {};
  const vercel = metadataRecord(snapshot, 'vercel');
  const nestedProject = plainObject(vercel.project) ? vercel.project : {};
  const nestedDeployment = plainObject(vercel.deployment) ? vercel.deployment : {};
  return { metadata, vercel, nestedProject, nestedDeployment };
}

function sourceValue(source, key, ...fallbacks) {
  if (plainObject(source) && Object.hasOwn(source, key) && source[key] !== undefined && source[key] !== null) return source[key];
  for (const fallback of fallbacks) {
    if (fallback !== undefined && fallback !== null) return fallback;
  }
  return null;
}

function routeFor(snapshot, hosts = VERCEL_HOSTS) {
  const allowedHosts = hosts instanceof Set ? hosts : new Set([...hosts].map((host) => String(host).toLowerCase()));
  const url = canonicalUrl(snapshot, allowedHosts);
  if (!url) return null;
  const segments = exactPathSegments(url);
  if (!segments || segments.length < 2 || segments.length > 4) return null;
  const [owner, project, third, fourth] = segments;
  if (!SEGMENT_PATTERN.test(owner) || !SEGMENT_PATTERN.test(project) || RESERVED_ROOTS.has(owner.toLowerCase())) return null;
  const base = { url, owner, project };
  if (segments.length === 2) return { ...base, kind: 'project' };
  if (segments.length === 3 && SEGMENT_PATTERN.test(third) && !RESERVED_DEPLOYMENT_SEGMENTS.has(third.toLowerCase())) {
    return { ...base, kind: 'deployment', deployment: third };
  }
  if (segments.length === 4 && third === 'deployments' && SEGMENT_PATTERN.test(fourth)) {
    return { ...base, kind: 'deployment', deployment: fourth };
  }
  return null;
}

function linkFor(snapshot, predicate) {
  if (!Array.isArray(snapshot?.links)) return null;
  return snapshot.links.find((link) => predicate(link)) ?? null;
}

function deploymentLink(snapshot) {
  return linkFor(snapshot, (link) => {
    const href = safeHttpUrl(link?.href);
    if (!href) return false;
    try {
      const hostname = new URL(href).hostname.toLowerCase();
      return hostname === 'vercel.app' || hostname.endsWith('.vercel.app');
    } catch {
      return false;
    }
  });
}

function repositoryLink(snapshot) {
  return linkFor(snapshot, (link) => {
    const href = safeHttpUrl(link?.href);
    if (!href) return false;
    try {
      const url = new URL(href);
      if (!['github.com', 'www.github.com'].includes(url.hostname.toLowerCase())) return false;
      const segments = exactPathSegments(url);
      return Boolean(segments && segments.length >= 2);
    } catch {
      return false;
    }
  });
}

function projectEvidence(snapshot, route) {
  const { metadata, vercel, nestedProject } = sourceRecord(snapshot);
  const latestRaw = sourceValue(nestedProject, 'latestDeployment', sourceValue(vercel, 'latestDeployment'));
  const latestDeployment = plainObject(latestRaw)
    ? {
      id: text(latestRaw.id ?? latestRaw.deploymentId, null, 256),
      state: text(latestRaw.state ?? latestRaw.status, null, 64),
      url: safeHttpUrl(latestRaw.url ?? latestRaw.deploymentUrl),
      createdAt: text(latestRaw.createdAt ?? latestRaw.created_at, null, 128),
    }
    : null;
  const repository = sourceValue(nestedProject, 'repository', sourceValue(vercel, 'repository'));
  return freezeUntrusted({
    type: 'vercel-project',
    project: {
      id: text(sourceValue(nestedProject, 'id', sourceValue(vercel, 'projectId')), null, 256),
      name: text(sourceValue(nestedProject, 'name', sourceValue(vercel, 'projectName'), route.project), route.project, 256),
      owner: identityText(sourceValue(nestedProject, 'owner', sourceValue(vercel, 'owner'), route.owner), route.owner, 256),
      team: identityText(sourceValue(nestedProject, 'team', sourceValue(vercel, 'team')), null, 256),
    },
    url: route.url.href,
    title: text(sourceValue(nestedProject, 'title', sourceValue(vercel, 'title'), firstHeading(snapshot), metadata.title), route.project, 1024),
    description: text(sourceValue(nestedProject, 'description', sourceValue(vercel, 'description'), metadata.description), null, 4096),
    framework: text(sourceValue(nestedProject, 'framework', sourceValue(vercel, 'framework')), null, 128),
    productionDomain: safeDomain(sourceValue(nestedProject, 'productionDomain', sourceValue(vercel, 'productionDomain'))),
    productionUrl: safeHttpUrl(sourceValue(nestedProject, 'productionUrl', sourceValue(vercel, 'productionUrl'))),
    repository: identityText(plainObject(repository) ? repository.name ?? repository.fullName : repository, null, 512),
    repositoryUrl: safeHttpUrl(plainObject(repository) ? repository.url : repositoryLink(snapshot)?.href),
    defaultBranch: text(sourceValue(nestedProject, 'defaultBranch', sourceValue(vercel, 'defaultBranch')), null, 256),
    status: text(sourceValue(nestedProject, 'status', sourceValue(vercel, 'status')), null, 64),
    deploymentCount: count(sourceValue(nestedProject, 'deploymentCount', sourceValue(vercel, 'deploymentCount'))),
    updatedAt: text(sourceValue(nestedProject, 'updatedAt', sourceValue(vercel, 'updatedAt')), null, 128),
    latestDeployment,
    environments: boundedStringArray(sourceValue(nestedProject, 'environments', sourceValue(vercel, 'environments')), { max: 16, itemLimit: 64 }),
    evidence: boundedJson(sourceValue(vercel, 'evidence'), { maxDepth: 3, maxEntries: 24, maxArray: 32 }),
    pageFingerprint: snapshot.pageFingerprint,
    provenance: 'toolbraid.verified-adapter/vercel',
    untrustedContent: true,
  });
}

function deploymentEvidence(snapshot, route) {
  const { metadata, vercel, nestedDeployment } = sourceRecord(snapshot);
  const deployment = nestedDeployment;
  const deploymentLinkValue = deploymentLink(snapshot);
  return freezeUntrusted({
    type: 'vercel-deployment',
    project: {
      owner: route.owner,
      name: route.project,
    },
    url: route.url.href,
    deploymentId: text(sourceValue(deployment, 'id', sourceValue(deployment, 'deploymentId'), sourceValue(vercel, 'deploymentId'), route.deployment), route.deployment, 256),
    deploymentUrl: safeHttpUrl(sourceValue(deployment, 'url', sourceValue(deployment, 'deploymentUrl'), sourceValue(vercel, 'deploymentUrl'), deploymentLinkValue?.href)),
    state: text(sourceValue(deployment, 'state', sourceValue(deployment, 'status'), sourceValue(vercel, 'state'), sourceValue(vercel, 'status')), null, 64),
    environment: text(sourceValue(deployment, 'environment', sourceValue(vercel, 'environment')), null, 64),
    createdAt: text(sourceValue(deployment, 'createdAt', sourceValue(deployment, 'created_at'), sourceValue(vercel, 'createdAt')), null, 128),
    completedAt: text(sourceValue(deployment, 'completedAt', sourceValue(deployment, 'completed_at')), null, 128),
    durationMs: number(sourceValue(deployment, 'durationMs', sourceValue(deployment, 'duration'))),
    commitSha: text(sourceValue(deployment, 'commitSha', sourceValue(deployment, 'gitCommitSha'), sourceValue(vercel, 'commitSha')), null, 128),
    branch: text(sourceValue(deployment, 'branch', sourceValue(deployment, 'gitBranch'), sourceValue(vercel, 'branch')), null, 256),
    creator: identityText(sourceValue(deployment, 'creator', sourceValue(deployment, 'user'), sourceValue(vercel, 'creator')), null, 256),
    region: text(sourceValue(deployment, 'region', sourceValue(vercel, 'region')), null, 128),
    build: plainObject(sourceValue(deployment, 'build', sourceValue(vercel, 'build')))
      ? boundedJson(sourceValue(deployment, 'build', sourceValue(vercel, 'build')), { maxDepth: 3, maxEntries: 32, maxArray: 32 })
      : null,
    checks: Array.isArray(sourceValue(deployment, 'checks', sourceValue(vercel, 'checks')))
      ? sourceValue(deployment, 'checks', sourceValue(vercel, 'checks')).slice(0, 32).map((check) => plainObject(check) ? {
        name: text(check.name ?? check.label, null, 256),
        state: text(check.state ?? check.status, null, 64),
      } : null).filter((check) => check?.name)
      : [],
    title: text(sourceValue(deployment, 'title', firstHeading(snapshot), metadata.title), route.deployment, 1024),
    pageFingerprint: snapshot.pageFingerprint,
    provenance: 'toolbraid.verified-adapter/vercel',
    untrustedContent: true,
  });
}

function descriptorFor(snapshot, route, version) {
  const labels = route.kind === 'project'
    ? ['read_vercel_project', 'Read Vercel project', 'project']
    : ['read_vercel_deployment', 'Read Vercel deployment', 'deployment'];
  return readDescriptor(snapshot, {
    adapterId: 'vercel',
    adapterVersion: version,
    sourceType: `vercel-${route.kind}`,
    name: labels[0],
    title: labels[1],
    description: `Read structured evidence from the visible Vercel ${labels[2]} page without changing Vercel state.`,
    effectSummary: `Read the visible Vercel ${labels[2]} as structured, untrusted evidence.`,
    evidence: [{ code: `VERCEL_${route.kind.toUpperCase()}_ROUTE`, owner: route.owner, project: route.project }],
  });
}

export function parseVercelRoute(snapshot, { hosts = VERCEL_HOSTS } = {}) {
  const route = routeFor(snapshot, new Set([...hosts].map((host) => String(host).toLowerCase())));
  return route ? Object.freeze({ ...route, url: route.url.href }) : null;
}

export function extractVercelProject(snapshot) {
  const route = routeFor(snapshot);
  return route?.kind === 'project' ? projectEvidence(snapshot, route) : null;
}

export function extractVercelDeployment(snapshot) {
  const route = routeFor(snapshot);
  return route?.kind === 'deployment' ? deploymentEvidence(snapshot, route) : null;
}

export function extractVercelPage(snapshot) {
  const route = routeFor(snapshot);
  if (!route) return null;
  return route.kind === 'project' ? projectEvidence(snapshot, route) : deploymentEvidence(snapshot, route);
}

export function createVercelAdapter({ hosts = VERCEL_HOSTS, version = VERCEL_ADAPTER_VERSION } = {}) {
  const allowedHosts = new Set([...hosts].map((host) => String(host).toLowerCase()));
  return Object.freeze({
    id: 'vercel',
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
      const expectedName = route.kind === 'project' ? 'read_vercel_project' : 'read_vercel_deployment';
      if (tool?.name !== expectedName || tool?.sourceType !== `vercel-${route.kind}`) return null;
      return extractVercelPage(snapshot);
    },
  });
}

export const createVercelPageAdapter = createVercelAdapter;
