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
import { elementFingerprint } from '../universal/snapshot.js';
import { validateToolDescriptor } from '../universal/tools.js';

export const VERCEL_HOSTS = Object.freeze(['vercel.com', 'www.vercel.com']);
export const VERCEL_ADAPTER_VERSION = '1';
export const VERCEL_POSTCONDITION_IDS = Object.freeze({
  redeploy: 'vercel.deployment.redeploy.v1',
  cancel: 'vercel.deployment.cancel.v1',
});

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

const DEPLOYMENT_REDEPLOY_STATES = new Set(['ready', 'error', 'failed', 'canceled', 'cancelled']);
const DEPLOYMENT_CANCEL_STATES = new Set(['queued', 'building', 'initializing', 'pending', 'waiting']);
function controlAttribute(control, ...keys) {
  const attributes = plainObject(control?.attributes) ? control.attributes : {};
  for (const key of keys) {
    if (Object.hasOwn(attributes, key)) return boundedText(attributes[key], null, 256);
  }
  return null;
}

function controlEnabled(control) {
  if (!plainObject(control) || control.disabled === true || control.pressed === true || control.checked === true) return false;
  if (String(controlAttribute(control, 'aria-disabled', 'ariaDisabled') ?? '').toLowerCase() === 'true') return false;
  if (String(controlAttribute(control, 'aria-pressed', 'ariaPressed') ?? '').toLowerCase() === 'true') return false;
  if (String(controlAttribute(control, 'aria-checked', 'ariaChecked') ?? '').toLowerCase() === 'true') return false;
  if (String(controlAttribute(control, 'aria-hidden', 'ariaHidden', 'hidden') ?? '').toLowerCase() === 'true') return false;
  if (Object.hasOwn(control?.attributes ?? {}, 'disabled')
    && String(controlAttribute(control, 'disabled') ?? '').toLowerCase() !== 'false') return false;
  if (Object.hasOwn(control?.attributes ?? {}, 'hidden')
    && String(controlAttribute(control, 'hidden') ?? '').toLowerCase() !== 'false') return false;
  if (control.hidden === true) return false;
  const role = text(control.role, '', 64).toLowerCase();
  const type = text(control.type, '', 64).toLowerCase();
  return role === 'button' || type === 'button' || type === 'submit';
}

function controlRole(control) {
  const role = text(control?.role, '', 64).toLowerCase();
  if (role) return role;
  const type = text(control?.type, '', 64).toLowerCase();
  return ['button', 'submit'].includes(type) ? 'button' : null;
}

function namedActionKind(control) {
  const name = text(control.name, '', 256).toLowerCase();
  if (/^redeploy(?:\s+(?:this\s+)?deployment)?(?:\s+now)?$/.test(name)) return 'redeploy';
  if (/^(?:cancel|stop)(?:\s+(?:this\s+)?)?(?:deployment|build)?$/.test(name)) return 'cancel';
  return null;
}

function actionKindForControl(control) {
  return controlEnabled(control) ? namedActionKind(control) : null;
}

function deploymentState(snapshot, route) {
  return text(deploymentEvidence(snapshot, route).state, null, 64)?.toLowerCase() ?? null;
}

function deploymentId(snapshot, route) {
  return deploymentEvidence(snapshot, route).deploymentId;
}

function uniqueDeploymentActionControl(snapshot, kind) {
  const matches = (Array.isArray(snapshot?.accessibleControls) ? snapshot.accessibleControls : [])
    .filter((control) => namedActionKind(control) === kind);
  return matches.length === 1 && actionKindForControl(matches[0]) === kind ? matches[0] : null;
}

function actionDescriptor(snapshot, route, control, kind, version) {
  const redeploy = kind === 'redeploy';
  const name = redeploy ? 'redeploy_vercel_deployment' : 'cancel_vercel_deployment';
  const title = redeploy ? 'Redeploy Vercel deployment' : 'Cancel Vercel deployment';
  const summary = redeploy
    ? `Redeploy the exact visible Vercel deployment ${route.deployment} after explicit approval.`
    : `Cancel the exact visible Vercel deployment ${route.deployment} after explicit approval.`;
  const targetFingerprint = elementFingerprint(control);
  const postcondition = {
    version: 1,
    id: redeploy ? VERCEL_POSTCONDITION_IDS.redeploy : VERCEL_POSTCONDITION_IDS.cancel,
    adapterId: 'vercel',
    adapterVersion: version,
    observation: 'page-snapshot',
  };
  const descriptor = {
    version: 1,
    name,
    title,
    description: `${summary} The page and deployment result remain untrusted until the postcondition is observed.`,
    classification: 'mutate',
    kind: 'mutate',
    risk: 'transactional',
    sourceType: 'control',
    requiresApproval: true,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: false, untrustedContentHint: true },
    provenance: {
      source: 'toolbraid.verified-adapter',
      adapterId: 'vercel',
      adapterVersion: version,
      generatorVersion: 1,
      pageFingerprint: snapshot.pageFingerprint,
      snapshotFingerprint: snapshot.pageFingerprint,
      url: snapshot.metadata.url,
      origin: route.url.origin,
      sourceType: 'control',
      elementRef: control.ref,
      targetFingerprint,
    },
    pageFingerprint: snapshot.pageFingerprint,
    target: {
      ref: control.ref,
      elementRef: control.ref,
      type: 'control',
      targetFingerprint,
      binding: {
        role: controlRole(control),
        name: text(control.name, '', 256),
        formRef: control.formRef ?? null,
        ...(text(control.type, '', 64) ? { type: text(control.type, '', 64).toLowerCase() } : {}),
      },
    },
    elementRef: control.ref,
    effect: {
      classification: 'mutate',
      summary,
      externalStateChange: true,
      requiresApproval: true,
    },
    semanticEvidence: [{
      source: 'verified-adapter',
      code: redeploy ? 'VERCEL_REDEPLOY_CONTROL' : 'VERCEL_CANCEL_CONTROL',
      adapterVersion: version,
      deploymentId: route.deployment,
    }],
    postcondition,
  };
  validateToolDescriptor(descriptor);
  return Object.freeze(descriptor);
}

