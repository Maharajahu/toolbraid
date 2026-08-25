import { AuditLog } from './core/audit.js';
import { extractMission } from './core/intent.js';
import { normalizeTools } from './core/normalizer.js';
import { approvePlanActions, buildTripPlan, planProgress } from './core/planner.js';
import { riskLabel } from './core/risk.js';
import { runPlanUntilBlocked } from './core/executor.js';
import { createWebMcpRuntime } from './core/webmcp-runtime.js';

const runtime = createWebMcpRuntime();
const audit = new AuditLog();

const state = {
  phase: 'booting',
  providers: new Map(),
  tools: [],
  mappings: [],
  mission: null,
  plan: null,
  results: new Map(),
  humanApproval: null,
  runtimeMode: runtime.mode,
  lastError: null,
};

const elements = {
  runtimeLabel: document.querySelector('[data-runtime-label]'),
  providerCount: document.querySelector('[data-provider-count]'),
  toolCount: document.querySelector('[data-tool-count]'),
  goal: document.querySelector('[data-field="goal"]'),
  origin: document.querySelector('[data-field="origin"]'),
  destination: document.querySelector('[data-field="destination"]'),
  destinationAddress: document.querySelector('[data-field="destinationAddress"]'),
  date: document.querySelector('[data-field="date"]'),
  budget: document.querySelector('[data-field="budget"]'),
  planButton: document.querySelector('[data-action="plan"]'),
  safeButton: document.querySelector('[data-action="run-safe"]'),
  approvedButton: document.querySelector('[data-action="run-approved"]'),
  phaseChip: document.querySelector('[data-phase-chip]'),
  phaseLabel: document.querySelector('[data-phase-label]'),
  progressCopy: document.querySelector('[data-progress-copy]'),
  progressPercent: document.querySelector('[data-progress-percent]'),
  progressBar: document.querySelector('[data-progress-bar]'),
  emptyGraph: document.querySelector('[data-empty-graph]'),
  graph: document.querySelector('[data-graph]'),
  recommendation: document.querySelector('[data-recommendation]'),
  recommendationTotal: document.querySelector('[data-recommendation-total]'),
  recommendationRail: document.querySelector('[data-recommendation-rail]'),
  recommendationTimes: document.querySelector('[data-recommendation-times]'),
  recommendationStay: document.querySelector('[data-recommendation-stay]'),
  recommendationAddress: document.querySelector('[data-recommendation-address]'),
  recommendationWalk: document.querySelector('[data-recommendation-walk]'),
  recommendationDistance: document.querySelector('[data-recommendation-distance]'),
  recommendationSavings: document.querySelector('[data-recommendation-savings]'),
  completion: document.querySelector('[data-completion]'),
  completionCopy: document.querySelector('[data-completion-copy]'),
  mappingsEmpty: document.querySelector('[data-mappings-empty]'),
  mappingList: document.querySelector('[data-mapping-list]'),
  auditList: document.querySelector('[data-audit-list]'),
  stateView: document.querySelector('[data-state-view]'),
  approvalBackdrop: document.querySelector('[data-approval-backdrop]'),
  approvalDrawer: document.querySelector('[data-approval-drawer]'),
  approvalActions: document.querySelector('[data-approval-actions]'),
  approvedActionbar: document.querySelector('[data-approved-actionbar]'),
  toastRegion: document.querySelector('[data-toast-region]'),
  metrics: {
    capabilities: document.querySelector('[data-metric="capabilities"]'),
    quarantined: document.querySelector('[data-metric="quarantined"]'),
    approvals: document.querySelector('[data-metric="approvals"]'),
  },
};

const PROVIDER_LABELS = Object.freeze({
  vectorrail: 'VectorRail',
  nestsquare: 'NestSquare',
  walkmesh: 'WalkMesh',
  mirage: 'Mirage Deals',
});

