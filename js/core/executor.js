import { buildToolInput, canonicalizeToolOutput, validateCanonicalOutput, validateToolInput } from './adapters.js';
import { getRunnableNodes } from './planner.js';
import { RISK_LEVELS } from './risk.js';

export function composeCandidates(travelOptions, stayOptions, limit = 9) {
  const candidates = [];
  for (const travel of travelOptions.slice(0, 4)) {
    for (const stay of stayOptions.slice(0, 4)) candidates.push({ id: `${travel.id}::${stay.id}`, travel, stay, subtotal: Number((travel.price + stay.price).toFixed(2)) });
  }
  return { candidates: candidates.sort((a, b) => a.subtotal - b.subtotal).slice(0, limit) };
}

export function rankRecommendation(candidateResult, accessResult, mission) {
  const distances = new Map(accessResult.map((item) => [item.id, item]));
  const ranked = candidateResult.candidates.map((candidate) => {
    const access = distances.get(candidate.stay.id) ?? { walkingMinutes: 999, distanceKm: 999 };
    const withinBudget = candidate.subtotal <= mission.budget;
    const score = candidate.subtotal + access.walkingMinutes * 0.6 + (withinBudget ? 0 : 1000);
    return { ...candidate, access, withinBudget, score: Number(score.toFixed(2)), currency: mission.currency };
  }).sort((a, b) => a.score - b.score);
  const best = ranked[0];
  if (!best || !best.withinBudget) {
    const error = new Error(`No combined option fits the ${mission.currency} ${mission.budget} budget.`);
    error.code = 'NO_FEASIBLE_OPTION';
    throw error;
  }
  return { ...best, savings: Number((mission.budget - best.subtotal).toFixed(2)), alternatives: ranked.slice(1, 4) };
}

function parseExecutionResult(result) {
  if (typeof result !== 'string') return result;
  try { return JSON.parse(result); } catch { return result; }
}

async function executeMapping(node, mapping, context) {
  const input = buildToolInput(node.capabilityId, mapping.schema, context);
  validateToolInput(mapping.schema, input);
  context.onAudit?.('tool.input_built', { nodeId: node.id, tool: mapping.tool.name, capability: node.capabilityId, input });
  const rawResult = await context.runtime.executeTool(mapping.tool, input);
  const payload = parseExecutionResult(rawResult);
  const canonical = canonicalizeToolOutput(node.capabilityId, payload);
  validateCanonicalOutput(node.capabilityId, canonical);
  return canonical;
}

async function executeToolNode(node, context) {
  const canFailOver = node.risk === RISK_LEVELS.READ_ONLY && !node.approvalRequired;
  const candidates = canFailOver ? [node.mapping, ...(node.alternatives ?? [])] : [node.mapping];
  const errors = [];
  for (let index = 0; index < candidates.length; index += 1) {
    const mapping = candidates[index];
    try {
      if (index > 0) context.onAudit?.('tool.fallback_attempted', { nodeId: node.id, capability: node.capabilityId, tool: mapping.tool.name, previousErrors: errors.map((entry) => ({ ...entry })) });
      const result = await executeMapping(node, mapping, context);
      if (index > 0) {
        node.mapping = mapping;
        node.alternatives = candidates.filter((candidate) => candidate !== mapping);
        context.onAudit?.('tool.fallback_selected', { nodeId: node.id, capability: node.capabilityId, tool: mapping.tool.name });
      }
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push({ tool: mapping.tool.name, error: message });
      context.onAudit?.('tool.attempt_failed', { nodeId: node.id, capability: node.capabilityId, tool: mapping.tool.name, canFailOver, error: message });
      if (!canFailOver) throw error;
    }
  }
  const error = new Error(`All providers failed for ${node.capabilityId}: ${errors.map((entry) => `${entry.tool}: ${entry.error}`).join('; ')}`);
  error.code = 'CAPABILITY_EXECUTION_FAILED';
  error.attempts = errors;
  throw error;
}

function executeLocalNode(node, context) {
  if (node.operation === 'composeCandidates') return composeCandidates(context.results.get('travel-search'), context.results.get('stay-search'));
  if (node.operation === 'rankRecommendation') return rankRecommendation(context.results.get('candidate-weave'), context.results.get('access-check'), context.mission);
  throw new Error(`Unknown local operation: ${node.operation}`);
}

async function executeNode(node, context) {
  node.status = 'running';
  context.onNodeChange?.(node);
  context.onAudit?.('node.started', { nodeId: node.id, type: node.type, label: node.label });
  try {
    const result = node.type === 'tool' ? await executeToolNode(node, context) : executeLocalNode(node, context);
    node.result = result;
    node.status = 'completed';
    context.results.set(node.id, result);
    context.onAudit?.('node.completed', { nodeId: node.id, resultSummary: summarize(result) });
    context.onNodeChange?.(node);
    return result;
  } catch (error) {
    node.status = 'failed';
    node.error = error instanceof Error ? error.message : String(error);
    context.onAudit?.('node.failed', { nodeId: node.id, error: node.error });
    context.onNodeChange?.(node);
    throw error;
  }
}

function summarize(value) {
  if (Array.isArray(value)) return { type: 'array', count: value.length };
  if (value && typeof value === 'object') {
    if (Array.isArray(value.candidates)) return { type: 'candidate-set', count: value.candidates.length };
    if (value.holdId) return { type: 'hold', holdId: value.holdId };
    if (value.travel && value.stay) return { type: 'recommendation', total: value.subtotal };
    return { type: 'object', keys: Object.keys(value).slice(0, 8) };
  }
  return { type: typeof value, value: String(value).slice(0, 100) };
}

export async function runPlanUntilBlocked(plan, context, { includeApproval = false } = {}) {
  let executed = 0;
  while (true) {
    const runnable = getRunnableNodes(plan, { includeApproval });
    if (!runnable.length) break;
    await Promise.all(runnable.map((node) => executeNode(node, context)));
    executed += runnable.length;
  }
  const pendingApproval = plan.nodes.filter((node) => node.approvalRequired && node.status === 'pending');
  const approvedPending = plan.nodes.filter((node) => node.approvalRequired && node.status === 'approved');
  const failed = plan.nodes.some((node) => node.status === 'failed');
  const complete = plan.nodes.every((node) => node.status === 'completed');
  plan.status = failed ? 'failed' : complete ? 'completed' : pendingApproval.length ? 'approval_required' : approvedPending.length ? 'approved' : 'blocked';
  return { executed, pendingApproval, complete, status: plan.status };
}
