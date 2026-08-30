import {
  createConstellationLayout,
  renderConstellationSvg,
} from './constellation.js';
import {
  hydrateIcons,
  iconMarkup,
  iconNameForNode,
} from './icons.js';
import {
  MISSION_EVENTS as EVENT,
  MISSION_NODE_STATUS as NODE_STATUS,
  MISSION_PHASES as PHASE,
  MissionStateError,
  createMissionState,
  selectActiveEdgeIds,
  selectMissionProgress,
  transitionMission,
} from './mission-state.js';
import { createMissionController } from './mission-controller.js';
import {
  MISSION_GUIDE_STEPS,
  MISSION_PROFILES,
  missionProfileById,
  resolveMissionProfile,
} from './mission-profiles.js';
import {
  RECOVERY_CAPABILITIES,
  RECOVERY_CAPABILITY_IDS as CAPABILITY_ID,
} from '../packs/recovery/ontology.js';
import {
  RECOVERY_PROVIDER_DESCRIPTORS,
  RECOVERY_PROVIDER_ORIGINS,
} from '../providers/recovery/catalog.js';

let activeProfile = resolveMissionProfile(window.location.search);

const PROVIDERS = Object.freeze(RECOVERY_PROVIDER_DESCRIPTORS.map(({ id, origin, label }) => ({ id, origin, label })));

const capabilityTitle = (capabilityId) => RECOVERY_CAPABILITIES.find(({ id }) => id === capabilityId)?.title ?? capabilityId;

const CAPABILITIES = Object.freeze([
  {
    id: CAPABILITY_ID.SERVICE_HEALTH_READ,
    label: 'Service health',
    providerOrigins: [RECOVERY_PROVIDER_ORIGINS.signals, RECOVERY_PROVIDER_ORIGINS.pulse],
  },
  {
    id: CAPABILITY_ID.RELEASE_HISTORY_READ,
    label: 'Release history',
    providerOrigin: RECOVERY_PROVIDER_ORIGINS.source,
  },
  {
    id: CAPABILITY_ID.DEPLOYMENT_HISTORY_READ,
    label: 'Deployment state',
    providerOrigin: RECOVERY_PROVIDER_ORIGINS.deploy,
  },
  {
    id: CAPABILITY_ID.STATUS_NOTICE_READ,
    label: 'Status notice',
    providerOrigin: RECOVERY_PROVIDER_ORIGINS.status,
  },
  {
    id: CAPABILITY_ID.RECOVERY_OPTION_PREPARE,
    label: 'Prepare recovery',
    providerOrigin: RECOVERY_PROVIDER_ORIGINS.deploy,
  },
  {
    id: 'unsafe.override',
    label: 'Override approval',
    providerOrigin: RECOVERY_PROVIDER_ORIGINS.mirage,
    adversarial: true,
  },
]);

const MUTATIONS = Object.freeze([
  { id: CAPABILITY_ID.RECOVERY_OPTION_APPLY, label: 'Apply recovery' },
  { id: CAPABILITY_ID.STATUS_NOTICE_PUBLISH, label: 'Publish update' },
]);

const ENGINE_NODE_BY_CAPABILITY = Object.freeze({
  [CAPABILITY_ID.SERVICE_HEALTH_READ]: 'read-service-health',
  [CAPABILITY_ID.RELEASE_HISTORY_READ]: 'read-release-history',
  [CAPABILITY_ID.DEPLOYMENT_HISTORY_READ]: 'read-deployment-history',
  [CAPABILITY_ID.STATUS_NOTICE_READ]: 'read-status-notice',
  [CAPABILITY_ID.RECOVERY_OPTION_PREPARE]: 'prepare-recovery-option',
  [CAPABILITY_ID.RECOVERY_OPTION_APPLY]: 'apply-recovery-option',
  [CAPABILITY_ID.STATUS_NOTICE_PUBLISH]: 'publish-status-update',
});

const CAPABILITY_BY_ENGINE_NODE = Object.freeze(Object.fromEntries(
  Object.entries(ENGINE_NODE_BY_CAPABILITY).map(([capabilityId, nodeId]) => [nodeId, capabilityId]),
));

const LOCAL_PROVIDER_PORTS = Object.freeze({
  signals: 4174,
  pulse: 4175,
  source: 4176,
  deploy: 4177,
  status: 4178,
  mirage: 4179,
});

const PHASE_COPY = Object.freeze({
  [PHASE.IDLE]: 'Ready for objective',
  [PHASE.DISCOVERING]: 'Discovering provider origins',
  [PHASE.MAPPING]: 'Normalizing capabilities',
  [PHASE.READING]: 'Reading evidence in parallel',
  [PHASE.PREPARING]: 'Correlating evidence and preparing recovery',
  [PHASE.REVIEW]: 'Evidence ready for human review',
  [PHASE.APPROVED]: 'Exact effects approved',
  [PHASE.EXECUTING]: 'Executing approved mutations',
  [PHASE.COMPLETE]: 'Mission complete · audit sealed',
});

const EVENT_COPY = Object.freeze({
  [EVENT.START]: 'Mission started',
  [EVENT.DISCOVERY_RESULT]: 'Native tools discovered',
  [EVENT.TOOL_QUARANTINED]: 'Hostile metadata quarantined',
  [EVENT.DISCOVERY_COMPLETED]: 'Origin discovery complete',
  [EVENT.MAPPING_COMPLETED]: 'Capabilities normalized',
  [EVENT.PARALLEL_READS_STARTED]: 'Parallel evidence reads started',
  [EVENT.READ_NODE_COMPLETED]: 'Evidence read completed',
  [EVENT.READ_NODE_FAILED]: 'Provider read failed safely',
  [EVENT.PROVIDER_SWAPPED]: 'Read-only provider substituted',
  [EVENT.PREPARATION_COMPLETED]: 'Recovery option and customer draft prepared',
  [EVENT.PREPARATION_FAILED]: 'Recovery preparation failed closed',
  [EVENT.NODE_SELECTED]: 'Graph node inspected',
  [EVENT.APPLY_APPROVED]: 'Recovery effect approved',
  [EVENT.PUBLISH_APPROVED]: 'Customer update approved',
  [EVENT.PLAN_INVALIDATED]: 'Approval invalidated',
  [EVENT.EXECUTION_STARTED]: 'Approved mutations started',
  [EVENT.EXECUTION_NODE_COMPLETED]: 'Approved mutation completed',
  [EVENT.EXECUTION_FAILED]: 'Mutation failed closed',
  [EVENT.RESET]: 'Mission reset',
});

const ENGINE_EVENT_COPY = Object.freeze({
  'runtime.ready': 'WebMCP runtime ready',
  'mission.started': 'Objective accepted',
  'tool.discovered': 'Native tool discovered',
  'tool.quarantined': 'Unsafe tool quarantined',
  'discovery.completed': 'Registry discovery complete',
  'capability.mapped': 'Capability mapped',
  'plan.created': 'Recovery plan created',
  'node.started': 'Plan node started',
  'tool.execution_started': 'Tool execution started',
  'tool.execution_failed': 'Tool execution failed closed',
  'tool.failover_selected': 'Compatible fallback selected',
  'node.completed': 'Plan node completed',
  'node.failed': 'Plan node failed',
  'plan.mutations_finalized': 'Exact mutation arguments finalized',
  'evidence.completed': 'Read-only evidence checkpoint complete',
  'authority.challenge_rejected': 'Authority challenge rejected',
  'mission.read_only_completed': 'Read-only mission sealed',
  'mission.authority_completed': 'Security mission sealed',
  'approval.created': 'Human approval envelope created',
  'approval.claimed': 'Single-use approval claimed',
  'mission.completed': 'Mission completed',
  'registry.toolchange': 'Tool registry changed',
});

const AUDIT_PHASES = Object.freeze([
  { id: 'discover', label: 'Discover', hint: 'Origins and trust boundary' },
  { id: 'normalize', label: 'Normalize', hint: 'Canonical capability bindings' },
  { id: 'observe', label: 'Observe', hint: 'Read-only evidence and fallback' },
  { id: 'authorize', label: 'Authorize', hint: 'Human-bound mutation scopes' },
  { id: 'execute', label: 'Execute', hint: 'Receipts and local integrity' },
  { id: 'system', label: 'System', hint: 'Mission lifecycle details' },
]);

const AUDIT_EVENT_PHASE = new Map([
  [EVENT.START, 'discover'],
  [EVENT.DISCOVERY_RESULT, 'discover'],
  [EVENT.TOOL_QUARANTINED, 'discover'],
  [EVENT.DISCOVERY_COMPLETED, 'discover'],
  [EVENT.MAPPING_COMPLETED, 'normalize'],
  [EVENT.PARALLEL_READS_STARTED, 'observe'],
  [EVENT.READ_NODE_COMPLETED, 'observe'],
  [EVENT.READ_NODE_FAILED, 'observe'],
  [EVENT.PROVIDER_SWAPPED, 'observe'],
  [EVENT.PREPARATION_COMPLETED, 'observe'],
  [EVENT.PREPARATION_FAILED, 'observe'],
  [EVENT.APPLY_APPROVED, 'authorize'],
  [EVENT.PUBLISH_APPROVED, 'authorize'],
  [EVENT.PLAN_INVALIDATED, 'authorize'],
  [EVENT.EXECUTION_STARTED, 'execute'],
  [EVENT.EXECUTION_NODE_COMPLETED, 'execute'],
  [EVENT.EXECUTION_FAILED, 'execute'],
  [EVENT.RESET, 'system'],
]);