const PHASE_LABELS = Object.freeze({
  booting: 'Connecting provider sites',
  idle: 'Ready for mission',
  planned: 'Plan ready',
  running: 'Executing safe steps',
  approval_required: 'Human approval required',
  approved: 'Actions approved',
  completed: 'Mission staged',
  failed: 'Execution failed',
});

const NODE_CLASSES = Object.freeze({
  'travel-search': 'node-travel',
  'stay-search': 'node-stay',
  'candidate-weave': 'node-candidate',
  'access-check': 'node-access',
  recommendation: 'node-recommendation',
  'travel-hold': 'node-travel-hold',
  'stay-hold': 'node-stay-hold',
});

function tomorrowIso() {
  const date = new Date();
  date.setDate(date.getDate() + 1);
  return date.toISOString().slice(0, 10);
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[<>&"']/g, (char) => ({
    '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#039;',
  })[char]);
}

function providerKey(toolName) {
  return String(toolName ?? '').split('.')[0].toLowerCase();
}

function providerLabel(toolName) {
  const key = providerKey(toolName);
  return state.providers.get(key)?.label ?? PROVIDER_LABELS[key] ?? (key || 'Unknown provider');
}

function currency(value) {
  return new Intl.NumberFormat('en-GB', { style: 'currency', currency: state.mission?.currency ?? 'GBP' }).format(Number(value ?? 0));
}

function readForm() {
  return {
    goal: elements.goal.value.trim(),
    origin: elements.origin.value.trim(),
    destination: elements.destination.value.trim(),
    destinationAddress: elements.destinationAddress.value.trim(),
    date: elements.date.value,
    budget: Number(elements.budget.value),
    passengers: 1,
    nights: 1,
    currency: 'GBP',
  };
}

function writeMissionToForm(mission) {
  if (!mission) return;
  elements.goal.value = mission.goal;
  elements.origin.value = mission.origin;
  elements.destination.value = mission.destination;
  elements.destinationAddress.value = mission.destinationAddress;
  elements.date.value = mission.date;
  elements.budget.value = String(mission.budget);
}

function setProviderReady(key, details = {}) {
  const current = state.providers.get(key) ?? {};
  state.providers.set(key, {
    id: key,
    label: details.label ?? current.label ?? PROVIDER_LABELS[key] ?? key,
    mode: details.mode ?? current.mode ?? state.runtimeMode,
    tools: details.tools ?? current.tools ?? [],
    status: details.status ?? current.status ?? 'Ready',
  });
  const card = document.querySelector(`[data-provider-card="${CSS.escape(key)}"]`);
  const status = document.querySelector(`[data-provider-status="${CSS.escape(key)}"]`);
  card?.classList.add('ready');
  if (status) status.textContent = state.providers.get(key).status;
}

async function discoverTools({ recordAudit = true } = {}) {
  const allTools = await runtime.getTools({ fromOrigins: [location.origin] });
  const providerTools = allTools.filter((tool) => !tool.name.startsWith('toolbraid.'));
  state.tools = providerTools;

  const byProvider = new Map();
  for (const tool of providerTools) {
    const key = providerKey(tool.name);
    const names = byProvider.get(key) ?? [];
    names.push(tool.name);
    byProvider.set(key, names);
  }
  for (const [key, tools] of byProvider) {
    setProviderReady(key, { tools, status: key === 'mirage' ? 'Security fixture' : 'Ready' });
  }

  state.mappings = normalizeTools(providerTools);
  if (recordAudit) {
    audit.add('tools.discovered', {
      count: providerTools.length,
      providers: [...byProvider.keys()],
      tools: providerTools.map((tool) => tool.name),
    });
    const quarantined = state.mappings.filter((mapping) => mapping.quarantined);
    for (const mapping of quarantined) {
      audit.add('tool.quarantined', {
        tool: mapping.tool.name,
        reason: mapping.security.reason,
        matches: mapping.security.matches,
      });
    }
  }
  renderAll();
  return state.mappings;
}