function sameDeploymentProject(beforeRoute, afterRoute) {
  return beforeRoute?.kind === 'deployment'
    && afterRoute?.kind === 'deployment'
    && beforeRoute.owner.toLowerCase() === afterRoute.owner.toLowerCase()
    && beforeRoute.project.toLowerCase() === afterRoute.project.toLowerCase();
}

function verifyDeploymentPostcondition({ contract, beforeSnapshot, afterSnapshot, hosts = VERCEL_HOSTS }) {
  const beforeRoute = routeFor(beforeSnapshot, hosts);
  const afterRoute = routeFor(afterSnapshot, hosts);
  if (!sameDeploymentProject(beforeRoute, afterRoute)) {
    return {
      status: 'unverified',
      reasonCode: 'VERCEL_DEPLOYMENT_PAGE_MISMATCH',
      evidence: { action: contract.id, beforeRoute: beforeRoute?.kind ?? null, afterRoute: afterRoute?.kind ?? null },
    };
  }
  const beforeId = deploymentId(beforeSnapshot, beforeRoute);
  const afterId = deploymentId(afterSnapshot, afterRoute);
  const beforeState = deploymentState(beforeSnapshot, beforeRoute);
  const afterState = deploymentState(afterSnapshot, afterRoute);
  const evidence = { action: contract.id, beforeDeploymentId: beforeId, afterDeploymentId: afterId, beforeState, afterState };

  if (contract.id === VERCEL_POSTCONDITION_IDS.cancel) {
    const beforeControl = uniqueDeploymentActionControl(beforeSnapshot, 'cancel');
    if (beforeId === afterId && beforeControl
      && (beforeState === null || DEPLOYMENT_CANCEL_STATES.has(beforeState))
      && ['canceled', 'cancelled'].includes(afterState)) {
      return { status: 'verified-success', reasonCode: 'VERCEL_CANCEL_STATE_CONFIRMED', evidence };
    }
    return { status: 'unverified', reasonCode: 'VERCEL_CANCEL_NOT_CONFIRMED', evidence };
  }

  const newDeployment = Boolean(beforeId && afterId && beforeId !== afterId);
  const beforeControl = uniqueDeploymentActionControl(beforeSnapshot, 'redeploy');
  const matchingCommit = !beforeSnapshot || !afterSnapshot
    ? false
    : (() => {
      const beforeCommit = deploymentEvidence(beforeSnapshot, beforeRoute).commitSha;
      const afterCommit = deploymentEvidence(afterSnapshot, afterRoute).commitSha;
      return !beforeCommit || !afterCommit || beforeCommit === afterCommit;
    })();
  const beforeStateAllowsRedeploy = beforeState === null || DEPLOYMENT_REDEPLOY_STATES.has(beforeState);
  if (newDeployment && beforeControl && beforeStateAllowsRedeploy && matchingCommit
    && (afterState === null || ['queued', 'building', 'initializing', 'pending', 'waiting', 'ready'].includes(afterState))) {
    return { status: 'verified-success', reasonCode: 'VERCEL_REDEPLOY_STATE_CONFIRMED', evidence };
  }
  if (newDeployment && beforeControl && beforeStateAllowsRedeploy && matchingCommit && afterState === 'error') {
    return { status: 'verified-failure', reasonCode: 'VERCEL_REDEPLOY_FAILED', evidence };
  }
  return { status: 'unverified', reasonCode: 'VERCEL_REDEPLOY_NOT_CONFIRMED', evidence };
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
      const tools = [descriptorFor(snapshot, route, version)];
      if (route.kind !== 'deployment') return Object.freeze(tools);

      const state = deploymentState(snapshot, route);
      const redeployControl = (state === null || DEPLOYMENT_REDEPLOY_STATES.has(state))
        ? uniqueDeploymentActionControl(snapshot, 'redeploy')
        : null;
      if (redeployControl) tools.push(actionDescriptor(snapshot, route, redeployControl, 'redeploy', version));

      const cancelControl = (state === null || DEPLOYMENT_CANCEL_STATES.has(state))
        ? uniqueDeploymentActionControl(snapshot, 'cancel')
        : null;
      if (cancelControl) tools.push(actionDescriptor(snapshot, route, cancelControl, 'cancel', version));
      return Object.freeze(tools);
    },
    executeRead(tool, snapshot) {
      const route = routeFor(snapshot, allowedHosts);
      if (!route) return null;
      const expectedName = route.kind === 'project' ? 'read_vercel_project' : 'read_vercel_deployment';
      if (tool?.name !== expectedName || tool?.sourceType !== `vercel-${route.kind}`) return null;
      return extractVercelPage(snapshot);
    },
    verifyPostcondition(context = {}) {
      const id = context?.contract?.id ?? context?.tool?.postcondition?.id;
      if (![VERCEL_POSTCONDITION_IDS.redeploy, VERCEL_POSTCONDITION_IDS.cancel].includes(id)) {
        return { status: 'unverified', reasonCode: 'VERCEL_POSTCONDITION_UNKNOWN' };
      }
      const result = verifyDeploymentPostcondition({
        ...context,
        hosts: allowedHosts,
        contract: context.contract ?? context.tool.postcondition,
      });
      return {
        ...result,
        afterPageFingerprint: context.afterSnapshot?.pageFingerprint ?? null,
      };
    },
  });
}

export const createVercelPageAdapter = createVercelAdapter;