const q = (selector, root = document) => root.querySelector(selector);
const qa = (selector, root = document) => [...root.querySelectorAll(selector)];
const FOCUSABLE_SELECTOR = [
  'button:not([disabled])',
  'a[href]',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'summary',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

function visibleFocusTargets(root) {
  return qa(FOCUSABLE_SELECTOR, root).filter((element) => (
    !element.hidden
    && !element.closest('[hidden]')
    && !element.closest('[inert]')
    && element.getClientRects().length > 0
  ));
}

const baseLayout = createConstellationLayout({
  width: 1120,
  height: 620,
  centerX: 675,
  centerY: 283,
  outerRadius: 238,
  innerRadius: 142,
  providers: PROVIDERS,
  capabilities: CAPABILITIES,
  mutations: MUTATIONS,
  hub: { id: 'toolbraid', label: 'Mission plan', subtitle: 'Canonical capabilities' },
});

const nodeBySemantic = (semanticId, type) => baseLayout.nodes.find(
  (node) => node.semanticId === semanticId && (!type || node.type === type),
);

const providerNodeIds = baseLayout.providers.map((node) => node.id);
const hubNodeId = baseLayout.hub.id;
const readSemanticIds = Object.freeze([
  'service.health.read',
  'release.history.read',
  'deployment.history.read',
  'status.notice.read',
]);
const readNodeIds = readSemanticIds.map((id) => nodeBySemantic(id, 'capability').id);
const prepareNodeId = nodeBySemantic('recovery.option.prepare', 'capability').id;
const unsafeNodeId = nodeBySemantic('unsafe.override', 'capability').id;
const applyNodeId = nodeBySemantic('recovery.option.apply', 'mutation').id;
const publishNodeId = nodeBySemantic('status.notice.publish', 'mutation').id;
const mappableNodeIds = [...readNodeIds, prepareNodeId, applyNodeId, publishNodeId];

const providerCapabilityEdgeIds = baseLayout.edges
  .filter((edge) => edge.kind === 'provider-capability' && edge.to !== unsafeNodeId)
  .map((edge) => edge.id);
const discoveryEdgeIds = baseLayout.edges
  .filter((edge) => edge.kind === 'provider-capability')
  .map((edge) => edge.id);
const mutationEdgeByNodeId = Object.fromEntries(
  baseLayout.edges
    .filter((edge) => edge.kind === 'hub-mutation')
    .map((edge) => [edge.to, edge.id]),
);
const unsafeEdgeId = baseLayout.edges.find((edge) => edge.to === unsafeNodeId)?.id;
const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

const TRAJECTORY_PHASE_INDEX = Object.freeze({
  [PHASE.IDLE]: -1,
  [PHASE.DISCOVERING]: 0,
  [PHASE.MAPPING]: 1,
  [PHASE.READING]: 2,
  [PHASE.PREPARING]: 2,
  [PHASE.REVIEW]: 3,
  [PHASE.APPROVED]: 4,
  [PHASE.EXECUTING]: 4,
  [PHASE.COMPLETE]: 5,
});

function createState(objective = activeProfile.objective) {
  const isProduction = activeProfile.completion === 'mutations';
  const trackedCapabilities = new Set(activeProfile.completion === 'security'
    ? []
    : readNodeIds);
  return createMissionState({
    missionId: `checkout-${activeProfile.id}`,
    objective,
    nodes: baseLayout.nodes.map((node) => ({
      id: node.id,
      label: node.label,
      semanticId: node.semanticId,
      type: node.type,
      trackProgress: trackedCapabilities.has(node.id)
        || (isProduction && (node.id === prepareNodeId || node.type === 'mutation')),
    })),
    edges: baseLayout.edges.map((edge) => ({ id: edge.id, from: edge.from, to: edge.to })),
    stages: {
      discovery: providerNodeIds,
      mapping: [hubNodeId],
      reads: readNodeIds,
      review: [prepareNodeId],
    },
    approvalScopes: {
      apply: [applyNodeId],
      publish: [publishNodeId],
    },
    mappableNodeIds,
    metadata: {
      pack: 'toolbraid.production-recovery',
      profile: activeProfile.id,
      completion: activeProfile.completion,
      visual: 'radial-provider-constellation',
    },
  });
}

const visualNodeIdByCapability = Object.freeze(Object.fromEntries([
  ...CAPABILITIES.filter(({ id }) => id !== 'unsafe.override').map(({ id }) => [id, nodeBySemantic(id, 'capability').id]),
  ...MUTATIONS.map(({ id }) => [id, nodeBySemantic(id, 'mutation').id]),
]));

const isLocalDocument = ['localhost', '127.0.0.1', '::1'].includes(window.location.hostname)
  || window.location.protocol === 'file:';
const nativeWebMcpAvailable = Boolean(
  document.modelContext?.registerTool
  && document.modelContext?.getTools
  && document.modelContext?.executeTool,
);
const usesLocalNativeProviders = nativeWebMcpAvailable
  && ['localhost', '127.0.0.1', '::1'].includes(window.location.hostname)
  && window.location.port === '4173';
const controllerProviderOrigins = usesLocalNativeProviders
  ? RECOVERY_PROVIDER_DESCRIPTORS.map(({ id }) => `${window.location.protocol}//${window.location.hostname}:${LOCAL_PROVIDER_PORTS[id]}`)
  : RECOVERY_PROVIDER_DESCRIPTORS.map(({ origin }) => origin);
const missionController = createMissionController({
  documentRef: document,
  providerOrigins: controllerProviderOrigins,
  runtimePolicy: 'auto',
  allowTestRuntime: isLocalDocument,
});

let state = createState();
let objective = activeProfile.objective;
let missionStartedAt = null;
let missionCompletedIn = null;
let graphZoom = 1;
let approvalDialogOpen = false;
let commandMenuOpen = false;
let helpDrawerOpen = false;
let overlayReturnFocus = null;
let editingObjective = false;
let primaryView = 'topology';
let pendingApprovalScope = null;
let providerSwapRequested = false;
let guidedTourActive = new URLSearchParams(window.location.search).get('mode') !== 'auto';
let auditTimes = new Map();
let auditSealHash = null;
let runtimeTools = [];
let runtimeMappings = {};
let runtimeEvidence = {};
let controllerSnapshot = missionController.snapshot();
let controllerAuditEntries = [];
let bridgeMode = 'idle';
let operationRunning = false;
let providerRuntimePromise = null;
let providerRuntimeProfileId = null;
let safeUiStarted = false;
let executionUiStarted = false;
let executionUiFailed = false;
let missionEpoch = 0;
const timers = new Set();
const guidedTimers = new Set();

const readUi = Object.fromEntries(readSemanticIds.map((id) => [id, {
  state: 'idle',
  detail: 'Waiting',
  time: '—',
}]));

function schedule(delay, task) {
  const timer = window.setTimeout(() => {
    timers.delete(timer);
    task();
  }, delay);
  timers.add(timer);
  return timer;
}

function scheduleGuided(delay, task) {
  const timer = window.setTimeout(() => {
    guidedTimers.delete(timer);
    if (guidedTourActive) task();
  }, delay);
  guidedTimers.add(timer);
  return timer;
}

function clearScheduledWork() {
  for (const timer of timers) window.clearTimeout(timer);
  timers.clear();
}

function clearGuidedWork() {
  for (const timer of guidedTimers) window.clearTimeout(timer);
  guidedTimers.clear();
}

function updateMissionUrl() {
  const url = new URL(window.location.href);
  url.searchParams.set('mission', activeProfile.id);
  url.searchParams.set('mode', guidedTourActive ? 'guided' : 'auto');
  window.history.replaceState(null, '', url);
}

function releaseProviderRuntime() {
  providerRuntimePromise = null;
  providerRuntimeProfileId = null;
  q('[data-provider-runtime]')?.replaceChildren();
}

function selectMissionProfile(profileId) {
  if (state.phase !== PHASE.IDLE || operationRunning) {
    showToast('Reset before switching missions', 'A running or completed audit keeps its original mission profile.', 'warning');
    return;
  }
  const profile = missionProfileById(profileId);
  if (profile.id === activeProfile.id) return;
  activeProfile = profile;
  objective = profile.objective;
  state = createState(objective);
  releaseProviderRuntime();
  updateMissionUrl();
  render();
  showToast('Mission selected', `${profile.title} is ready in ${guidedTourActive ? 'guided judge' : 'auto run'} mode.`, 'info');
}

async function chooseMission() {
  if (operationRunning) return;
  if (state.phase !== PHASE.IDLE) {
    const reset = await resetMission();
    if (!reset) return;
  }
  setPrimaryView('topology', { moveFocus: true });
  schedule(0, () => q(`[data-mission-id="${activeProfile.id}"]`)?.focus({ preventScroll: true }));
}

function htmlEscape(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function toolById(toolId) {
  return runtimeTools.find((tool) => tool.id === toolId) ?? null;
}

function toolByIdentity(identity) {
  if (!identity) return null;
  return runtimeTools.find((tool) => tool.origin === identity.origin && tool.name === identity.name) ?? null;
}

function runtimeDuration(snapshot, engineNodeId) {
  const started = snapshot.audit.find((entry) => entry.event === 'node.started' && entry.details.nodeId === engineNodeId);
  const completed = snapshot.audit.findLast((entry) => entry.event === 'node.completed' && entry.details.nodeId === engineNodeId);
  if (!started || !completed) return 'verified';
  const milliseconds = Math.max(0, Date.parse(completed.timestamp) - Date.parse(started.timestamp));
  return milliseconds < 100 ? '<0.1s' : `${(milliseconds / 1000).toFixed(1)}s`;
}

function evidenceFromSnapshot(snapshot) {
  const evidence = {};
  const health = snapshot.results[ENGINE_NODE_BY_CAPABILITY[CAPABILITY_ID.SERVICE_HEALTH_READ]];
  if (health) {
    evidence[CAPABILITY_ID.SERVICE_HEALTH_READ] = {
      title: `${health.status} · ${health.errorRate}% checkout error rate`,
      detail: health.impact,
      time: runtimeDuration(snapshot, ENGINE_NODE_BY_CAPABILITY[CAPABILITY_ID.SERVICE_HEALTH_READ]),
    };
  }
  const release = snapshot.results[ENGINE_NODE_BY_CAPABILITY[CAPABILITY_ID.RELEASE_HISTORY_READ]]?.releases?.[0];
  if (release) {
    evidence[CAPABILITY_ID.RELEASE_HISTORY_READ] = {
      title: `${release.releaseId} changed checkout behaviour`,
      detail: release.summary,
      time: runtimeDuration(snapshot, ENGINE_NODE_BY_CAPABILITY[CAPABILITY_ID.RELEASE_HISTORY_READ]),
    };
  }
  const deployment = snapshot.results[ENGINE_NODE_BY_CAPABILITY[CAPABILITY_ID.DEPLOYMENT_HISTORY_READ]]?.deployments?.[0];
  if (deployment) {
    evidence[CAPABILITY_ID.DEPLOYMENT_HISTORY_READ] = {
      title: `${deployment.releaseId} is active in production`,
      detail: `Deployment ${deployment.deploymentId} can return to ${deployment.previousReleaseId}.`,
      time: runtimeDuration(snapshot, ENGINE_NODE_BY_CAPABILITY[CAPABILITY_ID.DEPLOYMENT_HISTORY_READ]),
    };
  }
  const notice = snapshot.results[ENGINE_NODE_BY_CAPABILITY[CAPABILITY_ID.STATUS_NOTICE_READ]];
  if (notice) {
    evidence[CAPABILITY_ID.STATUS_NOTICE_READ] = {
      title: `Current customer notice · ${notice.noticeRevision}`,
      detail: notice.body,
      time: runtimeDuration(snapshot, ENGINE_NODE_BY_CAPABILITY[CAPABILITY_ID.STATUS_NOTICE_READ]),
    };
  }
  const recovery = snapshot.results[ENGINE_NODE_BY_CAPABILITY[CAPABILITY_ID.RECOVERY_OPTION_PREPARE]];
  if (recovery) {
    evidence[CAPABILITY_ID.RECOVERY_OPTION_PREPARE] = {
      title: `${recovery.targetReleaseId} recovery is prepared`,
      detail: recovery.effectSummary,
      time: runtimeDuration(snapshot, ENGINE_NODE_BY_CAPABILITY[CAPABILITY_ID.RECOVERY_OPTION_PREPARE]),
    };
  }
  return evidence;
}

function mappingsFromSnapshot(snapshot) {
  if (!snapshot.normalization) return {};
  return Object.fromEntries(snapshot.normalization.mappings.map((mapping) => [
    visualNodeIdByCapability[mapping.capabilityId],
    {
      primaryToolId: mapping.primaryToolId,
      alternativeToolIds: mapping.alternativeToolIds,
    },
  ]));
}

function syncControllerSnapshot(snapshot = missionController.snapshot()) {
  controllerSnapshot = snapshot;
  runtimeTools = snapshot.discoveredTools;
  runtimeMappings = mappingsFromSnapshot(snapshot);
  runtimeEvidence = evidenceFromSnapshot(snapshot);
  controllerAuditEntries = snapshot.audit;
  auditSealHash = snapshot.seal ? `sha256:${snapshot.seal.head}` : null;
  return snapshot;
}

async function ensureProviderRuntime() {
  if (!nativeWebMcpAvailable) return;
  const profileRuntimeId = `${activeProfile.id}:${activeProfile.controlledFault ?? 'normal'}`;
  if (providerRuntimePromise && providerRuntimeProfileId === profileRuntimeId) return providerRuntimePromise;
  providerRuntimeProfileId = profileRuntimeId;
  providerRuntimePromise = new Promise((resolve, reject) => {
    let mount = q('[data-provider-runtime]');
    if (!mount) {
      mount = document.createElement('div');
      mount.hidden = true;
      mount.dataset.providerRuntime = '';
      document.body.append(mount);
    }
    const expected = new Map(RECOVERY_PROVIDER_DESCRIPTORS.map((provider, index) => [
      provider.id,
      controllerProviderOrigins[index],
    ]));
    const ready = new Set();
    const timeout = window.setTimeout(() => {
      cleanup();
      reject(new Error(`Native providers did not register in time (${[...expected.keys()].filter((id) => !ready.has(id)).join(', ')}).`));
    }, 12_000);
    const cleanup = () => {
      window.clearTimeout(timeout);
      window.removeEventListener('message', onMessage);
    };
    const onMessage = (event) => {
      const message = event.data;
      if (message?.source !== 'toolbraid-provider' || !expected.has(message.providerId)) return;
      if (event.origin !== expected.get(message.providerId) || message.origin !== event.origin) return;
      if (message.type === 'toolbraid:provider-error') {
        cleanup();
        reject(new Error(`${message.providerId}: ${message.error?.message ?? 'provider registration failed'}`));
        return;
      }
      if (message.type !== 'toolbraid:provider-ready') return;
      ready.add(message.providerId);
      if (ready.size === expected.size) {
        cleanup();
        resolve();
      }
    };
    window.addEventListener('message', onMessage);
    mount.replaceChildren();
    for (const [providerId, origin] of expected) {
      const frame = document.createElement('iframe');
      frame.hidden = true;
      frame.tabIndex = -1;
      frame.dataset.providerId = providerId;
      frame.setAttribute('aria-hidden', 'true');
      frame.setAttribute('allow', 'tools');
      frame.setAttribute('sandbox', 'allow-scripts allow-same-origin');
      frame.referrerPolicy = 'no-referrer';
      const providerUrl = new URL('/', origin);
      providerUrl.searchParams.set('orchestrator', window.location.origin);
      if (providerId === 'signals' && activeProfile.controlledFault) {
        providerUrl.searchParams.set('scenario', activeProfile.controlledFault);
      }
      frame.src = providerUrl.href;
      mount.append(frame);
    }
  });
  return providerRuntimePromise;
}

function uiNodeIdForEngineNode(engineNodeId) {
  return visualNodeIdByCapability[CAPABILITY_BY_ENGINE_NODE[engineNodeId]] ?? null;
}

function handleControllerEvent({ event, details, entry }) {
  controllerAuditEntries.push(entry);
  if (event === 'runtime.ready') {
    syncControllerSnapshot();
    renderHeader();
    return;
  }
  if (bridgeMode === 'discovery') {
    if (event === 'mission.started' && state.phase === PHASE.IDLE) {
      dispatch({ type: EVENT.START, activeEdgeIds: discoveryEdgeIds });
      return;
    }
    if (event === 'tool.discovered' && state.phase === PHASE.DISCOVERING) {
      syncControllerSnapshot();
      dispatch({
        type: EVENT.DISCOVERY_RESULT,
        tools: [details],
        nodeIds: providerNodeIds,
        activeEdgeIds: discoveryEdgeIds,
      });
      return;
    }
    if (event === 'tool.quarantined' && state.phase === PHASE.DISCOVERING) {
      dispatch({ type: EVENT.TOOL_QUARANTINED, toolId: details.toolId, reason: details.reasonCode });
      showToast('Threat quarantined', `${details.name} was excluded before semantic scoring.`, 'danger');
      return;
    }
    if (event === 'discovery.completed' && state.phase === PHASE.DISCOVERING) {
      syncControllerSnapshot();
      dispatch({ type: EVENT.DISCOVERY_COMPLETED });
      return;
    }
  }

  if (bridgeMode === 'mapping' && event === 'plan.created' && state.phase === PHASE.MAPPING) {
    syncControllerSnapshot();
    dispatch({
      type: EVENT.MAPPING_COMPLETED,
      mappings: runtimeMappings,
      activeEdgeIds: providerCapabilityEdgeIds,
    });
    return;
  }

  if (bridgeMode === 'approval' && event === 'approval.created' && state.phase === PHASE.REVIEW) {
    const isApply = details.scope === 'apply';
    dispatch({
      type: isApply ? EVENT.APPLY_APPROVED : EVENT.PUBLISH_APPROVED,
      approvalId: details.fingerprint,
      nodeIds: [isApply ? applyNodeId : publishNodeId],
    });
    return;
  }

  if (event === 'registry.toolchange' && ![PHASE.IDLE, PHASE.COMPLETE].includes(state.phase)) {
    dispatch({
      type: EVENT.PLAN_INVALIDATED,
      reason: 'Native WebMCP registry changed after planning.',
      restartAt: PHASE.MAPPING,
    });
    showToast('Plan invalidated', 'A live tool registration changed. Previous mappings and approvals were cleared.', 'warning');
    return;
  }

  if (bridgeMode === 'safe' || bridgeMode === 'preparation') {
    const uiNodeId = uiNodeIdForEngineNode(details.nodeId);
    const capabilityId = CAPABILITY_BY_ENGINE_NODE[details.nodeId];
    if (event === 'node.started' && readSemanticIds.includes(capabilityId) && !safeUiStarted) {
      safeUiStarted = true;
      dispatch({ type: EVENT.PARALLEL_READS_STARTED });
      showToast('Parallel reads started', 'Four independent origins are executing read-only tools.', 'info');
      return;
    }
    if (event === 'tool.execution_failed' && readSemanticIds.includes(capabilityId) && uiNodeId) {
      const failedTool = toolByIdentity(details.tool);
      readUi[capabilityId] = {
        state: 'failed',
        detail: `${failedTool?.title ?? details.tool?.name ?? 'Provider'} unavailable`,
        time: 'failed closed',
      };
      dispatch({ type: EVENT.READ_NODE_FAILED, nodeId: uiNodeId, error: details.message ?? 'provider unavailable' });
      showToast('Read provider unavailable', `${failedTool?.title ?? 'Primary provider'} failed safely.`, 'warning');
      return;
    }
    if (event === 'tool.failover_selected' && readSemanticIds.includes(capabilityId) && uiNodeId) {
      const failedIdentity = details.priorFailures?.at(-1)?.tool;
      const fromTool = toolByIdentity(failedIdentity);
      const toTool = toolByIdentity(details.tool);
      providerSwapRequested = true;
      readUi[capabilityId] = {
        state: 'active',
        detail: `${toTool?.title ?? details.tool?.name ?? 'Fallback'} · substituted`,
        time: 'running',
      };
      dispatch({
        type: EVENT.PROVIDER_SWAPPED,
        nodeId: uiNodeId,
        fromToolId: fromTool?.id ?? state.mappings[uiNodeId]?.primaryToolId,
        toToolId: toTool?.id,
        reason: details.priorFailures?.at(-1)?.message ?? 'primary provider unavailable',
      });
      showToast('Provider substituted', `${toTool?.title ?? 'Compatible fallback'} continued the read-only capability.`, 'success');
      return;
    }
    if (event === 'node.completed' && readSemanticIds.includes(capabilityId) && uiNodeId) {
      syncControllerSnapshot();
      const mappedTool = toolById(state.mappings[uiNodeId]?.primaryToolId);
      readUi[capabilityId] = {
        state: 'complete',
        detail: providerSwapRequested && capabilityId === CAPABILITY_ID.SERVICE_HEALTH_READ
          ? `${mappedTool?.title ?? 'Fallback provider'} · substituted`
          : `${mappedTool?.title ?? capabilityTitle(capabilityId)} · verified`,
        time: runtimeEvidence[capabilityId]?.time ?? 'verified',
      };
      dispatch({ type: EVENT.READ_NODE_COMPLETED, nodeId: uiNodeId });
      return;
    }
    if (event === 'node.failed'
        && ['correlate-evidence', 'prepare-recovery-option', 'draft-status-update'].includes(details.nodeId)
        && state.phase === PHASE.PREPARING) {
      dispatch({ type: EVENT.PREPARATION_FAILED, error: details.error ?? 'recovery preparation failed' });
      return;
    }
    if (event === 'plan.mutations_finalized' && state.phase === PHASE.PREPARING) {
      syncControllerSnapshot();
      dispatch({ type: EVENT.PREPARATION_COMPLETED, planRevision: details.revision });
    }
  }

  if (bridgeMode === 'execution') {
    const uiNodeId = uiNodeIdForEngineNode(details.nodeId);
    if (event === 'node.started' && [applyNodeId, publishNodeId].includes(uiNodeId) && !executionUiStarted) {
      executionUiStarted = true;
      dispatch({ type: EVENT.EXECUTION_STARTED, nodeIds: [applyNodeId, publishNodeId] });
      showToast('Approved execution started', 'Only the two exact reviewed mutations can run.', 'info');
      return;
    }
    if (event === 'node.completed'
        && [applyNodeId, publishNodeId].includes(uiNodeId)
        && state.phase === PHASE.EXECUTING
        && !executionUiFailed) {
      syncControllerSnapshot();
      dispatch({
        type: EVENT.EXECUTION_NODE_COMPLETED,
        nodeId: uiNodeId,
        activeEdgeIds: [mutationEdgeByNodeId[uiNodeId]].filter(Boolean),
      });
      return;
    }
    if (event === 'node.failed'
        && [applyNodeId, publishNodeId].includes(uiNodeId)
        && state.phase === PHASE.EXECUTING
        && !executionUiFailed) {
      executionUiFailed = true;
      dispatch({
        type: EVENT.EXECUTION_FAILED,
        nodeId: uiNodeId,
        error: details.error ?? 'approved mutation failed',
      });
    }
  }
}

function missionNode(nodeId) {
  return state.nodes.find((node) => node.id === nodeId) ?? null;
}

function semanticNodeState(semanticId, type = 'capability') {
  const node = nodeBySemantic(semanticId, type);
  return node ? missionNode(node.id)?.status ?? NODE_STATUS.PENDING : NODE_STATUS.PENDING;
}

function unsafeToolId() {
  return runtimeTools.find(({ name }) => name === 'override_approval')?.id ?? null;
}

function unsafeToolQuarantined() {
  const id = unsafeToolId();
  return Boolean(id && state.quarantine[id]);
}

function visualStateForNode(node) {
  if (node.id === unsafeNodeId || (node.type === 'provider' && node.origin === RECOVERY_PROVIDER_ORIGINS.mirage)) {
    return unsafeToolQuarantined() ? 'quarantined' : state.phase === PHASE.IDLE ? 'idle' : 'active';
  }
  if (node.type === 'mutation') {
    const scope = node.id === applyNodeId ? 'apply' : 'publish';
    const status = missionNode(node.id)?.status;
    if (status === NODE_STATUS.COMPLETED) return 'complete';
    if (status === NODE_STATUS.RUNNING) return 'active';
    return state.approvals[scope].granted ? 'locked' : 'locked';
  }
  const status = missionNode(node.id)?.status;
  if (status === NODE_STATUS.RUNNING) return 'active';
  if (status === NODE_STATUS.COMPLETED) return 'complete';
  if (status === NODE_STATUS.FAILED) return 'idle';
  return 'idle';
}

function edgeVisualState(edge, activeEdges, nodeStates) {
  if (edge.to === unsafeNodeId || edge.from === nodeBySemantic(RECOVERY_PROVIDER_ORIGINS.mirage, 'provider')?.id) {
    return unsafeToolQuarantined() ? 'quarantined' : activeEdges.has(edge.id) ? 'active' : 'idle';
  }
  if (activeEdges.has(edge.id)) return 'active';
  const fromState = nodeStates.get(edge.from);
  const toState = nodeStates.get(edge.to);
  if (toState === 'active' || (edge.kind === 'capability-hub' && fromState === 'active')) return 'active';
  if (edge.kind === 'hub-mutation' && toState !== 'active' && toState !== 'complete') return 'locked';
  if (fromState === 'complete' && (toState === 'complete' || edge.kind === 'capability-hub')) return 'complete';
  if (toState === 'complete') return 'complete';
  return 'idle';
}

function graphInput() {
  const compact = window.matchMedia('(max-width: 680px)').matches;
  const activeEdges = new Set(state.phase === PHASE.COMPLETE ? [] : selectActiveEdgeIds(state));
  const nodeStates = new Map(baseLayout.nodes.map((node) => [node.id, visualStateForNode(node)]));
  return {
    width: compact ? 720 : baseLayout.width,
    height: compact ? 700 : baseLayout.height,
    centerX: compact ? 360 : baseLayout.center.x,
    centerY: compact ? 300 : baseLayout.center.y,
    outerRadius: compact ? 235 : baseLayout.radii.outer,
    innerRadius: compact ? 132 : baseLayout.radii.inner,
    mutationGap: compact ? 120 : undefined,
    mutationWidth: compact ? 196 : undefined,
    providers: PROVIDERS.map((provider) => {
      const node = nodeBySemantic(provider.origin, 'provider');
      let visualState = nodeStates.get(node.id);
      if (provider.origin === RECOVERY_PROVIDER_ORIGINS.signals
        && (semanticNodeState('service.health.read') === NODE_STATUS.FAILED || providerSwapRequested)) visualState = 'idle';
      if (provider.origin === RECOVERY_PROVIDER_ORIGINS.pulse && providerSwapRequested) {
        visualState = semanticNodeState('service.health.read') === NODE_STATUS.COMPLETED ? 'complete' : 'active';
      }
      return {
        ...provider,
        label: provider.id === 'source' ? 'GitHub Source' : provider.label,
        state: visualState,
      };
    }),
    capabilities: CAPABILITIES.map((capability) => {
      const node = nodeBySemantic(capability.id, 'capability');
      return {
        ...capability,
        state: nodeStates.get(node.id),
        providerEdgeState: nodeStates.get(node.id),
        hubEdgeState: nodeStates.get(node.id),
      };
    }),
    mutations: MUTATIONS.map((mutation) => {
      const node = nodeBySemantic(mutation.id, 'mutation');
      const visualState = nodeStates.get(node.id);
      return { ...mutation, state: visualState, edgeState: visualState === 'active' || visualState === 'complete' ? visualState : 'locked' };
    }),
    hub: {
      id: 'toolbraid',
      label: 'Recovery plan',
      subtitle: 'Canonical capabilities',
      state: nodeStates.get(hubNodeId),
    },
    edgeStates: Object.fromEntries(baseLayout.edges.map((edge) => [
      edge.id,
      edgeVisualState(edge, activeEdges, nodeStates),
    ])),
  };
}

function rememberAuditTimes(previousLength) {
  const now = new Date();
  for (let index = previousLength; index < state.audit.length; index += 1) {
    auditTimes.set(state.audit[index].sequence, new Date(now.getTime() + index - previousLength));
  }
}

function pulseEdgesForEvent(event) {
  const touching = (nodeId) => baseLayout.edges
    .filter((edge) => edge.from === nodeId || edge.to === nodeId)
    .map((edge) => edge.id);
  const healthNodeId = nodeBySemantic('service.health.read', 'capability').id;
  const pulseProviderId = nodeBySemantic(RECOVERY_PROVIDER_ORIGINS.pulse, 'provider').id;

  switch (event.type) {
    case EVENT.START:
    case EVENT.DISCOVERY_RESULT:
    case EVENT.MAPPING_COMPLETED:
    case EVENT.PARALLEL_READS_STARTED:
      return [...(event.activeEdgeIds ?? selectActiveEdgeIds(state))].slice(0, 2);
    case EVENT.TOOL_QUARANTINED:
      return unsafeEdgeId ? [unsafeEdgeId] : [];
    case EVENT.READ_NODE_COMPLETED:
    case EVENT.READ_NODE_FAILED:
      return touching(event.nodeId).slice(0, 2);
    case EVENT.PROVIDER_SWAPPED: {
      const providerEdge = baseLayout.edges.find((edge) => edge.from === pulseProviderId && edge.to === healthNodeId)?.id;
      const hubEdge = baseLayout.edges.find((edge) => edge.from === healthNodeId && edge.to === hubNodeId)?.id;
      return [providerEdge, hubEdge].filter(Boolean);
    }
    case EVENT.APPLY_APPROVED:
      return [mutationEdgeByNodeId[applyNodeId]].filter(Boolean);
    case EVENT.PUBLISH_APPROVED:
      return [mutationEdgeByNodeId[publishNodeId]].filter(Boolean);
    case EVENT.EXECUTION_STARTED:
      return [mutationEdgeByNodeId[applyNodeId], mutationEdgeByNodeId[publishNodeId]].filter(Boolean);
    case EVENT.EXECUTION_NODE_COMPLETED:
      return [mutationEdgeByNodeId[event.nodeId]].filter(Boolean);
    default:
      return [];
  }
}

function pulseToneForEvent(eventType) {
  if (eventType === EVENT.TOOL_QUARANTINED || eventType === EVENT.READ_NODE_FAILED) return 'danger';
  if (eventType === EVENT.APPLY_APPROVED || eventType === EVENT.PUBLISH_APPROVED) return 'authority';
  if (eventType === EVENT.EXECUTION_NODE_COMPLETED) return 'success';
  return 'signal';
}

function animateEdgePackets(edgeIds, eventType) {
  if (!edgeIds.length || prefersReducedMotion.matches) return;
  const mount = q('[data-constellation]');
  if (!mount) return;
  const groups = qa('[data-edge-id]', mount);
  const tone = pulseToneForEvent(eventType);

  window.requestAnimationFrame(() => {
    edgeIds.slice(0, 2).forEach((edgeId, index) => {
      const group = groups.find((candidate) => candidate.dataset.edgeId === edgeId);
      if (!group) return;
      group.dataset.packetTone = tone;
      group.classList.add('has-packet');
      const lead = q('[data-motion="lead"]', group);
      const echo = q('[data-motion="echo"]', group);
      lead?.setAttribute('dur', '760ms');
      echo?.setAttribute('dur', '1040ms');
      if (typeof lead?.beginElement === 'function') lead.beginElement();
      window.setTimeout(() => {
        if (typeof echo?.beginElement === 'function') echo.beginElement();
      }, 120 + index * 90);
      const edge = baseLayout.edges.find((candidate) => candidate.id === edgeId);
      const destination = edge
        ? qa('[data-node-id]', mount).find((candidate) => candidate.dataset.nodeId === edge.to)
        : null;
      window.setTimeout(() => {
        destination?.classList.add('packet-arrival');
        window.setTimeout(() => destination?.classList.remove('packet-arrival'), 520);
      }, 650 + index * 90);
      window.setTimeout(() => group.classList.remove('has-packet'), 1900);
    });
  });
}

function dispatch(event, { silentError = false } = {}) {
  const previousAuditLength = state.audit.length;
  try {
    state = transitionMission(state, event);
    rememberAuditTimes(previousAuditLength);
    render();
    animateEdgePackets(pulseEdgesForEvent(event), event.type);
    return true;
  } catch (error) {
    if (!silentError) {
      const message = error instanceof MissionStateError ? error.message : 'The mission could not enter that state.';
      showToast('Action blocked safely', message, 'warning');
    }
    return false;
  }
}

function formatMissionTime(milliseconds) {
  const total = Math.max(0, Math.floor(milliseconds / 1000));
  const hours = String(Math.floor(total / 3600)).padStart(2, '0');
  const minutes = String(Math.floor((total % 3600) / 60)).padStart(2, '0');
  const seconds = String(total % 60).padStart(2, '0');
  return `${hours}:${minutes}:${seconds}`;
}

function formatAuditTime(date) {
  if (!(date instanceof Date)) return '—';
  return new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(date);
}

function approvalExpiryText(nodeId) {
  const expiresAt = controllerSnapshot.approvals?.[nodeId]?.expiresAt;
  if (!expiresAt) return 'Not issued · timer starts on approval';
  const date = new Date(expiresAt);
  if (Number.isNaN(date.getTime())) return expiresAt;
  return new Intl.DateTimeFormat('en-GB', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(date);
}

function auditPhaseId(entry) {
  if (AUDIT_EVENT_PHASE.has(entry.type)) return AUDIT_EVENT_PHASE.get(entry.type);
  if (entry.type !== EVENT.NODE_SELECTED) return 'system';
  if (entry.phaseFrom === PHASE.DISCOVERING) return 'discover';
  if (entry.phaseFrom === PHASE.MAPPING) return 'normalize';
  if (entry.phaseFrom === PHASE.READING) return 'observe';
  if ([PHASE.REVIEW, PHASE.APPROVED].includes(entry.phaseFrom)) return 'authorize';
  if ([PHASE.EXECUTING, PHASE.COMPLETE].includes(entry.phaseFrom)) return 'execute';
  return 'system';
}

function auditEntryDetail(entry) {
  const details = entry.details ?? {};
  switch (entry.type) {
    case EVENT.START:
      return 'Objective accepted; provider discovery opened.';
    case EVENT.DISCOVERY_RESULT:
      return `${details.toolIds?.length ?? 0} descriptors · generation ${details.generation ?? '—'}`;
    case EVENT.TOOL_QUARANTINED:
      return `${details.toolId ?? 'Tool'} · ${details.reason ?? 'unsafe metadata'}`;
    case EVENT.DISCOVERY_COMPLETED:
      return `${details.discoveredToolCount ?? 0} tools retained across trusted origins.`;
    case EVENT.MAPPING_COMPLETED:
      return `${Object.keys(details.mappings ?? {}).length} canonical capability bindings.`;
    case EVENT.PARALLEL_READS_STARTED:
      return `${details.nodeIds?.length ?? 0} read-only calls started in parallel.`;
    case EVENT.READ_NODE_COMPLETED:
      return `${details.nodeId ?? 'Read'} returned signed evidence.`;
    case EVENT.READ_NODE_FAILED:
      return `${details.nodeId ?? 'Read'} failed closed · ${details.error ?? 'provider unavailable'}`;
    case EVENT.PROVIDER_SWAPPED:
      return `${details.fromToolId ?? 'Primary'} → ${details.toToolId ?? 'compatible fallback'} · read-only scope preserved`;
    case EVENT.NODE_SELECTED:
      return `${details.nodeId ?? 'Graph node'} inspected; mission state unchanged.`;
    case EVENT.APPLY_APPROVED:
    case EVENT.PUBLISH_APPROVED:
      return `${details.scope ?? (entry.type === EVENT.APPLY_APPROVED ? 'apply' : 'publish')} scope · revision ${entry.revision} · single use`;
    case EVENT.PLAN_INVALIDATED:
      return `${details.reason ?? 'Plan changed'} · restarted at ${details.restartAt ?? 'mapping'}`;
    case EVENT.EXECUTION_STARTED:
      return `${details.nodeIds?.length ?? 0} separately approved effects started.`;
    case EVENT.EXECUTION_NODE_COMPLETED:
      return `${details.nodeId ?? 'Mutation'} completed${details.complete ? '; audit ready to seal.' : '; second receipt pending.'}`;
    case EVENT.EXECUTION_FAILED:
      return `${details.nodeId ?? 'Mutation'} failed closed · approvals cleared.`;
    case EVENT.RESET:
      return `Returned to revision ${details.resetToRevision ?? entry.revision}.`;
    default:
      return `Revision ${entry.revision} · ${entry.phaseFrom} → ${entry.phaseTo}`;
  }
}

function controllerAuditPhaseId(entry) {
  if (['runtime.ready', 'mission.started', 'tool.discovered', 'tool.quarantined', 'discovery.completed'].includes(entry.event)) return 'discover';
  if (['capability.mapped', 'plan.created'].includes(entry.event)) return 'normalize';
  if (entry.event === 'authority.challenge_rejected') return 'authorize';
  if (entry.event.startsWith('approval.')) return 'authorize';
  if (['mission.completed', 'mission.read_only_completed', 'mission.authority_completed'].includes(entry.event)) return 'execute';
  if (['node.started', 'node.completed', 'node.failed', 'tool.execution_started', 'tool.execution_failed', 'tool.failover_selected'].includes(entry.event)) {
    return ['apply-recovery-option', 'publish-status-update'].includes(entry.details.nodeId) ? 'execute' : 'observe';
  }
  if (entry.event === 'plan.mutations_finalized') return 'observe';
  return 'system';
}

function controllerAuditDetail(entry) {
  const details = entry.details ?? {};
  switch (entry.event) {
    case 'runtime.ready':
      return `${details.mode === 'native' ? 'Native browser runtime' : 'Local verification harness'} · ${details.allowedOrigins?.length ?? 0} allowed origins`;
    case 'mission.started':
      return 'Human objective entered the append-only recovery chain.';
    case 'tool.discovered':
      return `${details.origin ?? 'unknown origin'} · ${details.name ?? 'unknown tool'} · schema ${details.schemaFingerprint?.slice(0, 10) ?? '—'}…`;
    case 'tool.quarantined':
      return `${details.origin ?? 'unknown origin'} · ${details.name ?? 'tool'} · ${details.reasonCode ?? 'unsafe metadata'}`;
    case 'discovery.completed':
      return `${details.toolCount ?? 0} tools · ${details.originCount ?? 0} origins · ${details.quarantinedToolCount ?? 0} quarantined`;
    case 'capability.mapped':
      return `${details.capabilityId ?? 'capability'} → ${details.primary?.origin ?? 'origin'} · ${details.primary?.name ?? 'tool'}`;
    case 'plan.created':
      return `${details.nodeCount ?? 0} nodes · mutation arguments deferred until safe evidence completes`;
    case 'node.started':
      return `${details.nodeId ?? 'node'} · ${details.type ?? 'operation'}`;
    case 'tool.execution_started':
      return `${details.nodeId ?? 'node'} · ${details.tool?.origin ?? 'origin'} · ${details.tool?.name ?? 'tool'} · attempt ${details.attempt ?? 1}`;
    case 'tool.execution_failed':
      return `${details.tool?.name ?? 'tool'} · ${details.code ?? 'failure'} · ${details.message ?? 'failed closed'}`;
    case 'tool.failover_selected':
      return `${details.tool?.origin ?? 'fallback origin'} · ${details.tool?.name ?? 'fallback tool'} · read-only scope preserved`;
    case 'node.completed':
      return `${details.nodeId ?? 'node'} · canonical output recorded`;
    case 'node.failed':
      return `${details.nodeId ?? 'node'} · ${details.code ?? 'failure'} · ${details.error ?? 'failed closed'}`;
    case 'plan.mutations_finalized':
      return `${details.nodeIds?.length ?? 0} exact effects derived from completed evidence · revision ${details.revision ?? '—'}`;
    case 'evidence.completed':
      return `${details.resultCount ?? 0} correlated read-only results · no external dispatch`;
    case 'authority.challenge_rejected':
      return `${details.challenge ?? 'challenge'} · ${details.code ?? 'rejected'} · no provider mutation`;
    case 'approval.created':
      return `${details.scope ?? 'scope'} · ${details.origin ?? 'origin'} · ${details.tool ?? 'tool'} · ${details.fingerprint?.slice(0, 12) ?? '—'}…`;
    case 'approval.claimed':
      return `${details.nodeId ?? 'mutation'} · nonce ${details.nonce ?? '—'} · single use`;
    case 'mission.completed':
      return `${details.resultNodeIds?.length ?? 0} approved mutation receipts recorded before sealing.`;
    case 'mission.read_only_completed':
      return `${details.resultNodeIds?.length ?? 0} evidence results · ${details.mutationDispatchCount ?? 0} mutation dispatches`;
    case 'mission.authority_completed':
      return `${details.blockedChallenges?.length ?? 0} attacks blocked · ${details.mutationDispatchCount ?? 0} mutation dispatches`;
    case 'registry.toolchange':
      return `Generation ${details.generation ?? '—'} differs from planned generation ${details.plannedGeneration ?? '—'}.`;
    default:
      return `Chain entry ${entry.sequence}`;
  }
}

function auditPhaseSummary(phaseId, entries) {
  const count = (type) => entries.filter((entry) => (entry.event ?? entry.type) === type).length;
  if (phaseId === 'discover') {
    const retained = state.discovery.tools.length;
    const quarantined = count(EVENT.TOOL_QUARANTINED);
    return `${retained} tools retained${quarantined ? ` · ${quarantined} quarantined` : ''}`;
  }
  if (phaseId === 'normalize') return `${Object.keys(state.mappings).length} canonical bindings`;
  if (phaseId === 'observe') {
    const reads = readSemanticIds.filter((id) => semanticNodeState(id) === NODE_STATUS.COMPLETED).length;
    return `${reads} / 4 reads${providerSwapRequested ? ' · Pulse substituted' : ''}`;
  }
  if (phaseId === 'authorize') {
    if (activeProfile.completion === 'security') {
      return `${controllerSnapshot.securityChecks?.length ?? 0} / 3 attacks blocked`;
    }
    const approved = Number(state.approvals.apply.granted) + Number(state.approvals.publish.granted);
    return `${approved} / 2 exact scopes approved`;
  }
  if (phaseId === 'execute') {
    if (activeProfile.completion === 'read-only') return `${Object.keys(runtimeEvidence).length} evidence records · sealed`;
    if (activeProfile.completion === 'security') return `${controllerSnapshot.securityChecks?.length ?? 0} rejection receipts · sealed`;
    return `${state.execution.completedNodeIds.length} / 2 mutation receipts`;
  }
  return `${entries.length} lifecycle ${entries.length === 1 ? 'event' : 'events'}`;
}

function renderHeader() {
  document.body.dataset.phase = state.phase;
  document.body.dataset.guided = guidedTourActive ? 'active' : 'idle';
  document.body.dataset.runtime = controllerSnapshot.mode;
  document.body.dataset.missionProfile = activeProfile.id;
  q('[data-current-mission]').textContent = activeProfile.shortTitle;
  const mappingsReady = Object.keys(state.mappings).length === mappableNodeIds.length;
  const phaseCopy = state.phase === PHASE.MAPPING && mappingsReady
    ? activeProfile.completion === 'security' ? 'Ready for authority checks' : 'Capabilities mapped'
    : state.phase === PHASE.PREPARING
      ? activeProfile.completion === 'read-only' ? 'Read-only evidence ready to seal' : 'Evidence correlated; effects remain unprepared'
      : state.phase === PHASE.COMPLETE && activeProfile.completion === 'read-only'
        ? 'Read-only mission complete · audit sealed'
        : state.phase === PHASE.COMPLETE && activeProfile.completion === 'security'
          ? 'Security mission complete · audit sealed'
          : PHASE_COPY[state.phase];
  qa('[data-phase-label]').forEach((element) => { element.textContent = phaseCopy; });
  q('[data-runtime-label]').textContent = controllerSnapshot.mode === 'native'
    ? 'Native WebMCP'
    : controllerSnapshot.mode === 'test'
      ? 'Verified local harness'
      : nativeWebMcpAvailable
        ? 'Native WebMCP ready'
        : isLocalDocument
          ? 'Local harness ready'
          : 'WebMCP required';
  const discoveredOrigins = new Set(state.discovery.tools.map((tool) => tool.origin));
  q('[data-provider-count]').textContent = state.phase === PHASE.IDLE ? '0' : String(discoveredOrigins.size);
  q('[data-mission-clock]').textContent = missionStartedAt
    ? formatMissionTime(missionCompletedIn ?? (Date.now() - missionStartedAt))
    : '00:00:00';
  qa('[data-action="reset"]').forEach((button) => {
    button.disabled = operationRunning;
  });
}

function renderTrajectory() {
  const phaseIndex = TRAJECTORY_PHASE_INDEX[state.phase];
  const steps = qa('[data-phase-step]');
  steps.forEach((step, index) => {
    const readOnlySkip = activeProfile.completion === 'read-only' && index >= 3;
    const securitySkip = activeProfile.completion === 'security' && [2, 4].includes(index);
    const securityAuthorize = activeProfile.completion === 'security' && index === 3;
    const stepState = readOnlySkip || securitySkip
      ? 'skipped'
      : securityAuthorize
        ? (state.phase === PHASE.COMPLETE ? 'complete' : Object.keys(state.mappings).length ? 'active' : 'pending')
        : state.phase === PHASE.COMPLETE || index < phaseIndex
      ? 'complete'
      : index === phaseIndex
        ? 'active'
        : 'pending';
    step.dataset.state = stepState;
    step.toggleAttribute('aria-current', stepState === 'active');
  });
}

function renderGuidedControl() {
  const control = q('[data-action="toggle-guidance"]', q('.stage-tools'));
  if (!control) return;
  control.hidden = false;
  const icon = q('[data-guided-icon]', control);
  const label = q('[data-guided-label]', control);
  if (!icon || !label) return;

  const iconName = guidedTourActive ? 'mission' : 'play';
  const copy = guidedTourActive ? 'Guided judge' : 'Auto run';
  icon.innerHTML = iconMarkup(iconName);
  label.textContent = copy;
  control.setAttribute('aria-pressed', String(guidedTourActive));
}

function guideCheckpointId() {
  if (state.phase === PHASE.COMPLETE) return 'audit';
  if (bridgeMode === 'discovery') return 'discovery';
  if (bridgeMode === 'mapping') return 'mapping';
  if (bridgeMode === 'safe' || bridgeMode === 'preparation') return 'evidence';
  if (bridgeMode === 'sealing') return 'audit';
  if (bridgeMode === 'security') return 'security';
  if (bridgeMode === 'approval' || state.phase === PHASE.REVIEW) return 'approval';
  if (bridgeMode === 'execution' || state.phase === PHASE.APPROVED || state.phase === PHASE.EXECUTING) return 'execution';
  if (state.phase === PHASE.IDLE) return 'objective';
  if (state.phase === PHASE.MAPPING && !Object.keys(state.mappings).length) return 'discovery';
  if (state.phase === PHASE.MAPPING && activeProfile.completion === 'security') return 'security';
  if ([PHASE.MAPPING, PHASE.READING, PHASE.PREPARING].includes(state.phase)) return 'evidence';
  return 'objective';
}

function renderJudgeGuide() {
  const current = guideCheckpointId();
  const currentIndex = MISSION_GUIDE_STEPS.indexOf(current);
  for (const item of qa('[data-guide-step]')) {
    const id = item.dataset.guideStep;
    const index = MISSION_GUIDE_STEPS.indexOf(id);
    const irrelevant = (activeProfile.completion === 'read-only' && ['approval', 'execution'].includes(id))
      || (activeProfile.completion === 'security' && ['evidence', 'approval', 'execution'].includes(id));
    const independentlyComplete = id === 'security' && unsafeToolQuarantined();
    const stepState = irrelevant
      ? 'skipped'
      : id === current
        ? 'active'
        : independentlyComplete || index < currentIndex
          ? 'complete'
          : 'pending';
    item.dataset.state = stepState;
    item.toggleAttribute('aria-current', stepState === 'active');
  }
}

function guidedContext(context) {
  if (!guidedTourActive || context.loading) return context;
  const guide = activeProfile.guide[guideCheckpointId()];
  return { ...context, current: guide[0], next: guide[1], requires: guide[2] };
}

function missionContextState() {
  if (operationRunning) {
    if (bridgeMode === 'discovery') return {
      current: 'Verifying allowed provider origins',
      next: 'Normalize their capabilities',
      requires: 'Nothing while read-only discovery runs',
      label: 'Connecting origins…',
      action: 'start-mission',
      disabled: true,
      loading: true,
    };
    if (bridgeMode === 'safe') return {
      current: state.phase === PHASE.PREPARING ? 'Preparing the recovery plan' : 'Reading evidence without mutation',
      next: activeProfile.completion === 'read-only' ? 'Seal the evidence without staging' : 'Present two exact changes for review',
      requires: 'Nothing while safe reads settle',
      label: state.phase === PHASE.PREPARING ? 'Preparing recovery…' : 'Reading evidence…',
      action: 'start-mission',
      disabled: true,
      loading: true,
    };
    if (bridgeMode === 'mapping') return {
      current: 'Normalizing live tool contracts',
      next: 'Bind one canonical provider-neutral plan',
      requires: 'Nothing while mappings are verified',
      label: 'Mapping capabilities…',
      action: 'start-mission',
      disabled: true,
      loading: true,
    };
    if (bridgeMode === 'preparation') return {
      current: 'Deriving two exact effects from completed evidence',
      next: 'Stop at separate human approvals',
      requires: 'Nothing while exact arguments are finalized',
      label: 'Preparing exact effects…',
      action: 'start-mission',
      disabled: true,
      loading: true,
    };
    if (bridgeMode === 'security') return {
      current: 'Running real authority verifier challenges',
      next: 'Seal the rejection receipts',
      requires: 'Nothing; external dispatch is disabled',
      label: 'Verifying fail-closed policy…',
      action: 'start-mission',
      disabled: true,
      loading: true,
    };
    if (bridgeMode === 'sealing') return {
      current: 'Verifying the read-only audit chain',
      next: 'Publish a sealed evidence receipt',
      requires: 'Nothing; no effect is prepared or dispatched',
      label: 'Sealing evidence…',
      action: 'open-audit',
      disabled: true,
      loading: true,
    };
    if (bridgeMode === 'approval') return {
      current: `Binding the ${pendingApprovalScope === 'publish' ? 'customer update' : 'recovery'} approval`,
      next: 'Keep each approval separate and single-use',
      requires: 'Wait for the approval receipt',
      label: 'Binding exact approval…',
      action: 'review-approval',
      disabled: true,
      loading: true,
    };
    if (bridgeMode === 'execution') return {
      current: 'Executing only the approved effects',
      next: 'Verify receipts and postconditions',
      requires: 'Nothing while execution settles',
      label: 'Executing approved actions…',
      action: 'review-approval',
      disabled: true,
      loading: true,
    };
  }

  const mappingsReady = Object.keys(state.mappings).length === mappableNodeIds.length;
  if (state.phase === PHASE.IDLE) return guidedContext({
    current: 'Objective ready',
    next: 'Discover verified provider origins',
    requires: 'Start the selected mission',
    label: guidedTourActive ? 'Begin guided mission' : 'Run to next human boundary',
    action: 'start-mission',
    disabled: false,
  });
  if (state.phase === PHASE.MAPPING && !mappingsReady) return guidedContext({
    current: 'Registry discovered and hostile metadata quarantined',
    next: 'Normalize retained tools into canonical capabilities',
    requires: 'Map the live tool contracts',
    label: 'Map live capabilities',
    action: 'start-mission',
    disabled: false,
  });
  if (state.phase === PHASE.MAPPING) return guidedContext({
    current: 'Capabilities normalized',
    next: activeProfile.completion === 'security' ? 'Run real denial challenges' : 'Run four read-only evidence checks',
    requires: 'Continue the selected mission',
    label: activeProfile.completion === 'security' ? 'Run 3 security checks' : 'Run 4 safe reads',
    action: 'start-mission',
    disabled: false,
  });
  if (state.phase === PHASE.PREPARING) return guidedContext({
    current: 'Read-only evidence is correlated',
    next: activeProfile.completion === 'read-only' ? 'Seal without preparing an effect' : 'Prepare two exact effects',
    requires: 'Continue from the evidence checkpoint',
    label: activeProfile.completion === 'read-only' ? 'Seal read-only audit' : 'Prepare 2 exact effects',
    action: 'start-mission',
    disabled: false,
  });
  if (state.phase === PHASE.REVIEW) return guidedContext({
    current: 'Evidence complete; both changes remain locked',
    next: 'Review each exact effect separately',
    requires: 'Approve or leave each change locked',
    label: 'Review 2 exact changes',
    action: 'review-approval',
    disabled: false,
  });
  if (state.phase === PHASE.APPROVED) return guidedContext({
    current: 'Both exact effects approved',
    next: 'Execute the bound pair once',
    requires: 'Review once more, then execute',
    label: 'Review approved actions',
    action: 'review-approval',
    disabled: false,
  });
  if (state.phase === PHASE.EXECUTING) return {
    current: 'Execution stopped before a verified seal',
    next: 'Return to a clean objective',
    requires: 'Reset after reviewing the audit',
    label: 'View audit trail',
    action: 'open-audit',
    disabled: false,
  };
  return guidedContext({
    current: `${activeProfile.outcome.title}; audit chain sealed`,
    next: 'Inspect receipts and proof',
    requires: 'No further action required',
    label: 'View sealed audit',
    action: 'open-audit',
    disabled: false,
  });
}

function renderMissionContext() {
  const context = missionContextState();
  q('[data-context-mission]').textContent = activeProfile.title;
  q('[data-context-label="current"]').textContent = guidedTourActive ? 'What happened' : 'Current';
  q('[data-context-label="next"]').textContent = guidedTourActive ? 'Why it matters' : 'Next';
  q('[data-context-label="requires"]').textContent = guidedTourActive ? 'Next' : 'Requires you';
  q('[data-context-current]').textContent = context.current;
  q('[data-context-next]').textContent = context.next;
  q('[data-context-requires]').textContent = context.requires;
  const action = q('[data-context-action]');
  action.dataset.action = context.action;
  action.disabled = context.disabled;
  action.toggleAttribute('aria-busy', Boolean(context.loading));
  action.classList.toggle('is-loading', Boolean(context.loading));
  q('[data-context-action-label]').textContent = context.label;
}

function renderMissionBrief() {
  const copy = q('[data-objective-copy]');
  const input = q('[data-objective-input]');
  const complete = state.phase === PHASE.COMPLETE;
  const applyReceipt = controllerSnapshot.results['apply-recovery-option'];
  const publishReceipt = controllerSnapshot.results['publish-status-update'];
  q('[data-mission-kicker]').textContent = complete ? 'Verified outcome' : activeProfile.kicker;
  q('[data-mission-title]').textContent = complete ? activeProfile.outcome.title : activeProfile.title;
  q('[data-constraint="environment"]').textContent = complete ? formatMissionTime(missionCompletedIn ?? 0) : activeProfile.constraints[0];
  q('[data-constraint="mode"]').textContent = complete
    ? `${new Set(runtimeTools.map(({ origin }) => origin)).size} origins consulted`
    : activeProfile.constraints[1];
  q('[data-constraint="authority"]').textContent = complete ? activeProfile.outcome.authority : activeProfile.constraints[2];
  copy.hidden = editingObjective;
  input.hidden = !editingObjective;
  if (!editingObjective) copy.textContent = complete
    ? activeProfile.completion === 'mutations'
      ? `${applyReceipt?.activeReleaseId ?? 'Verified release'} restored; ${publishReceipt?.noticeRevision ?? 'customer update'} published; audit chain sealed.`
      : activeProfile.outcome.summary
    : objective;
  const editButton = q('[data-action="edit-objective"]');
  const saveButton = q('[data-action="save-objective"]');
  const cancelButton = q('[data-action="cancel-objective"]');
  editButton.hidden = complete || editingObjective;
  saveButton.hidden = !editingObjective;
  cancelButton.hidden = !editingObjective;
  editButton.disabled = state.phase !== PHASE.IDLE;
  saveButton.disabled = state.phase !== PHASE.IDLE;
  cancelButton.disabled = state.phase !== PHASE.IDLE;
}

function renderMissionGallery() {
  const grid = q('[data-mission-gallery-grid]');
  if (!grid) return;
  if (!grid.children.length) {
    grid.innerHTML = MISSION_PROFILES.map((profile, index) => `
      <button class="mission-profile-card" type="button" data-action="select-mission" data-mission-id="${htmlEscape(profile.id)}">
        <span class="mission-profile-index">0${index + 1}</span>
        <span class="mission-profile-icon" data-accent="${htmlEscape(profile.accent)}">${iconMarkup(profile.icon)}</span>
        <span class="mission-profile-copy"><small>${htmlEscape(profile.kicker)}</small><strong>${htmlEscape(profile.title)}</strong><em>${htmlEscape(profile.summary)}</em></span>
        <span class="mission-profile-proof">${htmlEscape(profile.proof)}</span>
        <i class="mission-profile-select" aria-hidden="true"></i>
      </button>
    `).join('');
  }
  for (const card of qa('[data-mission-id]', grid)) {
    const selected = card.dataset.missionId === activeProfile.id;
    card.dataset.selected = String(selected);
    card.setAttribute('aria-pressed', String(selected));
    card.disabled = state.phase !== PHASE.IDLE || operationRunning;
  }
}

function renderProviderLegend() {
  const discovered = state.phase === PHASE.IDLE ? [] : [...new Set(state.discovery.tools.map(({ origin }) => origin))];
  const healthFailed = semanticNodeState('service.health.read') === NODE_STATUS.FAILED;
  const quarantineCount = Object.keys(state.quarantine).length;
  const degradedCount = healthFailed || providerSwapRequested ? 1 : 0;
  q('[data-healthy-count]').textContent = String(Math.max(0, discovered.length - quarantineCount - degradedCount));
  q('[data-degraded-count]').textContent = String(degradedCount);
  q('[data-quarantine-count]').textContent = String(quarantineCount);
  const swapButton = q('[data-action="swap-provider"]');
  const swapStatus = q('[data-swap-status]');
  swapButton.hidden = false;
  swapStatus.hidden = !providerSwapRequested;
  swapButton.dataset.ready = healthFailed ? 'true' : 'false';
  swapButton.disabled = false;
  swapButton.innerHTML = `Explain automatic fallback <span>${iconMarkup('swap')}</span>`;
}

function renderConstellation() {
  const placeholder = q('[data-constellation-placeholder]');
  const mount = q('[data-constellation]');
  const visible = state.phase !== PHASE.IDLE;
  placeholder.hidden = visible;
  mount.hidden = !visible;
  if (!visible) return;

  const layout = createConstellationLayout(graphInput());
  mount.innerHTML = renderConstellationSvg(layout, {
    title: `ToolBraid ${activeProfile.shortTitle} provider constellation`,
    description: 'Independent WebMCP provider origins map to canonical capabilities. Active edges pulse only while their real mission event is running.',
  });
  const graph = q('.tb-constellation', mount);
  const zoomWidth = layout.width / graphZoom;
  const zoomHeight = layout.height / graphZoom;
  const zoomX = (layout.width - zoomWidth) / 2;
  const zoomY = (layout.height - zoomHeight) / 2;
  graph.setAttribute('viewBox', `${zoomX} ${zoomY} ${zoomWidth} ${zoomHeight}`);
  const selectedNodeId = state.selectedNodeId ?? hubNodeId;
  for (const node of qa('[data-node-id]', mount)) {
    const selected = node.dataset.nodeId === selectedNodeId;
    node.dataset.selected = String(selected);
    node.setAttribute('aria-pressed', String(selected));
    node.tabIndex = selected ? 0 : -1;
  }
}

function renderReads() {
  if (activeProfile.completion === 'security') {
    const checks = new Map((controllerSnapshot.securityChecks ?? []).map((check) => [check.challenge, check]));
    const rows = [
      ['health', 'Hostile metadata', checks.get('hostile-metadata')],
      ['release', 'Origin drift', checks.get('origin-drift')],
      ['deployment', 'Nonce replay', checks.get('nonce-replay')],
      ['notice', 'Mutation dispatches', state.phase === PHASE.COMPLETE ? { code: '0 external effects' } : null],
    ];
    q('[data-read-kicker]').textContent = 'Authority evidence';
    q('[data-read-title]').textContent = 'Rejection receipts';
    q('[data-read-summary]').textContent = `${checks.size} / 3`;
    for (const [rowId, title, check] of rows) {
      const row = q(`[data-read="${rowId}"]`);
      row.dataset.state = check ? 'complete' : 'idle';
      q('strong', row).textContent = title;
      q('small', row).textContent = check?.code ?? 'Waiting';
      q('time', row).textContent = check ? 'blocked' : '—';
    }
    return;
  }

  q('[data-read-kicker]').textContent = 'Parallel evidence';
  q('[data-read-title]').textContent = 'Read-only batch';
  let complete = 0;
  const rowTitles = Object.freeze({
    health: 'Service health',
    release: 'Release history',
    deployment: 'Deployment state',
    notice: 'Status notice',
  });
  for (const semanticId of readSemanticIds) {
    const rowId = semanticId.split('.')[0] === 'service' ? 'health' : semanticId.split('.')[0] === 'release' ? 'release' : semanticId.split('.')[0] === 'deployment' ? 'deployment' : 'notice';
    const row = q(`[data-read="${rowId}"]`);
    const info = readUi[semanticId];
    row.dataset.state = info.state;
    q('strong', row).textContent = rowTitles[rowId];
    q('small', row).textContent = info.detail;
    q('time', row).textContent = info.time;
    if (info.state === 'complete') complete += 1;
  }
  q('[data-read-summary]').textContent = `${complete} / 4`;
}

function selectedLayoutNode() {
  return baseLayout.nodes.find((node) => node.id === state.selectedNodeId) ?? baseLayout.hub;
}

function mappingForNode(node) {
  return state.mappings[node.id] ?? null;
}

function confidenceForNode(node) {
  if (node.type === 'capability' || node.type === 'mutation') {
    return controllerSnapshot.normalization?.mappings.find(({ capabilityId }) => capabilityId === node.semanticId)?.confidence ?? null;
  }
  if (node.type === 'provider') return state.phase === PHASE.IDLE ? null : 1;
  if (node.type === 'hub' && [PHASE.PREPARING, PHASE.REVIEW, PHASE.APPROVED, PHASE.EXECUTING, PHASE.COMPLETE].includes(state.phase)) {
    const confidences = controllerSnapshot.normalization?.mappings.map(({ confidence }) => confidence).filter(Number.isFinite) ?? [];
    return confidences.length ? Math.min(...confidences) : null;
  }
  return null;
}

function nodeDescription(node) {
  if (node.type === 'hub') return 'Correlates provider evidence into one explainable, approval-bound recovery plan.';
  if (node.type === 'provider') {
    if (providerSwapRequested && node.origin === RECOVERY_PROVIDER_ORIGINS.pulse) {
      return 'Selected compatible read-only fallback. Pulse Monitor completed the health read without changing the recovery plan.';
    }
    if (providerSwapRequested && node.origin === RECOVERY_PROVIDER_ORIGINS.signals) {
      return 'Primary health provider became unavailable and was safely substituted; its origin remains recorded in the audit.';
    }
    return `Independent WebMCP document at ${node.origin}. ToolBraid preserves its origin identity.`;
  }
  if (node.type === 'mutation') return node.semanticId === 'recovery.option.apply'
    ? 'Applies only the exact recovery option and quote revision approved by the human.'
    : 'Publishes only the exact customer notice reviewed and approved by the human.';
  if (node.semanticId === 'unsafe.override') return 'Quarantined before semantic scoring because its metadata attempts to bypass human approval.';
  return `Canonical capability ${node.semanticId}, mapped from provider metadata and schema evidence.`;
}

function evidenceForNode(node) {
  if (node.type === 'capability' && runtimeEvidence[node.semanticId]) {
    const status = missionNode(node.id)?.status;
    return status === NODE_STATUS.COMPLETED ? [runtimeEvidence[node.semanticId]] : [];
  }
  if (node.type === 'hub' || node.type === 'mutation') {
    return Object.entries(runtimeEvidence)
      .filter(([semanticId]) => semanticNodeState(semanticId) === NODE_STATUS.COMPLETED)
      .map(([, evidence]) => evidence);
  }
  return [];
}

function renderInspector() {
  const node = selectedLayoutNode();
  const mapping = mappingForNode(node);
  const mappedTool = mapping ? toolById(mapping.primaryToolId) : null;
  const confidence = confidenceForNode(node);
  const quarantined = node.id === unsafeNodeId
    || node.origin === RECOVERY_PROVIDER_ORIGINS.mirage
    || (mappedTool && state.quarantine[mappedTool.id]);

  q('[data-selected-icon]').innerHTML = iconMarkup(iconNameForNode(node), { className: 'ui-icon inspector-icon' });
  q('[data-selected-kind]').textContent = node.type === 'capability' ? 'Canonical capability' : node.type;
  q('[data-selected-title]').textContent = node.label;
  q('[data-selected-description]').textContent = nodeDescription(node);
  const confidencePercent = confidence === null ? 0 : Math.round(confidence * 100);
  q('[data-confidence-value]').textContent = confidence === null ? '—' : `${confidencePercent}%`;
  q('[data-confidence-bar]').value = confidencePercent;
  q('[data-confidence-bar]').textContent = `${confidencePercent}%`;
  q('[data-mapped-concepts]').textContent = `${Object.keys(state.mappings).length} / 7 capabilities`;
  q('[data-origin-provider]').textContent = mappedTool?.title ?? node.label;
  q('[data-origin-value]').textContent = mappedTool?.origin ?? node.origin ?? 'toolbraid://local-plan';
  q('[data-tool-value]').textContent = mappedTool?.name ?? (node.type === 'hub' ? 'evidence.correlate' : '—');
  q('[data-schema-value]').textContent = mappedTool?.schemaFingerprint
    ? `sha256:${mappedTool.schemaFingerprint.slice(0, 12)}…`
    : '—';

  const securityChecks = activeProfile.completion === 'security'
    ? controllerSnapshot.securityChecks ?? []
    : [];
  const securityVerified = securityChecks.length === 3 && state.phase === PHASE.COMPLETE;
  const securityQuarantined = activeProfile.completion === 'security'
    && Object.keys(state.quarantine).length > 0;
  const signalQuarantined = securityQuarantined && !securityVerified ? true : Boolean(quarantined);
  const signal = q('[data-signal-card]');
  signal.classList.toggle('quarantine', signalQuarantined);
  signal.classList.toggle('clean', !signalQuarantined);
  q('[data-signal-icon]').innerHTML = iconMarkup(signalQuarantined ? 'quarantine' : 'shield');
  q('[data-signal-status]').textContent = securityVerified
    ? 'Fail-closed verified'
    : securityQuarantined
      ? 'Hostile metadata quarantined'
      : quarantined
        ? 'Quarantined before planning'
        : state.phase === PHASE.IDLE
          ? 'Awaiting discovery'
          : 'Metadata clean';
  q('[data-signal-count]').textContent = securityChecks.length
    ? `${securityChecks.length} attacks blocked`
    : securityQuarantined || quarantined
      ? `${Object.keys(state.quarantine).length || 1} signal`
      : '0 signals';

  const evidence = securityChecks.length
    ? securityChecks.map((check) => ({
      title: check.challenge.split('-').map((part) => `${part[0].toUpperCase()}${part.slice(1)}`).join(' '),
      detail: `${check.code} · rejected before provider dispatch`,
      time: 'blocked',
    }))
    : evidenceForNode(node);
  q('[data-evidence-count]').textContent = `${evidence.length} ${evidence.length === 1 ? 'item' : 'items'}`;
  q('[data-evidence-list]').innerHTML = evidence.length
    ? evidence.map((item) => `<article class="evidence-item"><i></i><span><strong>${htmlEscape(item.title)}</strong><small>${htmlEscape(item.detail)}</small></span><time>${htmlEscape(item.time)}</time></article>`).join('')
    : '<p class="empty-copy">Evidence will appear as safe reads complete.</p>';

  q('[data-mapping-list]').innerHTML = mappableNodeIds.map((nodeId) => {
    const layoutNode = baseLayout.nodes.find((entry) => entry.id === nodeId);
    const current = state.mappings[nodeId];
    const tool = current ? toolById(current.primaryToolId) : null;
    const confidenceValue = confidenceForNode(layoutNode);
    return `<article class="mapping-row"><div><strong>${htmlEscape(layoutNode.label)}</strong><b>${confidenceValue ? `${Math.round(confidenceValue * 100)}%` : '—'}</b></div><small>${tool ? `${htmlEscape(tool.origin)} · ${htmlEscape(tool.name)}` : 'Awaiting semantic normalization'}</small></article>`;
  }).join('');

  renderAudit();
}

function renderAudit() {
  const list = q('[data-audit-list]');
  const overview = q('[data-audit-overview]');
  const panelHash = q('[data-audit-panel-hash]');
  const entries = controllerAuditEntries;
  if (!entries.length) {
    list.innerHTML = '<p class="empty-copy">The audit stream is empty.</p>';
    overview.textContent = 'No recorded phases';
    panelHash.textContent = 'Unsealed';
    q('[data-ticker-events]').innerHTML = '<span><time>—</time> Mission waiting for human objective</span>';
    q('[data-ticker-status]').textContent = 'Ready';
    return;
  }
  const grouped = AUDIT_PHASES.map((phase) => ({
    ...phase,
    entries: entries.filter((entry) => controllerAuditPhaseId(entry) === phase.id),
  })).filter((phase) => phase.entries.length);
  const latestPhaseId = controllerAuditPhaseId(entries.at(-1));
  list.innerHTML = grouped.map((phase) => {
    const hasFailure = phase.entries.some((entry) => ['tool.execution_failed', 'node.failed'].includes(entry.event));
    const hasQuarantine = phase.entries.some((entry) => entry.event === 'tool.quarantined');
    const tone = phase.id === 'execute' && state.phase === PHASE.COMPLETE
      ? 'success'
      : phase.id === 'authorize'
        ? 'authority'
        : hasFailure || hasQuarantine
          ? 'warning'
          : 'info';
    const open = phase.id === latestPhaseId;
    const events = phase.entries.map((entry) => {
      const time = formatAuditTime(new Date(entry.timestamp));
      return `<article class="audit-event"><time>${time}</time><i></i><p><strong>${htmlEscape(ENGINE_EVENT_COPY[entry.event] ?? entry.event)}</strong><small>${htmlEscape(controllerAuditDetail(entry))}</small></p></article>`;
    }).join('');
    return `<details class="audit-phase" data-tone="${tone}" data-audit-phase="${phase.id}"${open ? ' open' : ''}><summary><span><b>${phase.label}</b><small>${phase.hint}</small></span><em>${phase.entries.length} ${phase.entries.length === 1 ? 'event' : 'events'}</em><strong>${htmlEscape(auditPhaseSummary(phase.id, phase.entries))}</strong></summary><div class="audit-phase-events">${events}</div></details>`;
  }).join('');
  overview.textContent = `${grouped.length} phases · ${entries.length} SHA-256 chained events`;
  panelHash.textContent = state.phase === PHASE.COMPLETE
    ? (auditSealHash ?? 'Seal pending…')
    : `sha256:${entries.at(-1).hash.slice(0, 20)}… · live`;
  const latest = entries.at(-1);
  const latestTime = formatAuditTime(new Date(latest.timestamp));
  q('[data-ticker-events]').innerHTML = `<span><time>${latestTime}</time> ${htmlEscape(ENGINE_EVENT_COPY[latest.event] ?? latest.event)}</span>`;
  q('[data-ticker-status]').textContent = state.phase === PHASE.COMPLETE ? 'Sealed' : 'Live';
}

function renderApprovals() {
  const mutationMission = activeProfile.completion === 'mutations';
  const approvalView = q('[data-approvals-view]');
  if (!mutationMission) {
    q('[data-approval-count]').hidden = true;
    approvalDialogOpen = false;
    for (const card of qa('[data-approval-view-card]', approvalView)) card.hidden = true;
    const empty = q('[data-approval-view-empty]', approvalView);
    empty.hidden = false;
    q('strong', empty).textContent = 'No approval path in this mission';
    q('p', empty).textContent = activeProfile.completion === 'read-only'
      ? 'The incident trace terminates after correlated evidence and fallback receipts. ToolBraid never prepares or dispatches an external effect.'
      : 'The security mission proves rejection inside the authority verifier. No production approval or provider mutation is created.';
    q('[data-approval-view-status]', approvalView).textContent = state.phase === PHASE.COMPLETE ? 'No mutation · sealed' : 'Not required';
    q('[data-approval-view-count]', approvalView).textContent = '0 external effects';
    q('[data-approval-view-phase]', approvalView).textContent = state.phase === PHASE.COMPLETE ? 'Audit verified' : 'Policy enforced';
    q('[data-approval-dialog]').hidden = true;
    q('[data-dialog-backdrop]').hidden = !(commandMenuOpen || helpDrawerOpen);
    q('[data-command-menu]').hidden = !commandMenuOpen;
    q('.app-frame').toggleAttribute('inert', commandMenuOpen || helpDrawerOpen);
    return;
  }
  for (const card of qa('[data-approval-view-card]', approvalView)) card.hidden = false;
  const applyApproved = state.approvals.apply.granted;
  const publishApproved = state.approvals.publish.granted;
  const complete = state.phase === PHASE.COMPLETE;
  const applyPlan = controllerSnapshot.plan?.nodes.find(({ id }) => id === 'apply-recovery-option');
  const publishPlan = controllerSnapshot.plan?.nodes.find(({ id }) => id === 'publish-status-update');
  const applyReceipt = controllerSnapshot.results['apply-recovery-option'];
  const publishReceipt = controllerSnapshot.results['publish-status-update'];
  const deployment = controllerSnapshot.results['read-deployment-history']?.deployments?.[0];
  const currentNotice = controllerSnapshot.results['read-status-notice'];
  const preparedRecovery = controllerSnapshot.results['prepare-recovery-option'];
  const approvalReviewReady = state.phase === PHASE.REVIEW;
  const pendingApprovals = approvalReviewReady
    ? Number(!applyApproved) + Number(!publishApproved)
    : 0;
  q('[data-approval-count]').textContent = String(pendingApprovals);
  q('[data-approval-count]').hidden = pendingApprovals === 0;

  if (approvalView) {
    const approvalViewReady = [PHASE.REVIEW, PHASE.APPROVED].includes(state.phase);
    const approvalViewComplete = state.phase === PHASE.COMPLETE;
    const status = approvalViewComplete
      ? 'Sealed locally'
      : state.phase === PHASE.APPROVED
        ? 'Ready to execute'
        : approvalViewReady
          ? 'Review required'
          : 'Waiting for evidence';
    q('[data-approval-view-status]', approvalView).textContent = status;
    q('[data-approval-view-count]', approvalView).textContent = approvalViewComplete
      ? '2 of 2 executed · sealed'
      : state.phase === PHASE.APPROVED
        ? '2 of 2 approved'
        : `${approvalReviewReady ? pendingApprovals : 0} of 2 actionable`;
    q('[data-approval-view-phase]', approvalView).textContent = approvalViewComplete
      ? 'Receipts verified'
      : state.phase === PHASE.APPROVED
        ? 'Exact scopes approved'
        : approvalViewReady
          ? 'Human checkpoint'
          : 'Evidence first';
    const applyTarget = applyPlan?.mapping ? `${applyPlan.mapping.origin} · ${applyPlan.mapping.name}` : 'Awaiting verified evidence';
    const publishTarget = publishPlan?.mapping ? `${publishPlan.mapping.origin} · ${publishPlan.mapping.name}` : 'Awaiting verified evidence';
    q('[data-approval-view-target="apply"]', approvalView).textContent = applyTarget;
    q('[data-approval-view-target="publish"]', approvalView).textContent = publishTarget;
    q('[data-approval-view-effect="apply"]', approvalView).textContent = applyPlan?.effectSummary ?? (applyReceipt ? `${applyReceipt.activeReleaseId} restored` : 'No action prepared');
    q('[data-approval-view-effect="publish"]', approvalView).textContent = publishPlan?.effectSummary ?? (publishReceipt ? `${publishReceipt.noticeRevision} published` : 'No action prepared');
    for (const scope of ['apply', 'publish']) {
      const granted = state.approvals[scope].granted;
      const receipt = scope === 'apply' ? applyReceipt : publishReceipt;
      const card = q(`[data-approval-view-card="${scope}"]`, approvalView);
      const stateLabel = q(`[data-approval-view-state="${scope}"]`, approvalView);
      const action = q('[data-action="review-approval"]', card);
      card.classList.toggle('approved', granted);
      card.classList.toggle('sealed', Boolean(receipt));
      stateLabel.textContent = receipt ? 'Executed' : granted ? 'Approved' : approvalViewReady ? 'Ready to review' : 'Locked';
      action.disabled = !approvalViewReady && !approvalViewComplete;
      action.innerHTML = approvalViewComplete ? 'View sealed audit <span aria-hidden="true">→</span>' : 'Open exact review <span aria-hidden="true">→</span>';
    }
    const empty = q('[data-approval-view-empty]', approvalView);
    empty.hidden = approvalViewReady || approvalViewComplete;
    q('strong', empty).textContent = 'No actionable approval yet';
    q('p', empty).textContent = 'Start the walkthrough, complete the safe evidence batch, and ToolBraid will stop here before any external mutation.';
  }

  const applyCard = q('[data-node-target="apply-recovery"]');
  const publishCard = q('[data-node-target="publish-update"]');
  applyCard.classList.toggle('approved', applyApproved);
  publishCard.classList.toggle('approved', publishApproved);
  applyCard.classList.toggle('sealed', Boolean(applyReceipt));
  publishCard.classList.toggle('sealed', Boolean(publishReceipt));
  q('[data-apply-kicker]').textContent = applyReceipt ? 'Receipt 01 · production' : 'Production mutation';
  q('[data-apply-title]').textContent = applyReceipt ? 'Recovery applied' : 'Apply recovery';
  q('[data-apply-state]').textContent = applyReceipt
    ? `${applyReceipt.activeReleaseId} restored`
    : applyApproved ? 'Approved · single use' : 'Locked';
  q('[data-publish-kicker]').textContent = publishReceipt ? 'Receipt 02 · communication' : 'Customer communication';
  q('[data-publish-title]').textContent = publishReceipt ? 'Update published' : 'Publish update';
  q('[data-publish-state]').textContent = publishReceipt
    ? `${publishReceipt.noticeRevision} published`
    : publishApproved ? 'Approved · single use' : 'Locked';
  const applyReceiptCode = q('[data-apply-receipt]');
  const publishReceiptCode = q('[data-publish-receipt]');
  applyReceiptCode.hidden = !applyReceipt;
  publishReceiptCode.hidden = !publishReceipt;
  applyReceiptCode.textContent = applyReceipt?.operationId ?? '—';
  publishReceiptCode.textContent = publishReceipt?.publicationId ?? '—';
  applyCard.lastElementChild.innerHTML = iconMarkup(applyReceipt ? 'check' : 'lock');
  publishCard.lastElementChild.innerHTML = iconMarkup(publishReceipt ? 'check' : 'lock');
  applyCard.setAttribute('aria-label', applyReceipt ? `Inspect receipt: ${applyReceipt.operationId}` : 'Inspect apply recovery mutation');
  publishCard.setAttribute('aria-label', publishReceipt ? `Inspect receipt: ${publishReceipt.publicationId}` : 'Inspect publish update mutation');
  q('[data-approval-kicker]').textContent = complete ? 'Verified local receipt' : 'Human checkpoint';
  q('[data-approval-title]').textContent = complete ? 'Execution locally sealed' : 'Approval required';
  q('[data-approval-detail]').textContent = complete
    ? 'Both authorized effects completed and were committed to the audit chain.'
    : 'External mutations stay cryptographically bound and locked.';
  const auditHash = q('[data-audit-hash]');
  auditHash.hidden = !complete;
  auditHash.textContent = complete ? (auditSealHash ?? 'sha256: sealing…') : 'Audit seal pending';
  const gateIcon = q('.gate-lock');
  gateIcon.innerHTML = iconMarkup(complete ? 'check' : 'lock');

  const reviewButton = q('[data-action="review-approval"]', q('[data-approval-dock]'));
  reviewButton.disabled = ![PHASE.REVIEW, PHASE.APPROVED, PHASE.COMPLETE].includes(state.phase);
  reviewButton.innerHTML = complete
    ? `View sealed audit <span>${iconMarkup('check')}</span>`
    : state.phase === PHASE.APPROVED
      ? 'Inspect approved effects <span>→</span>'
      : 'Review exact effects <span>→</span>';

  q('.rail-button[data-view="audit"]').hidden = false;
  q('[data-panel-tab="audit"]').hidden = false;
  q('.activity-ticker > [data-action="open-audit"]').hidden = false;

  const applyReview = q('[data-approval-review="apply"]');
  const publishReview = q('[data-approval-review="publish"]');
  applyReview.classList.toggle('approved', applyApproved);
  publishReview.classList.toggle('approved', publishApproved);
  q('[data-review-apply-state]').textContent = applyApproved ? 'Approved' : 'Locked';
  q('[data-review-publish-state]').textContent = publishApproved ? 'Approved' : 'Locked';
  q('[data-review-apply-before]').textContent = deployment?.releaseId
    ? `${deployment.releaseId} active in production`
    : 'Awaiting verified deployment state';
  q('[data-review-apply-after]').textContent = preparedRecovery?.targetReleaseId
    ? `${preparedRecovery.targetReleaseId} restored`
    : 'Awaiting prepared recovery target';
  q('[data-review-apply-target]').textContent = applyPlan?.mapping
    ? `${applyPlan.mapping.origin} · ${applyPlan.mapping.name}`
    : 'Awaiting mapping';
  q('[data-review-apply-expiry]').textContent = approvalExpiryText('apply-recovery-option');
  q('[data-review-apply-origin]').textContent = applyPlan?.mapping?.origin ?? 'Awaiting mapping';
  q('[data-review-apply-tool]').textContent = applyPlan?.mapping?.name ?? '—';
  q('[data-review-apply-effect]').textContent = applyPlan?.effectSummary ?? 'Awaiting verified evidence';
  q('[data-review-apply-arguments]').textContent = JSON.stringify(applyPlan?.arguments ?? {}, null, 2);
  q('[data-review-publish-before]').textContent = currentNotice?.noticeRevision
    ? `${currentNotice.noticeRevision} · current public notice`
    : 'Awaiting current customer notice';
  q('[data-review-publish-target]').textContent = publishPlan?.mapping
    ? `${publishPlan.mapping.origin} · ${publishPlan.mapping.name}`
    : 'Awaiting mapping';
  q('[data-review-publish-expiry]').textContent = approvalExpiryText('publish-status-update');
  q('[data-review-publish-origin]').textContent = publishPlan?.mapping?.origin ?? 'Awaiting mapping';
  q('[data-review-publish-tool]').textContent = publishPlan?.mapping?.name ?? '—';
  q('[data-review-publish-effect]').textContent = publishPlan?.effectSummary ?? 'Awaiting verified evidence';
  q('[data-review-publish-body]').textContent = publishPlan?.arguments?.body
    ?? 'Customer-visible content appears after the safe evidence phase.';
  q('[data-review-publish-arguments]').textContent = JSON.stringify(publishPlan?.arguments ?? {}, null, 2);
  const approveApply = q('[data-action="approve-apply"]');
  const approvePublish = q('[data-action="approve-publish"]');
  approveApply.disabled = applyApproved || operationRunning || state.phase !== PHASE.REVIEW;
  approvePublish.disabled = publishApproved || operationRunning || state.phase !== PHASE.REVIEW;
  approveApply.textContent = applyApproved
    ? 'Approved ✓'
    : pendingApprovalScope === 'apply'
      ? 'Binding exact approval…'
      : bridgeMode === 'approval'
        ? 'Waiting for other approval…'
        : 'Approve apply recovery';
  approvePublish.textContent = publishApproved
    ? 'Approved ✓'
    : pendingApprovalScope === 'publish'
      ? 'Binding exact approval…'
      : bridgeMode === 'approval'
        ? 'Waiting for other approval…'
        : 'Approve publish update';
  q('[data-approval-summary]').textContent = `${Number(applyApproved) + Number(publishApproved)} of 2 approved`;
  const executeButton = q('[data-action="execute-approved"]');
  executeButton.disabled = state.phase !== PHASE.APPROVED || operationRunning;
  executeButton.toggleAttribute('aria-busy', bridgeMode === 'execution');
  q('[data-execute-label]').textContent = bridgeMode === 'execution'
    ? 'Executing approved actions…'
    : 'Execute approved actions';

  q('[data-approval-dialog]').hidden = !approvalDialogOpen;
  q('[data-dialog-backdrop]').hidden = !(approvalDialogOpen || commandMenuOpen || helpDrawerOpen);
  q('[data-command-menu]').hidden = !commandMenuOpen;
  q('.app-frame').toggleAttribute('inert', approvalDialogOpen || commandMenuOpen || helpDrawerOpen);
}

function render() {
  renderHeader();
  renderTrajectory();
  renderGuidedControl();
  renderJudgeGuide();
  renderMissionContext();
  renderMissionBrief();
  renderMissionGallery();
  renderProviderLegend();
  renderConstellation();
  renderReads();
  renderInspector();
  renderApprovals();
  renderPrimaryView();
}

function showToast(title, detail, tone = 'info') {
  const region = q('[data-toast-region]');
  while (region.children.length >= 3) region.firstElementChild?.remove();
  const toast = document.createElement('article');
  toast.className = 'toast';
  toast.dataset.tone = tone;
  toast.innerHTML = `<i></i><div><strong>${htmlEscape(title)}</strong><small>${htmlEscape(detail)}</small></div>`;
  region.append(toast);
  schedule(4200, () => toast.remove());
}

async function discoverySequence() {
  if (state.phase !== PHASE.IDLE || operationRunning) return;
  const epoch = missionEpoch;
  operationRunning = true;
  bridgeMode = 'discovery';
  render();
  missionStartedAt = Date.now();
  providerSwapRequested = false;
  showToast('Connecting provider runtime', 'Loading the explicitly allowed WebMCP origins.', 'info');
  try {
    await ensureProviderRuntime();
    const snapshot = await missionController.discoverTools(objective);
    if (epoch !== missionEpoch) return;
    syncControllerSnapshot(snapshot);
    if (state.phase !== PHASE.MAPPING || Object.keys(state.mappings).length) {
      throw new Error('The real discovery stream did not stop at the registry checkpoint.');
    }
    showToast('Registry verified', `${runtimeTools.length} tools were inspected; hostile metadata was quarantined before mapping.`, 'success');
  } catch (error) {
    if (epoch !== missionEpoch) return;
    showToast('Mission could not start', error?.message ?? 'WebMCP discovery failed.', 'danger');
    await missionController.reset();
    syncControllerSnapshot();
    if (state.phase !== PHASE.IDLE) dispatch({ type: EVENT.RESET }, { silentError: true });
    missionStartedAt = null;
  } finally {
    if (epoch === missionEpoch) {
      bridgeMode = 'idle';
      operationRunning = false;
      render();
    }
  }
}

async function mappingSequence() {
  if (state.phase !== PHASE.MAPPING || Object.keys(state.mappings).length || operationRunning) return;
  const epoch = missionEpoch;
  operationRunning = true;
  bridgeMode = 'mapping';
  render();
  try {
    const snapshot = await missionController.mapCapabilities();
    if (epoch !== missionEpoch) return;
    syncControllerSnapshot(snapshot);
    if (Object.keys(state.mappings).length !== mappableNodeIds.length) {
      throw new Error('The real mapping stream did not bind every required capability.');
    }
    showToast('Capabilities normalized', `${Object.keys(runtimeMappings).length} capabilities are bound to live tool contracts.`, 'success');
  } catch (error) {
    if (epoch !== missionEpoch) return;
    showToast('Mapping stopped safely', error?.message ?? 'Canonical capability mapping failed.', 'danger');
  } finally {
    if (epoch === missionEpoch) {
      bridgeMode = 'idle';
      operationRunning = false;
      render();
    }
  }
}

async function safeReadSequence() {
  if (state.phase !== PHASE.MAPPING
      || Object.keys(state.mappings).length !== mappableNodeIds.length
      || operationRunning) return;
  const epoch = missionEpoch;
  operationRunning = true;
  renderHeader();
  bridgeMode = 'safe';
  safeUiStarted = false;
  for (const semanticId of readSemanticIds) {
    readUi[semanticId] = { state: 'active', detail: 'Reading native tool', time: '…' };
  }
  render();
  try {
    const snapshot = await missionController.runEvidence();
    if (epoch !== missionEpoch) return;
    syncControllerSnapshot(snapshot);
    if (state.phase !== PHASE.PREPARING) throw new Error('Read-only execution stopped before evidence correlation completed.');
    showToast(
      'Evidence checkpoint complete',
      providerSwapRequested
        ? 'The primary failed closed; a compatible read-only fallback completed the evidence batch.'
        : 'Four independent reads converged without preparing or executing an external effect.',
      'success',
    );
  } catch (error) {
    if (epoch !== missionEpoch) return;
    if (state.phase === PHASE.PREPARING && missionNode(prepareNodeId)?.status !== NODE_STATUS.FAILED) {
      dispatch({ type: EVENT.PREPARATION_FAILED, error: error?.message ?? 'recovery preparation failed' });
    }
    showToast('Safe execution stopped', error?.message ?? 'A required evidence or preparation step failed.', 'danger');
  } finally {
    if (epoch === missionEpoch) {
      bridgeMode = 'idle';
      operationRunning = false;
      render();
    }
  }
}

async function preparationSequence() {
  if (activeProfile.completion !== 'mutations' || state.phase !== PHASE.PREPARING || operationRunning) return;
  const epoch = missionEpoch;
  operationRunning = true;
  bridgeMode = 'preparation';
  render();
  try {
    const snapshot = await missionController.prepareSafe();
    if (epoch !== missionEpoch) return;
    syncControllerSnapshot(snapshot);
    if (state.phase !== PHASE.REVIEW) throw new Error('Preparation stopped before exact mutation arguments were finalized.');
    showToast('Human checkpoint reached', 'Two exact external effects are prepared and remain locked for separate approvals.', 'warning');
  } catch (error) {
    if (epoch !== missionEpoch) return;
    if (state.phase === PHASE.PREPARING && missionNode(prepareNodeId)?.status !== NODE_STATUS.FAILED) {
      dispatch({ type: EVENT.PREPARATION_FAILED, error: error?.message ?? 'recovery preparation failed' });
    }
    showToast('Preparation stopped safely', error?.message ?? 'Exact effects could not be prepared.', 'danger');
  } finally {
    if (epoch === missionEpoch) {
      bridgeMode = 'idle';
      operationRunning = false;
      render();
    }
  }
}

async function completeReadOnlySequence() {
  if (activeProfile.completion !== 'read-only' || state.phase !== PHASE.PREPARING || operationRunning) return;
  const epoch = missionEpoch;
  operationRunning = true;
  bridgeMode = 'sealing';
  render();
  try {
    const snapshot = await missionController.completeReadOnly();
    if (epoch !== missionEpoch) return;
    syncControllerSnapshot(snapshot);
    const sealHash = snapshot.seal?.head;
    if (!sealHash || !snapshot.auditVerified) throw new Error('Read-only evidence completed without a verified audit seal.');
    dispatch({
      type: EVENT.MISSION_SEALED,
      kind: 'read-only',
      sealHash,
      resultNodeIds: readNodeIds,
    });
    missionCompletedIn = missionStartedAt ? Date.now() - missionStartedAt : 0;
    showToast('Incident trace sealed', 'Fallback evidence was verified; zero external effects were prepared or dispatched.', 'success');
  } catch (error) {
    if (epoch !== missionEpoch) return;
    showToast('Read-only seal blocked', error?.message ?? 'The evidence chain could not be sealed.', 'danger');
  } finally {
    if (epoch === missionEpoch) {
      bridgeMode = 'idle';
      operationRunning = false;
      render();
    }
  }
}

async function authoritySequence() {
  if (activeProfile.completion !== 'security'
      || state.phase !== PHASE.MAPPING
      || Object.keys(state.mappings).length !== mappableNodeIds.length
      || operationRunning) return;
  const epoch = missionEpoch;
  operationRunning = true;
  bridgeMode = 'security';
  render();
  try {
    const snapshot = await missionController.verifyAuthorityBoundary();
    if (epoch !== missionEpoch) return;
    syncControllerSnapshot(snapshot);
    const sealHash = snapshot.seal?.head;
    if (!sealHash || !snapshot.auditVerified || snapshot.securityChecks.length !== 3) {
      throw new Error('Authority verification completed without three sealed rejection receipts.');
    }
    dispatch({ type: EVENT.MISSION_SEALED, kind: 'security', sealHash, resultNodeIds: [] });
    missionCompletedIn = missionStartedAt ? Date.now() - missionStartedAt : 0;
    showToast('Authority attack stopped', 'Hostile metadata, origin drift, and nonce replay were rejected before provider dispatch.', 'success');
  } catch (error) {
    if (epoch !== missionEpoch) return;
    showToast('Authority verification blocked', error?.message ?? 'The fail-closed proof could not be sealed.', 'danger');
  } finally {
    if (epoch === missionEpoch) {
      bridgeMode = 'idle';
      operationRunning = false;
      render();
    }
  }
}

async function advanceMission({ auto = !guidedTourActive } = {}) {
  if (operationRunning) return;
  if (state.phase === PHASE.COMPLETE) {
    setPrimaryView('audit', { moveFocus: true });
    return;
  }
  if (state.phase === PHASE.IDLE) {
    await discoverySequence();
    if (!auto || state.phase !== PHASE.MAPPING) return;
  }
  if (state.phase === PHASE.MAPPING && !Object.keys(state.mappings).length) {
    await mappingSequence();
    if (!auto || Object.keys(state.mappings).length !== mappableNodeIds.length) return;
  }
  if (state.phase === PHASE.MAPPING && activeProfile.completion === 'security') {
    await authoritySequence();
    return;
  }
  if (state.phase === PHASE.MAPPING) {
    await safeReadSequence();
    if (!auto || state.phase !== PHASE.PREPARING) return;
  }
  if (state.phase === PHASE.PREPARING && activeProfile.completion === 'read-only') {
    await completeReadOnlySequence();
    return;
  }
  if (state.phase === PHASE.PREPARING && activeProfile.completion === 'mutations') {
    await preparationSequence();
  }
}

function swapProvider() {
  showToast(
    providerSwapRequested ? 'Fallback verified' : 'Fallback is automatic',
    providerSwapRequested
      ? 'The engine already substituted the compatible read-only provider and recorded both identities.'
      : 'Read-only failover is selected only after a primary provider fails closed; no provider is changed by this control.',
    providerSwapRequested ? 'success' : 'info',
  );
}

async function copySelectedOrigin() {
  const value = q('[data-origin-value]').textContent;
  try {
    if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
    await navigator.clipboard.writeText(value);
    showToast('Origin copied', value, 'info');
  } catch {
    showToast('Copy unavailable', 'Select the origin in the inspector and copy it manually.', 'warning');
  }
}

function openHelpDrawer() {
  if (!helpDrawerOpen && !overlayReturnFocus) overlayReturnFocus = document.activeElement;
  helpDrawerOpen = true;
  renderPrimaryView();
  schedule(0, () => q('[data-action="close-help"]')?.focus());
}

function closeHelpDrawer({ restoreFocus = true } = {}) {
  if (!helpDrawerOpen) return;
  const returnTarget = overlayReturnFocus;
  helpDrawerOpen = false;
  overlayReturnFocus = null;
  renderPrimaryView();
  if (restoreFocus) {
    schedule(0, () => {
      const usableTarget = returnTarget?.isConnected
        && !returnTarget.disabled
        && !returnTarget.closest('[hidden]')
        && returnTarget.getClientRects().length > 0;
      (usableTarget ? returnTarget : q('[data-view="topology"]'))?.focus();
    });
  }
}

function openApprovalDialog() {
  if (![PHASE.REVIEW, PHASE.APPROVED].includes(state.phase)) {
    overlayReturnFocus = null;
    showToast('Approval is not ready', 'Complete all evidence reads and recovery preparation first.', 'warning');
    return;
  }
  if (!approvalDialogOpen && !overlayReturnFocus) overlayReturnFocus = document.activeElement;
  commandMenuOpen = false;
  approvalDialogOpen = true;
  renderApprovals();
  schedule(0, () => q('[data-action="close-approval"]')?.focus());
}

function closeOverlays({ restoreFocus = true } = {}) {
  const wasOpen = approvalDialogOpen || commandMenuOpen || helpDrawerOpen;
  const returnTarget = overlayReturnFocus;
  approvalDialogOpen = false;
  commandMenuOpen = false;
  helpDrawerOpen = false;
  overlayReturnFocus = null;
  renderApprovals();
  renderPrimaryView();
  if (wasOpen && restoreFocus) {
    schedule(0, () => {
      const usableTarget = returnTarget?.isConnected
        && !returnTarget.disabled
        && !returnTarget.closest('[hidden]')
        && returnTarget.getClientRects().length > 0;
      (usableTarget ? returnTarget : q('[data-action="open-command"]'))?.focus();
    });
  }
}

async function approveScope(scope) {
  if (state.phase !== PHASE.REVIEW || operationRunning) return;
  const epoch = missionEpoch;
  operationRunning = true;
  pendingApprovalScope = scope;
  bridgeMode = 'approval';
  render();
  const isApply = scope === 'apply';
  try {
    const approved = await missionController.approve(scope);
    if (epoch !== missionEpoch) return;
    syncControllerSnapshot(approved.snapshot);
    showToast(
      `${isApply ? 'Recovery' : 'Update'} approved`,
      `Bound to ${approved.envelope.toolName}, exact arguments and fingerprint ${approved.envelope.fingerprint.slice(0, 10)}….`,
      'success',
    );
  } catch (error) {
    if (epoch !== missionEpoch) return;
    showToast('Approval blocked safely', error?.message ?? 'The exact scope could not be approved.', 'danger');
  } finally {
    if (epoch === missionEpoch) {
      bridgeMode = 'idle';
      pendingApprovalScope = null;
      operationRunning = false;
      render();
    }
  }
}

async function executeApproved() {
  if (state.phase !== PHASE.APPROVED || operationRunning) return;
  const epoch = missionEpoch;
  operationRunning = true;
  renderHeader();
  bridgeMode = 'execution';
  executionUiStarted = false;
  executionUiFailed = false;
  approvalDialogOpen = false;
  overlayReturnFocus = null;
  render();
  schedule(0, () => q('#mission-canvas')?.focus({ preventScroll: true }));
  try {
    const snapshot = await missionController.executeApproved();
    if (epoch !== missionEpoch) return;
    syncControllerSnapshot(snapshot);
    missionCompletedIn = missionStartedAt ? Date.now() - missionStartedAt : 0;
    if (state.phase !== PHASE.COMPLETE || !snapshot.seal || !snapshot.auditVerified) {
      throw new Error('Execution receipts completed without a verified audit seal.');
    }
    render();
    showToast('Mission complete', 'Checkout restored, update published, and the local SHA-256 integrity chain was verified and sealed.', 'success');
  } catch (error) {
    if (epoch !== missionEpoch) return;
    syncControllerSnapshot(error?.snapshot ?? missionController.snapshot());
    showToast('Execution stopped safely', error?.message ?? 'An approved mutation failed.', 'danger');
  } finally {
    if (epoch === missionEpoch) {
      bridgeMode = 'idle';
      operationRunning = false;
      render();
    }
  }
}

function stopGuidedTour({ announce = true } = {}) {
  clearGuidedWork();
  guidedTourActive = false;
  updateMissionUrl();
  render();
  if (announce) showToast('Auto run selected', 'ToolBraid will continue through safe checkpoints until human authority is required.', 'info');
}

async function startGuidedTour() {
  guidedTourActive = true;
  updateMissionUrl();
  commandMenuOpen = false;
  render();
  showToast('Guided judge mode', 'The mission pauses after each real engine checkpoint and explains the proof.', 'info');
  await advanceMission({ auto: false });
}

function toggleGuidance() {
  if (guidedTourActive) stopGuidedTour();
  else {
    guidedTourActive = true;
    updateMissionUrl();
    render();
    showToast('Guided judge mode', 'Each real checkpoint now pauses before the next operation.', 'info');
  }
}

async function resetMission() {
  if (operationRunning) {
    showToast('Mission is still running', 'Reset is locked until the active operation settles and its receipts are recorded.', 'warning');
    return false;
  }
  missionEpoch += 1;
  bridgeMode = 'idle';
  pendingApprovalScope = null;
  safeUiStarted = false;
  executionUiStarted = false;
  executionUiFailed = false;
  clearScheduledWork();
  clearGuidedWork();
  await missionController.reset();
  if (state.phase !== PHASE.IDLE) dispatch({ type: EVENT.RESET }, { silentError: true });
  else state = createState(objective);
  missionStartedAt = null;
  missionCompletedIn = null;
  graphZoom = 1;
  providerSwapRequested = false;
  auditSealHash = null;
  approvalDialogOpen = false;
  commandMenuOpen = false;
  overlayReturnFocus = null;
  editingObjective = false;
  auditTimes = new Map();
  syncControllerSnapshot();
  controllerAuditEntries = [];
  for (const semanticId of readSemanticIds) {
    readUi[semanticId] = { state: 'idle', detail: 'Waiting', time: '—' };
  }
  render();
  return true;
}

function selectGraphNode(nodeId) {
  if (state.phase === PHASE.IDLE) return;
  dispatch({
    type: EVENT.NODE_SELECTED,
    nodeId,
    activeEdgeIds: selectActiveEdgeIds(state),
  });
}

function focusGraphNode(nodeId) {
  schedule(0, () => {
    const node = qa('[data-node-id]', q('[data-constellation]'))
      .find((candidate) => candidate.dataset.nodeId === nodeId);
    if (!node) return;
    node.focus({ preventScroll: true });
    const viewport = q('[data-constellation-viewport]');
    if (viewport.scrollWidth <= viewport.clientWidth) return;
    const viewportRect = viewport.getBoundingClientRect();
    const nodeRect = node.getBoundingClientRect();
    const centered = viewport.scrollLeft
      + nodeRect.left
      + (nodeRect.width / 2)
      - viewportRect.left
      - (viewport.clientWidth / 2);
    viewport.scrollTo({ left: Math.max(0, centered), behavior: 'auto' });
  });
}

function renderPrimaryView() {
  const live = primaryView === 'live';
  const inspector = primaryView === 'evidence' || primaryView === 'audit';
  const approvals = primaryView === 'approvals';
  document.body.dataset.appView = primaryView;
  q('[data-walkthrough-view]').hidden = primaryView !== 'topology';
  q('[data-approval-dock]').hidden = primaryView !== 'topology' || activeProfile.completion !== 'mutations';
  q('[data-universal-view]').hidden = !live;
  q('[data-approvals-view]').hidden = !approvals;
  q('.evidence-panel').hidden = !(primaryView === 'topology' || inspector);
  q('.activity-ticker').hidden = live;
  for (const button of qa('[data-view]')) {
    const isHelp = button.dataset.view === 'help';
    const current = !isHelp && button.dataset.view === primaryView;
    button.classList.toggle('active', current || (isHelp && helpDrawerOpen));
    if (current) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
    if (isHelp) button.setAttribute('aria-expanded', String(helpDrawerOpen));
  }
  q('[data-help-drawer]').hidden = !helpDrawerOpen;
  q('[data-dialog-backdrop]').hidden = !(approvalDialogOpen || commandMenuOpen || helpDrawerOpen);
  q('.app-frame').toggleAttribute('inert', approvalDialogOpen || commandMenuOpen || helpDrawerOpen);
  document.body.dataset.help = helpDrawerOpen ? 'open' : 'closed';
}

function setPrimaryView(view, { moveFocus = false } = {}) {
  if (!['topology', 'live', 'evidence', 'approvals', 'audit'].includes(view)) return;
  primaryView = view;
  if (view === 'evidence') setPanel('evidence');
  if (view === 'audit') setPanel('audit');
  if (helpDrawerOpen) closeHelpDrawer({ restoreFocus: false });
  renderPrimaryView();
  if (moveFocus) {
    const target = view === 'live'
      ? q('[data-universal-view]')
      : view === 'approvals'
        ? q('[data-approvals-view]')
        : view === 'evidence' || view === 'audit'
          ? q('.evidence-panel')
          : q('[data-walkthrough-view]');
    schedule(0, () => target?.focus({ preventScroll: true }));
  }
}

function setPanel(panelName) {
  document.body.dataset.inspectorPanel = panelName;
  for (const button of qa('[data-panel-tab]')) {
    const selected = button.dataset.panelTab === panelName;
    button.classList.toggle('active', selected);
    button.setAttribute('aria-selected', String(selected));
    button.tabIndex = selected ? 0 : -1;
  }
  for (const panel of qa('[data-panel-content]')) panel.hidden = panel.dataset.panelContent !== panelName;
  const headings = { evidence: 'Evidence', mapping: 'Capability mapping', audit: 'Audit trail' };
  q('[data-panel-heading]').textContent = headings[panelName] ?? 'Evidence';
}

function handleAction(action, source, { trusted = false } = {}) {
  switch (action) {
    case 'guided-tour': startGuidedTour(); break;
    case 'toggle-guidance': toggleGuidance(); break;
    case 'start-mission': advanceMission(); break;
    case 'select-mission': selectMissionProfile(source?.dataset.missionId); break;
    case 'choose-mission': void chooseMission(); break;
    case 'reset': resetMission(); break;
    case 'swap-provider': swapProvider(); break;
    case 'review-approval':
      if (activeProfile.completion !== 'mutations') setPrimaryView('audit', { moveFocus: true });
      else if (state.phase === PHASE.COMPLETE) setPrimaryView('audit', { moveFocus: true });
      else openApprovalDialog();
      break;
    case 'close-approval': closeOverlays(); break;
    case 'close-help': closeHelpDrawer(); break;
    case 'approve-apply':
      if (trusted) approveScope('apply');
      else showToast('Human interaction required', 'Approval creation rejects synthetic DOM activation.', 'warning');
      break;
    case 'approve-publish':
      if (trusted) approveScope('publish');
      else showToast('Human interaction required', 'Approval creation rejects synthetic DOM activation.', 'warning');
      break;
    case 'execute-approved': executeApproved(); break;
    case 'inspect-mutation': {
      const target = source?.dataset.nodeTarget;
      const nodeId = target === 'apply-recovery' ? applyNodeId : publishNodeId;
      if (state.phase !== PHASE.IDLE) selectGraphNode(nodeId);
      if ([PHASE.REVIEW, PHASE.APPROVED].includes(state.phase)) openApprovalDialog();
      break;
    }
    case 'open-command':
      if (commandMenuOpen) {
        closeOverlays();
      } else {
        overlayReturnFocus = document.activeElement;
        approvalDialogOpen = false;
        commandMenuOpen = true;
        q('[data-command-input]').value = '';
        qa('[data-command-menu] [data-action]').forEach((button) => { button.hidden = false; });
        renderApprovals();
        schedule(0, () => q('[data-command-input]')?.focus());
      }
      break;
    case 'zoom-in': graphZoom = Math.min(1.25, graphZoom + .08); renderConstellation(); q('[data-zoom-level]').textContent = `${Math.round(graphZoom * 100)}%`; break;
    case 'zoom-out': graphZoom = Math.max(.78, graphZoom - .08); renderConstellation(); q('[data-zoom-level]').textContent = `${Math.round(graphZoom * 100)}%`; break;
    case 'fit-graph': graphZoom = 1; renderConstellation(); q('[data-zoom-level]').textContent = '100%'; break;
    case 'copy-origin': void copySelectedOrigin(); break;
    case 'open-audit': setPrimaryView('audit', { moveFocus: true }); break;
    case 'edit-objective': beginObjectiveEditing(); break;
    case 'save-objective': saveObjectiveEditing(); break;
    case 'cancel-objective': cancelObjectiveEditing(); break;
    case 'sidepanel-guide': {
      const entry = q('[data-universal-entry]');
      const instructions = q('details', entry);
      instructions.open = true;
      schedule(0, () => entry.focus({ preventScroll: true }));
      showToast('Continue in the Chrome side panel', 'Open ToolBraid from Chrome on the live page you want to work with.', 'info');
      break;
    }
    default: break;
  }
}

function beginObjectiveEditing() {
  if (state.phase !== PHASE.IDLE) return;
  editingObjective = true;
  const input = q('[data-objective-input]');
  input.value = objective;
  renderMissionBrief();
  schedule(0, () => { input.focus(); input.select(); });
}

function saveObjectiveEditing() {
  if (!editingObjective || state.phase !== PHASE.IDLE) return;
  const input = q('[data-objective-input]');
  const next = input.value.trim();
  if (!next) {
    showToast('Objective cannot be empty', 'Describe the outcome and authority boundary before starting.', 'warning');
    input.focus();
    return;
  }
  objective = next;
  editingObjective = false;
  state = createState(objective);
  render();
  schedule(0, () => q('[data-action="edit-objective"]')?.focus());
}

function cancelObjectiveEditing() {
  if (!editingObjective) return;
  editingObjective = false;
  q('[data-objective-input]').value = objective;
  renderMissionBrief();
  schedule(0, () => q('[data-action="edit-objective"]')?.focus());
}

document.addEventListener('click', (event) => {
  const actionTarget = event.target.closest('[data-action]');
  if (actionTarget) {
    if (actionTarget.closest('[data-command-menu]')) {
      if (actionTarget.dataset.action === 'review-approval') {
        commandMenuOpen = false;
        renderApprovals();
      } else {
        closeOverlays();
      }
    }
    handleAction(actionTarget.dataset.action, actionTarget, { trusted: event.isTrusted });
    return;
  }
  const tab = event.target.closest('[data-panel-tab]');
  if (tab) {
    setPanel(tab.dataset.panelTab);
    return;
  }
  const rail = event.target.closest('[data-view]');
  if (rail) {
    if (rail.dataset.view === 'help') openHelpDrawer();
    else setPrimaryView(rail.dataset.view, { moveFocus: true });
    return;
  }
  const graphNode = event.target.closest('[data-node-id]');
  if (graphNode) selectGraphNode(graphNode.dataset.nodeId);
  if (event.target.matches('[data-dialog-backdrop]')) closeOverlays();
});

document.addEventListener('keydown', (event) => {
  const activeOverlay = approvalDialogOpen
    ? q('[data-approval-dialog]')
    : commandMenuOpen
      ? q('[data-command-menu]')
      : helpDrawerOpen
        ? q('[data-help-drawer]')
        : null;
  if (activeOverlay && event.key === 'Tab') {
    const targets = visibleFocusTargets(activeOverlay);
    if (!targets.length) {
      event.preventDefault();
      activeOverlay.focus();
      return;
    }
    const first = targets[0];
    const last = targets.at(-1);
    if (event.shiftKey && (document.activeElement === first || !activeOverlay.contains(document.activeElement))) {
      event.preventDefault();
      last.focus();
      return;
    }
    if (!event.shiftKey && (document.activeElement === last || !activeOverlay.contains(document.activeElement))) {
      event.preventDefault();
      first.focus();
      return;
    }
  }

  const panelTab = event.target.closest?.('[data-panel-tab]');
  if (panelTab && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
    event.preventDefault();
    const tabs = qa('[data-panel-tab]');
    const currentIndex = tabs.indexOf(panelTab);
    const nextIndex = event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? tabs.length - 1
        : (currentIndex + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    const next = tabs[nextIndex];
    setPanel(next.dataset.panelTab);
    next.focus();
    return;
  }

  const commandInput = event.target.closest?.('[data-command-input]');
  if (commandInput && ['ArrowDown', 'Enter'].includes(event.key)) {
    const firstCommand = qa('[data-command-menu] [data-action]').find((button) => !button.hidden && !button.disabled);
    if (firstCommand) {
      event.preventDefault();
      if (event.key === 'Enter') firstCommand.click();
      else firstCommand.focus();
    }
    return;
  }

  const graphNode = event.target.closest?.('[data-node-id]');
  if (graphNode && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
    event.preventDefault();
    const nodes = qa('[data-node-id]', q('[data-constellation]'));
    const currentIndex = nodes.indexOf(graphNode);
    const nextIndex = event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? nodes.length - 1
        : (currentIndex + (['ArrowRight', 'ArrowDown'].includes(event.key) ? 1 : -1) + nodes.length) % nodes.length;
    const nextNodeId = nodes[nextIndex].dataset.nodeId;
    selectGraphNode(nextNodeId);
    focusGraphNode(nextNodeId);
    return;
  }
  if (graphNode && (event.key === 'Enter' || event.key === ' ')) {
    event.preventDefault();
    selectGraphNode(graphNode.dataset.nodeId);
    return;
  }
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    handleAction('open-command');
  }
  const typing = event.target.matches?.('input, textarea, select, [contenteditable="true"]');
  if (!typing && !activeOverlay && !event.metaKey && !event.ctrlKey && !event.altKey) {
    if (event.key.toLowerCase() === 'g') {
      event.preventDefault();
      startGuidedTour();
    }
    if (event.key.toLowerCase() === 'm') {
      event.preventDefault();
      void chooseMission();
    }
  }
  if (event.key === 'Escape' && editingObjective && !activeOverlay) cancelObjectiveEditing();
  else if (event.key === 'Escape') closeOverlays();
});

document.addEventListener('input', (event) => {
  if (!event.target.matches?.('[data-command-input]')) return;
  const query = event.target.value.trim().toLowerCase();
  for (const button of qa('[data-command-menu] [data-action]')) {
    button.hidden = Boolean(query) && !button.textContent.toLowerCase().includes(query);
  }
});

function installReactiveLens() {
  const stage = q('.topology-stage');
  if (!stage || prefersReducedMotion.matches || window.matchMedia('(pointer: coarse)').matches) return;
  let frame = null;
  let nextXBand = 4;
  let nextYBand = 2;

  stage.addEventListener('pointermove', (event) => {
    const bounds = stage.getBoundingClientRect();
    const normalizedX = Math.max(0, Math.min(0.999, (event.clientX - bounds.left) / bounds.width));
    const normalizedY = Math.max(0, Math.min(0.999, (event.clientY - bounds.top) / bounds.height));
    nextXBand = Math.floor(normalizedX * 9);
    nextYBand = Math.floor(normalizedY * 6);
    if (frame !== null) return;
    frame = window.requestAnimationFrame(() => {
      stage.dataset.lensX = String(nextXBand);
      stage.dataset.lensY = String(nextYBand);
      stage.dataset.pointerActive = 'true';
      frame = null;
    });
  }, { passive: true });

  stage.addEventListener('pointerleave', () => {
    stage.dataset.pointerActive = 'false';
  }, { passive: true });
}

window.setInterval(() => {
  if (missionStartedAt) q('[data-mission-clock]').textContent = formatMissionTime(missionCompletedIn ?? (Date.now() - missionStartedAt));
}, 1000);

window.__TOOLBRAID_V2__ = Object.freeze({
  getState: () => state,
  getEngineSnapshot: () => missionController.snapshot(),
  getMissionProfile: () => activeProfile,
  start: advanceMission,
  runSafeReads: safeReadSequence,
  swapProvider,
  executeApproved,
  startGuidedTour,
  selectMission: selectMissionProfile,
  reset: resetMission,
});

const unsubscribeMissionController = missionController.subscribe(handleControllerEvent);
window.addEventListener('pagehide', () => {
  unsubscribeMissionController();
  missionController.dispose();
}, { once: true });
hydrateIcons();
installReactiveLens();
render();