function mergeMissionInput(input = {}) {
  const form = readForm();
  const constraints = input.constraints && typeof input.constraints === 'object' ? input.constraints : {};
  const overrides = {
    ...form,
    ...constraints,
    ...input,
    goal: undefined,
    constraints: undefined,
  };
  const goal = String(input.goal ?? form.goal);
  return extractMission(goal, overrides);
}

async function planMission(input = {}, source = 'human-ui') {
  try {
    state.lastError = null;
    state.phase = 'booting';
    state.humanApproval = null;
    state.results = new Map();
    state.plan = null;
    hideApproval();
    elements.approvedActionbar.hidden = true;
    elements.completion.hidden = true;
    renderAll();

    await discoverTools({ recordAudit: false });
    state.mission = mergeMissionInput(input);
    writeMissionToForm(state.mission);
    state.plan = buildTripPlan(state.mission, state.mappings);
    state.phase = 'planned';
    audit.add('mission.planned', {
      source,
      mission: state.mission,
      planId: state.plan.id,
      nodes: state.plan.nodes.map((node) => ({ id: node.id, capability: node.capabilityId ?? node.operation, approvalRequired: node.approvalRequired })),
    });
    toast('Capability plan created from six dynamically discovered provider tools.');
    renderAll();
    return publicSnapshot();
  } catch (error) {
    fail(error, 'Planning failed');
    throw error;
  }
}

function executionContext() {
  return {
    mission: state.mission,
    results: state.results,
    runtime,
    onNodeChange: () => renderAll(),
    onAudit: (event, details) => audit.add(event, details),
  };
}

async function runSafeSteps(source = 'human-ui') {
  try {
    if (!state.plan) await planMission({}, source);
    state.phase = 'running';
    audit.add('execution.safe_started', { source, planId: state.plan.id });
    renderAll();

    const result = await runPlanUntilBlocked(state.plan, executionContext(), { includeApproval: false });
    state.phase = result.status === 'approval_required' ? 'approval_required' : result.status;
    audit.add('execution.safe_completed', {
      source,
      executed: result.executed,
      status: result.status,
      approvalNodes: result.pendingApproval.map((node) => node.id),
    });
    renderAll();
    if (result.pendingApproval.length) showApproval();
    return publicSnapshot();
  } catch (error) {
    fail(error, 'Safe execution failed');
    throw error;
  }
}

function selectedApprovalNodeIds() {
  return [...elements.approvalActions.querySelectorAll('input[type="checkbox"]:checked')].map((input) => input.value);
}

function approveSelectedActions(source = 'human-ui') {
  if (!state.plan) return publicSnapshot();
  const pending = state.plan.nodes.filter((node) => node.approvalRequired && node.status === 'pending');
  const selected = selectedApprovalNodeIds();
  if (!selected.length) {
    toast('Select at least one reversible action to approve.', 'error');
    return publicSnapshot();
  }

  approvePlanActions(state.plan, selected);
  state.humanApproval = {
    source: 'human',
    channel: source,
    actionIds: [...selected],
    approvedAt: new Date().toISOString(),
  };
  state.phase = 'approved';
  audit.add('approval.recorded', {
    channel: source,
    actionIds: selected,
    policy: 'human-ui-only',
  });
  hideApproval();
  elements.approvedActionbar.hidden = false;
  elements.approvedButton.textContent = `Execute ${selected.length} approved action${selected.length === 1 ? '' : 's'}`;
  toast(`${selected.length} reversible action${selected.length === 1 ? '' : 's'} approved by a human.`);
  renderAll();
  return publicSnapshot();
}

