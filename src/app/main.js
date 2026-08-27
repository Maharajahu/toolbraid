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
  RECOVERY_CAPABILITIES,
  RECOVERY_CAPABILITY_IDS as CAPABILITY_ID,
} from '../packs/recovery/ontology.js';
import {
  RECOVERY_PROVIDER_DESCRIPTORS,
  RECOVERY_PROVIDER_ORIGINS,
} from '../providers/recovery/catalog.js';

const DEFAULT_OBJECTIVE = 'Diagnose checkout after the latest deployment, prepare a safe recovery and a customer update. Do not change production or publish without my approval.';

const PROVIDERS = Object.freeze(RECOVERY_PROVIDER_DESCRIPTORS.map(({ origin, label }) => ({ origin, label })));

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
  'capability.mapped': 'Capability mapped',
  'plan.created': 'Recovery plan created',
  'node.started': 'Plan node started',
  'tool.execution_started': 'Tool execution started',
  'tool.execution_failed': 'Tool execution failed closed',
  'tool.failover_selected': 'Compatible fallback selected',
  'node.completed': 'Plan node completed',
  'node.failed': 'Plan node failed',
  'plan.mutations_finalized': 'Exact mutation arguments finalized',
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
  hub: { id: 'toolbraid', label: 'Recovery plan', subtitle: 'Canonical capabilities' },
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

