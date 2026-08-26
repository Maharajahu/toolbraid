import { requiresApproval } from './risk.js';
import { rankToolsByCapability } from './normalizer.js';

function toolNode(id, label, capabilityId, mappings, dependencies = []) {
  const [mapping, ...alternatives] = mappings;
  return {
    id,
    type: 'tool',
    label,
    capabilityId,
    mapping,
    alternatives,
    dependencies,
    risk: mapping.risk,
    approvalRequired: requiresApproval(mapping.risk),
    status: 'pending',
    result: null,
    error: null,
  };
}

function localNode(id, label, operation, dependencies = []) {
  return {
    id,
    type: 'local',
    label,
    operation,
    dependencies,
    risk: 0,
    approvalRequired: false,
    status: 'pending',
    result: null,
    error: null,
  };
}

export function buildTripPlan(mission, mappings) {
  const required = ['travel.search', 'accommodation.search', 'location.distance', 'travel.hold', 'accommodation.hold'];
  const ranked = new Map(required.map((id) => [id, rankToolsByCapability(mappings, id)]));
  const missing = required.filter((id) => !ranked.get(id)?.length);
  if (missing.length) {
    const error = new Error(`Missing required capabilities: ${missing.join(', ')}`);
    error.code = 'CAPABILITY_GAP';
    error.missing = missing;
    throw error;
  }

  const nodes = [
    toolNode('travel-search', `Search transport from ${mission.origin}`, 'travel.search', ranked.get('travel.search')),
    toolNode('stay-search', `Search stays near ${mission.destination}`, 'accommodation.search', ranked.get('accommodation.search')),
    localNode('candidate-weave', 'Compose compatible transport + stay pairs', 'composeCandidates', ['travel-search', 'stay-search']),
    toolNode('access-check', 'Measure walking access for shortlisted stays', 'location.distance', ranked.get('location.distance'), ['candidate-weave']),
    localNode('recommendation', `Select the best mission under ${mission.currency} ${mission.budget}`, 'rankRecommendation', ['candidate-weave', 'access-check']),
    toolNode('travel-hold', 'Place a reversible fare hold', 'travel.hold', ranked.get('travel.hold'), ['recommendation']),
    toolNode('stay-hold', 'Place a reversible room hold', 'accommodation.hold', ranked.get('accommodation.hold'), ['recommendation']),
  ];

  return {
    id: `plan-${Date.now().toString(36)}`,
    mission,
    nodes,
    createdAt: new Date().toISOString(),
    status: 'planned',
  };
}

export function getRunnableNodes(plan, { includeApproval = false } = {}) {
  return plan.nodes.filter((node) => {
    if (node.status !== 'pending' && node.status !== 'approved') return false;
    if (node.approvalRequired && !includeApproval) return false;
    if (node.approvalRequired && node.status !== 'approved') return false;
    return node.dependencies.every((id) => plan.nodes.find((candidate) => candidate.id === id)?.status === 'completed');
  });
}

export function approvePlanActions(plan, nodeIds) {
  const allowed = new Set(nodeIds);
  for (const node of plan.nodes) {
    if (node.approvalRequired && allowed.has(node.id) && node.status === 'pending') node.status = 'approved';
  }
  return plan;
}

export function planProgress(plan) {
  const completed = plan.nodes.filter((node) => node.status === 'completed').length;
  return {
    completed,
    total: plan.nodes.length,
    percent: Math.round((completed / Math.max(1, plan.nodes.length)) * 100),
  };
}