async function runApprovedActions(source = 'human-ui') {
  try {
    const approvedNodes = state.plan?.nodes.filter((node) => node.approvalRequired && node.status === 'approved') ?? [];
    if (!state.plan || !state.humanApproval || !approvedNodes.length) {
      audit.add('execution.approved_blocked', { source, reason: 'No valid human approval record.' });
      state.phase = state.plan ? 'approval_required' : 'idle';
      renderAll();
      return { status: 'approval_required', ...publicSnapshot() };
    }

    const approvedSet = new Set(state.humanApproval.actionIds);
    if (approvedNodes.some((node) => !approvedSet.has(node.id))) {
      throw new Error('Approved plan state does not match the human approval record.');
    }

    state.phase = 'running';
    audit.add('execution.approved_started', { source, actionIds: approvedNodes.map((node) => node.id) });
    renderAll();
    const result = await runPlanUntilBlocked(state.plan, executionContext(), { includeApproval: true });
    state.phase = result.complete ? 'completed' : result.status;
    audit.add('execution.approved_completed', { source, executed: result.executed, status: result.status });
    elements.approvedActionbar.hidden = true;
    renderAll();
    if (result.complete) toast('Reversible holds created. No payment or final booking was made.');
    return publicSnapshot();
  } catch (error) {
    fail(error, 'Approved execution failed');
    throw error;
  }
}

function declineApproval() {
  if (!state.plan) return;
  for (const node of state.plan.nodes) {
    if (node.approvalRequired && node.status === 'approved') node.status = 'pending';
  }
  state.humanApproval = null;
  state.phase = 'approval_required';
  audit.add('approval.declined', { actionIds: state.plan.nodes.filter((node) => node.approvalRequired).map((node) => node.id) });
  hideApproval();
  elements.approvedActionbar.hidden = true;
  toast('External state changes were declined.');
  renderAll();
}

function resetMission() {
  state.phase = 'idle';
  state.mission = null;
  state.plan = null;
  state.results = new Map();
  state.humanApproval = null;
  state.lastError = null;
  audit.clear();
  hideApproval();
  elements.approvedActionbar.hidden = true;
  elements.completion.hidden = true;
  renderAll();
  toast('Mission reset. Provider capabilities remain connected.');
  return publicSnapshot();
}

function showApproval() {
  renderApprovalActions();
  elements.approvalBackdrop.hidden = false;
  elements.approvalDrawer.hidden = false;
  document.body.classList.add('drawer-open');
}

function hideApproval() {
  elements.approvalBackdrop.hidden = true;
  elements.approvalDrawer.hidden = true;
  document.body.classList.remove('drawer-open');
}

function phaseNodeIcon(status, approvalRequired) {
  if (status === 'completed') return '✓';
  if (status === 'running') return '••';
  if (status === 'failed') return '!';
  if (status === 'approved') return '✓';
  if (approvalRequired) return '⌁';
  return '○';
}

function renderHeaderAndMetrics() {
  elements.runtimeLabel.textContent = runtime.mode === 'native' ? 'WebMCP native runtime' : 'Standards-aligned test runtime';
  elements.providerCount.textContent = String(state.providers.size);
  elements.toolCount.textContent = String(state.tools.length);
  const capabilityCount = new Set(state.mappings.filter((mapping) => mapping.capability && !mapping.quarantined).map((mapping) => mapping.capability.id)).size;
  elements.metrics.capabilities.textContent = String(capabilityCount);
  elements.metrics.quarantined.textContent = String(state.mappings.filter((mapping) => mapping.quarantined).length);
  elements.metrics.approvals.textContent = String(state.plan?.nodes.filter((node) => node.approvalRequired).length ?? 0);

  elements.planButton.disabled = ['booting', 'running'].includes(state.phase);
  elements.safeButton.disabled = !state.plan || !['planned', 'approval_required'].includes(state.phase);
}

function renderPhase() {
  elements.phaseChip.dataset.phaseChip = state.phase;
  elements.phaseLabel.textContent = PHASE_LABELS[state.phase] ?? state.phase;
  if (!state.plan) {
    elements.progressCopy.textContent = state.phase === 'booting' ? 'Discovering live provider capabilities' : 'No plan created';
    elements.progressPercent.textContent = '0%';
    elements.progressBar.style.width = '0%';
    return;
  }
  const progress = planProgress(state.plan);
  elements.progressCopy.textContent = `${progress.completed} of ${progress.total} plan steps completed`;
  elements.progressPercent.textContent = `${progress.percent}%`;
  elements.progressBar.style.width = `${progress.percent}%`;
}