function createState(objective = DEFAULT_OBJECTIVE) {
  return createMissionState({
    missionId: 'checkout-production-recovery',
    objective,
    nodes: baseLayout.nodes.map((node) => ({
      id: node.id,
      label: node.label,
      semanticId: node.semanticId,
      type: node.type,
      trackProgress: (node.type === 'capability' && node.id !== unsafeNodeId) || node.type === 'mutation',
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
    metadata: { pack: 'toolbraid.production-recovery', visual: 'radial-provider-constellation' },
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
let objective = DEFAULT_OBJECTIVE;
let missionStartedAt = null;
let missionCompletedIn = null;
let graphZoom = 1;
let mobileGraphCentered = false;
let approvalDialogOpen = false;
let commandMenuOpen = false;
let overlayReturnFocus = null;
let editingObjective = false;
let providerSwapRequested = false;
let guidedTourActive = false;
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
  if (providerRuntimePromise) return providerRuntimePromise;
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
      frame.src = `${origin}/?orchestrator=${encodeURIComponent(window.location.origin)}`;
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
    if (event === 'plan.created' && state.phase === PHASE.DISCOVERING) {
      syncControllerSnapshot();
      dispatch({ type: EVENT.DISCOVERY_COMPLETED });
      dispatch({
        type: EVENT.MAPPING_COMPLETED,
        mappings: runtimeMappings,
        activeEdgeIds: providerCapabilityEdgeIds,
      });
      return;
    }
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

  if (bridgeMode === 'safe') {
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
  const activeEdges = new Set(state.phase === PHASE.COMPLETE ? [] : selectActiveEdgeIds(state));
  const nodeStates = new Map(baseLayout.nodes.map((node) => [node.id, visualStateForNode(node)]));
  return {
    width: baseLayout.width,
    height: baseLayout.height,
    centerX: baseLayout.center.x,
    centerY: baseLayout.center.y,
    outerRadius: baseLayout.radii.outer,
    innerRadius: baseLayout.radii.inner,
    providers: PROVIDERS.map((provider) => {
      const node = nodeBySemantic(provider.origin, 'provider');
      let visualState = nodeStates.get(node.id);
      if (provider.origin === 'https://signals.toolbraid.dev'
        && (semanticNodeState('service.health.read') === NODE_STATUS.FAILED || providerSwapRequested)) visualState = 'idle';
      if (provider.origin === 'https://pulse.toolbraid.dev' && providerSwapRequested) {
        visualState = semanticNodeState('service.health.read') === NODE_STATUS.COMPLETED ? 'complete' : 'active';
      }
      return { ...provider, state: visualState };
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
  const pulseProviderId = nodeBySemantic('https://pulse.toolbraid.dev', 'provider').id;

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
  if (['runtime.ready', 'mission.started', 'tool.discovered', 'tool.quarantined'].includes(entry.event)) return 'discover';
  if (['capability.mapped', 'plan.created'].includes(entry.event)) return 'normalize';
  if (entry.event.startsWith('approval.')) return 'authorize';
  if (entry.event === 'mission.completed') return 'execute';
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
    case 'approval.created':
      return `${details.scope ?? 'scope'} · ${details.origin ?? 'origin'} · ${details.tool ?? 'tool'} · ${details.fingerprint?.slice(0, 12) ?? '—'}…`;
    case 'approval.claimed':
      return `${details.nodeId ?? 'mutation'} · nonce ${details.nonce ?? '—'} · single use`;
    case 'mission.completed':
      return `${details.resultNodeIds?.length ?? 0} approved mutation receipts recorded before sealing.`;
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
    const approved = Number(state.approvals.apply.granted) + Number(state.approvals.publish.granted);
    return `${approved} / 2 exact scopes approved`;
  }
  if (phaseId === 'execute') return `${state.execution.completedNodeIds.length} / 2 mutation receipts`;
  return `${entries.length} lifecycle ${entries.length === 1 ? 'event' : 'events'}`;
}

function renderHeader() {
  document.body.dataset.phase = state.phase;
  document.body.dataset.guided = guidedTourActive ? 'active' : 'idle';
  document.body.dataset.runtime = controllerSnapshot.mode;
  qa('[data-phase-label]').forEach((element) => { element.textContent = PHASE_COPY[state.phase]; });
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
    const stepState = state.phase === PHASE.COMPLETE || index < phaseIndex
      ? 'complete'
      : index === phaseIndex
        ? 'active'
        : 'pending';
    step.dataset.state = stepState;
    step.toggleAttribute('aria-current', stepState === 'active');
  });
}

function renderGuidedControl() {
  const control = q('[data-action="guided-tour"]', q('.stage-tools'));
  if (!control) return;
  control.hidden = false;
  const icon = q('[data-guided-icon]', control);
  const label = q('[data-guided-label]', control);
  if (!icon || !label) return;

  let iconName = 'play';
  let copy = 'Guided preview';
  if (guidedTourActive) {
    iconName = 'pause';
    copy = 'Pause guidance';
  } else if (state.phase === PHASE.COMPLETE) {
    iconName = 'reset';
    copy = 'Replay mission';
  } else if ([PHASE.REVIEW, PHASE.APPROVED].includes(state.phase)) {
    iconName = 'lock';
    copy = 'Human checkpoint';
  }
  icon.innerHTML = iconMarkup(iconName);
  label.textContent = copy;
  control.setAttribute('aria-pressed', String(guidedTourActive));
}

function renderMissionBrief() {
  const copy = q('[data-objective-copy]');
  const complete = state.phase === PHASE.COMPLETE;
  const applyReceipt = controllerSnapshot.results['apply-recovery-option'];
  const publishReceipt = controllerSnapshot.results['publish-status-update'];
  q('[data-mission-kicker]').textContent = complete ? 'Verified outcome' : 'Human objective';
  q('[data-mission-title]').textContent = complete ? 'Checkout restored' : 'Restore checkout safely';
  q('[data-constraint="environment"]').textContent = complete ? formatMissionTime(missionCompletedIn ?? 0) : 'Production';
  q('[data-constraint="mode"]').textContent = complete
    ? `${new Set(runtimeTools.map(({ origin }) => origin)).size} origins consulted`
    : 'Read first';
  q('[data-constraint="authority"]').textContent = complete ? '2 explicit approvals' : 'Exact approval';
  if (!editingObjective) {
    copy.textContent = complete
      ? `${applyReceipt?.activeReleaseId ?? 'Verified release'} restored; ${publishReceipt?.noticeRevision ?? 'customer update'} published; audit chain sealed.`
      : objective;
  }
  const button = q('[data-action="start-mission"]', q('[data-mission-brief]'));
  const label = q('[data-start-label]');
  const icon = q('[data-start-icon]', button);
  const editButton = q('[data-action="edit-objective"]');
  const mappingsReady = Object.keys(state.mappings).length === mappableNodeIds.length;
  if (state.phase === PHASE.IDLE) {
    label.textContent = 'Start mission';
    button.disabled = false;
  } else if (state.phase === PHASE.MAPPING && mappingsReady) {
    label.textContent = 'Run 4 safe reads';
    button.disabled = false;
  } else if (state.phase === PHASE.REVIEW || state.phase === PHASE.APPROVED) {
    label.textContent = 'Review approvals';
    button.disabled = false;
  } else if (complete) {
    label.textContent = 'Verified · audit sealed';
    button.disabled = true;
  } else {
    label.textContent = PHASE_COPY[state.phase];
    button.disabled = true;
  }
  icon.innerHTML = complete ? iconMarkup('check') : '→';
  editButton.hidden = complete;
  editButton.textContent = editingObjective ? 'Save' : 'Edit';
  editButton.disabled = state.phase !== PHASE.IDLE;
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
  swapButton.hidden = providerSwapRequested;
  swapStatus.hidden = !providerSwapRequested;
  swapButton.dataset.ready = healthFailed ? 'true' : 'false';
  swapButton.disabled = !healthFailed;
  swapButton.innerHTML = healthFailed
    ? `Automatic fallback ready <span>${iconMarkup('swap')}</span>`
    : `Fallback armed <span>${iconMarkup('swap')}</span>`;
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
    title: 'ToolBraid production recovery provider constellation',
    description: 'Independent WebMCP provider origins map to canonical recovery capabilities. Active edges pulse only while their real mission event is running.',
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
  if (!mobileGraphCentered && window.matchMedia('(max-width: 680px)').matches) {
    mobileGraphCentered = true;
    schedule(0, () => {
      const viewport = q('[data-constellation-viewport]');
      const hub = q('[data-node-type="hub"]', mount);
      const viewportRect = viewport.getBoundingClientRect();
      const hubRect = hub?.getBoundingClientRect();
      const hubCenter = hubRect
        ? viewport.scrollLeft + hubRect.left + (hubRect.width / 2) - viewportRect.left
        : viewport.scrollWidth / 2;
      viewport.scrollLeft = Math.max(0, hubCenter - (viewport.clientWidth / 2));
    });
  }
}

function renderReads() {
  let complete = 0;
  for (const semanticId of readSemanticIds) {
    const row = q(`[data-read="${semanticId.split('.')[0] === 'service' ? 'health' : semanticId.split('.')[0] === 'release' ? 'release' : semanticId.split('.')[0] === 'deployment' ? 'deployment' : 'notice'}"]`);
    const info = readUi[semanticId];
    row.dataset.state = info.state;
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
    if (providerSwapRequested && node.origin === 'https://pulse.toolbraid.dev') {
      return 'Selected compatible read-only fallback. Pulse Monitor completed the health read without changing the recovery plan.';
    }
    if (providerSwapRequested && node.origin === 'https://signals.toolbraid.dev') {
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

  const signal = q('[data-signal-card]');
  signal.classList.toggle('quarantine', Boolean(quarantined));
  signal.classList.toggle('clean', !quarantined);
  q('[data-signal-icon]').innerHTML = iconMarkup(quarantined ? 'quarantine' : 'shield');
  q('[data-signal-status]').textContent = quarantined ? 'Quarantined before planning' : state.phase === PHASE.IDLE ? 'Awaiting discovery' : 'Metadata clean';
  q('[data-signal-count]').textContent = quarantined ? '3 signals' : '0 signals';

  const evidence = evidenceForNode(node);
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
  const applyApproved = state.approvals.apply.granted;
  const publishApproved = state.approvals.publish.granted;
  const complete = state.phase === PHASE.COMPLETE;
  const applyPlan = controllerSnapshot.plan?.nodes.find(({ id }) => id === 'apply-recovery-option');
  const publishPlan = controllerSnapshot.plan?.nodes.find(({ id }) => id === 'publish-status-update');
  const applyReceipt = controllerSnapshot.results['apply-recovery-option'];
  const publishReceipt = controllerSnapshot.results['publish-status-update'];
  const pendingApprovals = Number(!applyApproved) + Number(!publishApproved);
  q('[data-approval-count]').textContent = String(pendingApprovals);
  q('[data-approval-count]').hidden = pendingApprovals === 0;

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
      ? 'Execute approved <span>→</span>'
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
  q('[data-review-apply-origin]').textContent = applyPlan?.mapping?.origin ?? 'Awaiting mapping';
  q('[data-review-apply-tool]').textContent = applyPlan?.mapping?.name ?? '—';
  q('[data-review-apply-effect]').textContent = applyPlan?.effectSummary ?? 'Awaiting verified evidence';
  q('[data-review-apply-arguments]').textContent = JSON.stringify(applyPlan?.arguments ?? {}, null, 2);
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
  approveApply.textContent = applyApproved ? 'Approved ✓' : 'Approve apply recovery';
  approvePublish.textContent = publishApproved ? 'Approved ✓' : 'Approve publish update';
  q('[data-approval-summary]').textContent = `${Number(applyApproved) + Number(publishApproved)} of 2 approved`;
  q('[data-action="execute-approved"]').disabled = state.phase !== PHASE.APPROVED || operationRunning;

  q('[data-approval-dialog]').hidden = !approvalDialogOpen;
  q('[data-dialog-backdrop]').hidden = !(approvalDialogOpen || commandMenuOpen);
  q('[data-command-menu]').hidden = !commandMenuOpen;
  q('.app-frame').toggleAttribute('inert', approvalDialogOpen || commandMenuOpen);
}

function render() {
  renderHeader();
  renderTrajectory();
  renderGuidedControl();
  renderMissionBrief();
  renderProviderLegend();
  renderConstellation();
  renderReads();
  renderInspector();
  renderApprovals();
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
  renderHeader();
  bridgeMode = 'discovery';
  missionStartedAt = Date.now();
  providerSwapRequested = false;
  showToast('Connecting provider runtime', 'Loading the explicitly allowed WebMCP origins.', 'info');
  try {
    await ensureProviderRuntime();
    const snapshot = await missionController.discoverAndPlan(objective);
    if (epoch !== missionEpoch) return;
    syncControllerSnapshot(snapshot);
    if (state.phase !== PHASE.MAPPING) throw new Error('The real discovery stream did not produce a complete capability map.');
    showToast('Capabilities normalized', `${runtimeMappings ? Object.keys(runtimeMappings).length : 0} capabilities are bound to live tool contracts.`, 'success');
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
    const snapshot = await missionController.runSafe();
    if (epoch !== missionEpoch) return;
    syncControllerSnapshot(snapshot);
    if (state.phase !== PHASE.REVIEW) throw new Error('Safe execution stopped before exact mutation arguments were finalized.');
    showToast('Recovery prepared', 'Real evidence converged; both external effects remain locked for exact approval.', 'success');
    if (guidedTourActive) {
      clearGuidedWork();
      guidedTourActive = false;
      showToast('Human checkpoint reached', 'Guidance stopped. Review and approve each external effect separately.', 'warning');
    }
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

function swapProvider() {
  showToast(
    providerSwapRequested ? 'Fallback verified' : 'Fallback armed',
    providerSwapRequested
      ? 'The engine already substituted the compatible read-only provider and recorded both identities.'
      : 'Read-only failover runs automatically after a primary provider fails closed.',
    providerSwapRequested ? 'success' : 'info',
  );
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
  const wasOpen = approvalDialogOpen || commandMenuOpen;
  const returnTarget = overlayReturnFocus;
  approvalDialogOpen = false;
  commandMenuOpen = false;
  overlayReturnFocus = null;
  renderApprovals();
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
  renderHeader();
  bridgeMode = 'approval';
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
  render();
  if (announce) showToast('Guidance paused', 'The mission remains interactive at its current checkpoint.', 'info');
}

async function startGuidedTour() {
  if (guidedTourActive) {
    stopGuidedTour();
    return;
  }
  if ([PHASE.REVIEW, PHASE.APPROVED].includes(state.phase)) {
    openApprovalDialog();
    return;
  }
  if (state.phase !== PHASE.IDLE) await resetMission();
  if (state.phase !== PHASE.IDLE || operationRunning) return;

  guidedTourActive = true;
  commandMenuOpen = false;
  render();
  showToast('Guided mission started', 'ToolBraid will run real discovery and safe evidence reads, then stop for human authority.', 'info');
  await discoverySequence();
  if (guidedTourActive && state.phase === PHASE.MAPPING) await safeReadSequence();
  if (guidedTourActive) {
    guidedTourActive = false;
    render();
    if (state.phase === PHASE.REVIEW) {
      showToast('Human checkpoint reached', 'Guidance stopped. Review and approve each external effect separately.', 'warning');
    }
  }
}

async function resetMission() {
  if (operationRunning) {
    showToast('Mission is still running', 'Reset is locked until the active operation settles and its receipts are recorded.', 'warning');
    return false;
  }
  missionEpoch += 1;
  bridgeMode = 'idle';
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
  mobileGraphCentered = false;
  providerSwapRequested = false;
  auditSealHash = null;
  guidedTourActive = false;
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
    case 'start-mission':
      if (state.phase === PHASE.IDLE) discoverySequence();
      else if (state.phase === PHASE.MAPPING) safeReadSequence();
      else if ([PHASE.REVIEW, PHASE.APPROVED].includes(state.phase)) openApprovalDialog();
      break;
    case 'reset': resetMission(); break;
    case 'swap-provider': swapProvider(); break;
    case 'review-approval':
      if (state.phase === PHASE.COMPLETE) setPanel('audit');
      else if (state.phase === PHASE.APPROVED && source?.closest('[data-approval-dock]')) executeApproved();
      else openApprovalDialog();
      break;
    case 'close-approval': closeOverlays(); break;
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
    case 'copy-origin': {
      const value = q('[data-origin-value]').textContent;
      navigator.clipboard?.writeText(value);
      showToast('Origin copied', value, 'info');
      break;
    }
    case 'open-audit': setPanel('audit'); break;
    case 'edit-objective': toggleObjectiveEditing(); break;
    default: break;
  }
}

function toggleObjectiveEditing() {
  if (state.phase !== PHASE.IDLE) return;
  const copy = q('[data-objective-copy]');
  if (!editingObjective) {
    editingObjective = true;
    copy.contentEditable = 'true';
    copy.setAttribute('role', 'textbox');
    copy.setAttribute('aria-label', 'Mission objective');
    copy.focus();
    document.execCommand?.('selectAll', false, null);
  } else {
    const next = copy.textContent.trim();
    if (next) objective = next;
    copy.contentEditable = 'false';
    copy.removeAttribute('role');
    copy.removeAttribute('aria-label');
    editingObjective = false;
    state = createState(objective);
    render();
  }
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
    qa('[data-view]').forEach((button) => {
      const active = button === rail;
      button.classList.toggle('active', active);
      button.toggleAttribute('aria-current', active);
    });
    if (rail.dataset.view === 'evidence') setPanel('evidence');
    if (rail.dataset.view === 'audit') setPanel('audit');
    if (rail.dataset.view === 'approvals') openApprovalDialog();
    if (rail.dataset.view === 'help') showToast('Mission controls', 'Select nodes to inspect. Pulses show only the currently active causal path.', 'info');
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
  if (event.key === 'Escape') closeOverlays();
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
  start: discoverySequence,
  runSafeReads: safeReadSequence,
  swapProvider,
  executeApproved,
  startGuidedTour,
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