function renderGraph() {
  if (!state.plan) {
    elements.emptyGraph.hidden = false;
    elements.graph.hidden = true;
    elements.graph.innerHTML = '';
    return;
  }
  elements.emptyGraph.hidden = true;
  elements.graph.hidden = false;
  elements.graph.innerHTML = state.plan.nodes.map((node) => {
    const toolName = node.mapping?.tool?.name ?? `toolbraid.local.${node.operation}`;
    const semantic = node.capabilityId ?? node.operation;
    const risk = riskLabel(node.risk);
    return `
      <article class="graph-node ${escapeHtml(NODE_CLASSES[node.id] ?? '')} ${escapeHtml(node.status)}" data-node-id="${escapeHtml(node.id)}">
        <span class="node-status">${escapeHtml(phaseNodeIcon(node.status, node.approvalRequired))}</span>
        <div class="node-label">${escapeHtml(node.label)}</div>
        <div class="node-tool">${escapeHtml(toolName)}</div>
        <div class="node-tags">
          <span class="node-tag">${escapeHtml(semantic)}</span>
          <span class="node-tag">${escapeHtml(risk)}</span>
          ${node.approvalRequired ? '<span class="node-tag human">human gate</span>' : ''}
        </div>
      </article>`;
  }).join('');
}

function renderRecommendation() {
  const recommendation = state.results.get('recommendation');
  if (!recommendation) {
    elements.recommendation.hidden = true;
    elements.completion.hidden = true;
    return;
  }
  elements.recommendation.hidden = false;
  elements.recommendationTotal.textContent = currency(recommendation.subtotal);
  elements.recommendationRail.textContent = `${recommendation.travel.provider} · ${currency(recommendation.travel.price)}`;
  elements.recommendationTimes.textContent = `${recommendation.travel.departAt || '—'} → ${recommendation.travel.arriveAt || '—'}`;
  elements.recommendationStay.textContent = `${recommendation.stay.label} · ${currency(recommendation.stay.price)}`;
  elements.recommendationAddress.textContent = recommendation.stay.address || 'Address supplied by provider';
  elements.recommendationWalk.textContent = `${recommendation.access.walkingMinutes} min walk`;
  elements.recommendationDistance.textContent = `${recommendation.access.distanceKm} km to final destination`;
  elements.recommendationSavings.textContent = currency(recommendation.savings);

  const travelHold = state.results.get('travel-hold');
  const stayHold = state.results.get('stay-hold');
  elements.completion.hidden = state.phase !== 'completed';
  if (state.phase === 'completed') {
    elements.completionCopy.textContent = `Travel hold ${travelHold?.holdId ?? 'created'} and stay hold ${stayHold?.holdId ?? 'created'} are staged. No payment was made.`;
  }
}

function renderMappings() {
  elements.mappingsEmpty.hidden = state.mappings.length > 0;
  const sorted = [...state.mappings].sort((a, b) => Number(a.quarantined) - Number(b.quarantined));
  elements.mappingList.innerHTML = sorted.map((mapping) => {
    const schemaFields = Object.keys(mapping.schema?.properties ?? {});
    const target = mapping.quarantined ? 'QUARANTINED' : mapping.capability?.id ?? 'Unmapped';
    const confidence = mapping.quarantined ? 'BLOCKED' : mapping.capability ? `${Math.round(mapping.confidence * 100)}%` : '—';
    const evidence = mapping.quarantined
      ? [mapping.security.reason, ...mapping.security.matches.map((match) => `Matched security rule: ${match}`)]
      : mapping.explanation;
    return `
      <article class="mapping-card ${mapping.quarantined ? 'quarantined' : ''}">
        <div class="mapping-head">
          <div><div class="provider-kicker">${escapeHtml(providerLabel(mapping.tool.name))}</div><div class="mapping-tool">${escapeHtml(mapping.tool.name)}</div></div>
          <div class="mapping-confidence">${escapeHtml(confidence)}</div>
        </div>
        <div class="mapping-arrow"><span>semantic mapping →</span><strong>${escapeHtml(target)}</strong></div>
        <ul class="mapping-evidence">${evidence.filter(Boolean).slice(0, 4).map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>
        <div class="mapping-tags">
          <span>${escapeHtml(riskLabel(mapping.risk))}</span>
          <span>${schemaFields.length} schema field${schemaFields.length === 1 ? '' : 's'}</span>
          ${mapping.quarantined ? '<span class="danger">metadata poisoning detected</span>' : ''}
        </div>
      </article>`;
  }).join('');
}

function renderAudit() {
  const entries = audit.entries();
  if (!entries.length) {
    elements.auditList.innerHTML = '<div class="inspector-empty"><span>◷</span><p>The execution trace is empty.</p></div>';
    return;
  }
  elements.auditList.innerHTML = [...entries].reverse().slice(0, 30).map((entry) => `
    <article class="audit-entry">
      <strong>${escapeHtml(entry.event)}</strong>
      <time datetime="${escapeHtml(entry.timestamp)}">${escapeHtml(new Date(entry.timestamp).toLocaleTimeString('en-GB'))}</time>
      <pre>${escapeHtml(JSON.stringify(entry.details, null, 2))}</pre>
    </article>`).join('');
}

function renderStateView() {
  elements.stateView.textContent = JSON.stringify(publicSnapshot(), null, 2);
}

function approvalDetails(node) {
  const recommendation = state.results.get('recommendation');
  if (!recommendation) return { title: node.label, detail: node.mapping?.tool?.name ?? node.id };
  if (node.id === 'travel-hold') {
    return {
      title: `Hold ${recommendation.travel.provider} fare · ${currency(recommendation.travel.price)}`,
      detail: `${node.mapping.tool.name}(${recommendation.travel.id})`,
    };
  }
  return {
    title: `Hold ${recommendation.stay.label} · ${currency(recommendation.stay.price)}`,
    detail: `${node.mapping.tool.name}(${recommendation.stay.id})`,
  };
}

function renderApprovalActions() {
  const pending = state.plan?.nodes.filter((node) => node.approvalRequired && node.status === 'pending') ?? [];
  elements.approvalActions.innerHTML = pending.map((node) => {
    const details = approvalDetails(node);
    return `
      <label class="approval-item">
        <input type="checkbox" value="${escapeHtml(node.id)}" checked>
        <span><strong>${escapeHtml(details.title)}</strong><small>${escapeHtml(details.detail)}</small></span>
        <span class="risk-badge">${escapeHtml(riskLabel(node.risk))}</span>
      </label>`;
  }).join('');
}

function renderAll() {
  renderHeaderAndMetrics();
  renderPhase();
  renderGraph();
  renderRecommendation();
  renderMappings();
  renderAudit();
  renderStateView();
}

function publicSnapshot() {
  const recommendation = state.results.get('recommendation');
  return {
    phase: state.phase,
    runtimeMode: state.runtimeMode,
    providers: [...state.providers.values()].map((provider) => ({
      id: provider.id,
      label: provider.label,
      mode: provider.mode,
      status: provider.status,
      tools: [...(provider.tools ?? [])],
    })),
    discoveredToolCount: state.tools.length,
    capabilityMappings: state.mappings.map((mapping) => ({
      tool: mapping.tool.name,
      provider: providerLabel(mapping.tool.name),
      capability: mapping.capability?.id ?? null,
      confidence: Number(mapping.confidence.toFixed(3)),
      risk: mapping.risk,
      riskLabel: riskLabel(mapping.risk),
      quarantined: mapping.quarantined,
      security: {
        suspicious: mapping.security.suspicious,
        reason: mapping.security.reason,
        matches: [...mapping.security.matches],
      },
      explanation: [...mapping.explanation],
      schemaProperties: Object.keys(mapping.schema?.properties ?? {}),
    })),
    mission: state.mission ? { ...state.mission } : null,
    plan: state.plan ? {
      id: state.plan.id,
      status: state.plan.status,
      createdAt: state.plan.createdAt,
      nodes: state.plan.nodes.map((node) => ({
        id: node.id,
        type: node.type,
        label: node.label,
        capabilityId: node.capabilityId ?? null,
        operation: node.operation ?? null,
        tool: node.mapping?.tool?.name ?? null,
        status: node.status,
        dependencies: [...node.dependencies],
        risk: node.risk,
        approvalRequired: node.approvalRequired,
        error: node.error,
      })),
    } : null,
    recommendation: recommendation ? {
      total: recommendation.subtotal,
      travel: {
        id: recommendation.travel.id,
        provider: recommendation.travel.provider,
        price: recommendation.travel.price,
        departAt: recommendation.travel.departAt,
        arriveAt: recommendation.travel.arriveAt,
      },
      stay: {
        id: recommendation.stay.id,
        label: recommendation.stay.label,
        provider: recommendation.stay.provider,
        price: recommendation.stay.price,
        address: recommendation.stay.address,
      },
      walkingMinutes: recommendation.access.walkingMinutes,
      distanceKm: recommendation.access.distanceKm,
      savings: recommendation.savings,
    } : null,
    holds: {
      travel: state.results.get('travel-hold') ?? null,
      stay: state.results.get('stay-hold') ?? null,
    },
    humanApproval: state.humanApproval ? { ...state.humanApproval, actionIds: [...state.humanApproval.actionIds] } : null,
    auditCount: audit.entries().length,
    lastError: state.lastError,
  };
}

function toast(message, type = 'info') {
  const item = document.createElement('div');
  item.className = `toast ${type === 'error' ? 'error' : ''}`;
  item.textContent = message;
  elements.toastRegion.append(item);
  setTimeout(() => item.remove(), 4200);
}

function fail(error, context) {
  const message = error instanceof Error ? error.message : String(error);
  state.lastError = { context, message, at: new Date().toISOString() };
  state.phase = 'failed';
  audit.add('application.error', state.lastError);
  renderAll();
  toast(`${context}: ${message}`, 'error');
}

function handleAsync(action, context) {
  Promise.resolve().then(action).catch((error) => {
    if (state.lastError?.message !== error?.message) fail(error, context);
  });
}

async function registerOrchestratorTools() {
  const tools = [
    {
      name: 'toolbraid.plan_mission',
      title: 'Plan a cross-site mission',
      description: 'Parse a user goal, discover live WebMCP provider tools, normalize incompatible semantics, and build an explainable dependency-aware plan. This does not execute external actions.',
      inputSchema: {
        type: 'object',
        properties: {
          goal: { type: 'string', description: 'Natural-language objective.' },
          origin: { type: 'string' },
          destination: { type: 'string' },
          destinationAddress: { type: 'string' },
          date: { type: 'string', format: 'date' },
          budget: { type: 'number', minimum: 1 },
          currency: { type: 'string', default: 'GBP' },
        },
        required: ['goal'],
      },
      annotations: { readOnlyHint: false, idempotentHint: true },
      execute: (input) => planMission(input, 'webmcp-agent'),
    },
    {
      name: 'toolbraid.execute_safe_steps',
      title: 'Execute read-only mission steps',
      description: 'Execute only read-only provider calls and local comparison steps. Stop before every external state change and surface the human approval checkpoint in the page.',
      inputSchema: { type: 'object', properties: {} },
      annotations: { readOnlyHint: true, idempotentHint: true },
      execute: () => runSafeSteps('webmcp-agent'),
    },
    {
      name: 'toolbraid.execute_approved_actions',
      title: 'Execute human-approved mission actions',
      description: 'Execute only reversible actions that a person has already selected and approved in the ToolBraid UI. Calling this tool cannot create its own approval record.',
      inputSchema: { type: 'object', properties: {} },
      annotations: { readOnlyHint: false, idempotentHint: false },
      execute: () => runApprovedActions('webmcp-agent'),
    },
    {
      name: 'toolbraid.inspect_state',
      title: 'Inspect orchestration state',
      description: 'Return the current mission, semantic mappings, execution graph, approval state, results, and audit summary without changing anything.',
      inputSchema: { type: 'object', properties: {} },
      annotations: { readOnlyHint: true, idempotentHint: true },
      execute: () => publicSnapshot(),
    },
  ];
  for (const tool of tools) await runtime.registerTool(tool);
}

function bindEvents() {
  document.addEventListener('click', (event) => {
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (action === 'plan') handleAsync(() => planMission({}, 'human-ui'), 'Planning failed');
    if (action === 'run-safe') handleAsync(() => runSafeSteps('human-ui'), 'Safe execution failed');
    if (action === 'approve') approveSelectedActions('human-ui');
    if (action === 'decline') declineApproval();
    if (action === 'run-approved') handleAsync(() => runApprovedActions('human-ui'), 'Approved execution failed');
    if (action === 'reset') resetMission();
    if (action === 'close-approval') hideApproval();

    const tab = event.target.closest('[data-tab]');
    if (tab) {
      for (const button of document.querySelectorAll('[data-tab]')) {
        const active = button === tab;
        button.classList.toggle('active', active);
        button.setAttribute('aria-selected', String(active));
      }
      for (const panel of document.querySelectorAll('[data-panel]')) {
        panel.classList.toggle('active', panel.dataset.panel === tab.dataset.tab);
      }
    }
  });

  elements.approvalBackdrop.addEventListener('click', hideApproval);
  window.addEventListener('message', (event) => {
    if (event.origin !== location.origin || !event.data || typeof event.data !== 'object') return;
    if (event.data.type === 'toolbraid:provider-ready') {
      setProviderReady(event.data.provider, {
        label: event.data.label,
        mode: event.data.mode,
        tools: event.data.tools,
        status: event.data.provider === 'mirage' ? 'Security fixture' : 'Ready',
      });
      renderAll();
    }
    if (event.data.type === 'toolbraid:provider-event') {
      const current = state.providers.get(event.data.provider) ?? {};
      setProviderReady(event.data.provider, { ...current, status: `Called ${String(event.data.tool).split('.').pop()}` });
      renderHeaderAndMetrics();
    }
  });
}

async function initialize() {
  elements.date.value = tomorrowIso();
  bindEvents();
  await registerOrchestratorTools();
  audit.add('runtime.initialized', {
    mode: runtime.mode,
    API: 'document.modelContext',
    policy: 'human approval required for external state changes',
  });
  renderAll();

  const tools = await runtime.waitForTools({
    minimum: 6,
    timeout: 7000,
    predicate: (tool) => !tool.name.startsWith('toolbraid.'),
  });
  await discoverTools();
  if (tools.length < 6) {
    throw new Error(`Only ${tools.length} of 6 expected provider tools became available.`);
  }
  state.phase = 'idle';
  audit.add('runtime.ready', { providers: state.providers.size, providerTools: state.tools.length });
  renderAll();

  const autoDemo = new URLSearchParams(location.search).get('autodemo');
  if (autoDemo === 'safe' || autoDemo === 'complete') {
    await planMission({}, 'autodemo');
    await runSafeSteps('autodemo');
  }
  return publicSnapshot();
}

window.ToolBraidApp = Object.freeze({
  planMission,
  runSafeSteps,
  runApprovedActions,
  inspect: publicSnapshot,
  snapshot: publicSnapshot,
  reset: resetMission,
});

window.__toolbraidReady = initialize().catch((error) => {
  fail(error, 'Initialization failed');
  throw error;
});
