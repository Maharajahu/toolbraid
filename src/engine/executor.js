import { NODE_STATUS, runnableNodes } from './graph.js';
import { RISK_LEVELS } from './risk.js';

function executionError(code, message, details = {}) {
  const error = new Error(message);
  error.name = 'ExecutionError';
  error.code = code;
  error.details = details;
  return error;
}

function identity(tool) {
  return { origin: tool?.origin ?? null, name: tool?.name ?? null };
}

function summarize(value) {
  if (Array.isArray(value)) return { type: 'array', count: value.length };
  if (value && typeof value === 'object') return { type: 'object', keys: Object.keys(value).slice(0, 12) };
  return { type: typeof value };
}

function cloneArguments(value, code, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw executionError(code, `${label} must be an arguments object.`, { receivedType: typeof value });
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw executionError(code, `${label} must be a plain arguments object.`, {
      receivedType: value.constructor?.name ?? typeof value,
    });
  }
  try {
    return structuredClone(value);
  } catch (cause) {
    throw executionError(code, `${label} must be structured-cloneable.`, {
      cause: cause instanceof Error ? cause.message : String(cause),
    });
  }
}

function nodeCandidates(node) {
  if (Array.isArray(node.candidates) && node.candidates.length) return node.candidates;
  if (node.mapping) return [node.mapping, ...(node.alternatives ?? [])];
  return [];
}

async function resolveExecutionArguments(node, candidate, tool, context) {
  const candidateHasArguments = candidate.arguments
    && typeof candidate.arguments === 'object'
    && Object.keys(candidate.arguments).length > 0;
  const legacyArguments = candidateHasArguments ? candidate.arguments : node.arguments ?? candidate.arguments ?? {};
  const plannedCanonicalArguments = node.arguments ?? legacyArguments;
  const usesProviderIndependentArguments = typeof context.resolveArguments === 'function'
    || typeof context.adaptInput === 'function';
  const hookContext = {
    plan: context.plan,
    node,
    candidate,
    tool,
    results: context.results,
  };

  const resolved = typeof context.resolveArguments === 'function'
    ? await context.resolveArguments(
      node.capabilityId,
      cloneArguments(plannedCanonicalArguments, 'ARGUMENT_RESOLUTION_INVALID', 'Planned canonical arguments'),
      hookContext,
    )
    : usesProviderIndependentArguments ? plannedCanonicalArguments : legacyArguments;
  const canonicalArguments = cloneArguments(
    resolved,
    'ARGUMENT_RESOLUTION_INVALID',
    `Resolved canonical arguments for ${node.id}`,
  );

  const adapted = typeof context.adaptInput === 'function'
    ? await context.adaptInput(
      node.capabilityId,
      structuredClone(canonicalArguments),
      hookContext,
    )
    : canonicalArguments;
  const nativeArguments = cloneArguments(
    adapted,
    'INPUT_ADAPTATION_INVALID',
    `Native arguments for ${node.id}`,
  );

  return { canonicalArguments, nativeArguments };
}

async function executeToolNode(node, context) {
  const candidates = nodeCandidates(node);
  if (!candidates.length) {
    throw executionError('TOOL_MAPPING_MISSING', `Node ${node.id} has no mapped tool.`, { nodeId: node.id });
  }

  const canFailOver = node.risk === RISK_LEVELS.READ_ONLY && !node.approvalRequired;
  const attempts = canFailOver ? candidates : candidates.slice(0, 1);
  const failures = [];

  if (node.approvalRequired && node.argumentsDeferred === true) {
    throw executionError(
      'MUTATION_ARGUMENTS_DEFERRED',
      `Node ${node.id} cannot execute before its exact mutation arguments are finalized.`,
      { nodeId: node.id, capability: node.capabilityId },
    );
  }

  for (let index = 0; index < attempts.length; index += 1) {
    const candidate = attempts[index];
    const tool = candidate.tool;
    const toolIdentity = identity(tool);

    try {
      const { canonicalArguments, nativeArguments } = await resolveExecutionArguments(node, candidate, tool, context);
      if (node.approvalRequired) {
        if (typeof context.authorizeMutation !== 'function') {
          throw executionError('APPROVAL_REQUIRED', `Node ${node.id} requires a verified human approval.`, {
            nodeId: node.id,
            tool: toolIdentity,
          });
        }
        await context.authorizeMutation({
          plan: context.plan,
          node,
          candidate,
          tool,
          arguments: canonicalArguments,
          canonicalArguments,
          nativeArguments,
        });
      }

      context.onAudit?.('tool.execution_started', {
        nodeId: node.id,
        capability: node.capabilityId,
        tool: toolIdentity,
        arguments: nativeArguments,
        canonicalArguments,
        nativeArguments,
        attempt: index + 1,
      });
      context.assertExecutionCurrent?.({
        plan: context.plan,
        node,
        candidate,
        tool,
        canonicalArguments,
        nativeArguments,
      });
      const raw = await context.runtime.execute(tool, nativeArguments, { signal: context.signal });
      const result = typeof context.adaptOutput === 'function'
        ? await context.adaptOutput(node.capabilityId, raw, { plan: context.plan, node, candidate, results: context.results })
        : raw;
      if (typeof context.validateOutput === 'function') {
        await context.validateOutput(node.capabilityId, result, { plan: context.plan, node, candidate });
      }
      if (index > 0) {
        node.candidates = [candidate, ...candidates.filter((item) => item !== candidate)];
        context.onAudit?.('tool.failover_selected', {
          nodeId: node.id,
          capability: node.capabilityId,
          tool: toolIdentity,
          priorFailures: failures,
        });
      }
      return result;
    } catch (error) {
      const failure = {
        tool: toolIdentity,
        code: error?.code ?? null,
        message: error instanceof Error ? error.message : String(error),
      };
      failures.push(failure);
      context.onAudit?.('tool.execution_failed', {
        nodeId: node.id,
        capability: node.capabilityId,
        canFailOver,
        ...failure,
      });
      if (!canFailOver) throw error;
    }
  }

  throw executionError(
    'CAPABILITY_EXECUTION_FAILED',
    `Every read-only provider failed for ${node.capabilityId}.`,
    { nodeId: node.id, attempts: failures },
  );
}

async function executeLocalNode(node, context) {
  const operation = context.localOperations?.[node.operation];
  if (typeof operation !== 'function') {
    throw executionError('LOCAL_OPERATION_MISSING', `Unknown local operation: ${node.operation}`, {
      nodeId: node.id,
      operation: node.operation,
    });
  }
  return operation({ plan: context.plan, node, results: context.results });
}

async function executeNode(node, context) {
  node.status = NODE_STATUS.RUNNING;
  node.error = null;
  context.onNodeChange?.(node);
  context.onAudit?.('node.started', { nodeId: node.id, type: node.type, label: node.label });
  try {
    const result = node.type === 'tool'
      ? await executeToolNode(node, context)
      : await executeLocalNode(node, context);
    node.result = result;
    node.status = NODE_STATUS.COMPLETED;
    context.results.set(node.id, result);
    context.onAudit?.('node.completed', { nodeId: node.id, result: summarize(result) });
    context.onNodeChange?.(node);
    return result;
  } catch (error) {
    node.status = NODE_STATUS.FAILED;
    node.error = error instanceof Error ? error.message : String(error);
    context.onAudit?.('node.failed', { nodeId: node.id, code: error?.code ?? null, error: node.error });
    context.onNodeChange?.(node);
    throw error;
  }
}

export async function runPlanUntilBlocked(plan, services, {
  includeApprovedMutations = false,
  stopBeforeNodeIds = [],
} = {}) {
  if (!Array.isArray(stopBeforeNodeIds) || stopBeforeNodeIds.some((nodeId) => typeof nodeId !== 'string')) {
    throw executionError('EXECUTION_OPTION_INVALID', 'stopBeforeNodeIds must be an array of node IDs.');
  }
  const stopBefore = new Set(stopBeforeNodeIds);
  const context = {
    ...services,
    plan,
    results: services.results ?? new Map(
      plan.nodes
        .filter((node) => node.status === NODE_STATUS.COMPLETED)
        .map((node) => [node.id, node.result]),
    ),
  };
  if (!context.runtime || typeof context.runtime.execute !== 'function') {
    throw executionError('RUNTIME_MISSING', 'A WebMCP runtime client is required.');
  }

  let executed = 0;
  while (true) {
    const batch = runnableNodes(plan, { includeApprovedMutations })
      .filter((node) => !stopBefore.has(node.id));
    if (!batch.length) break;
    const settled = await Promise.allSettled(batch.map((node) => executeNode(node, context)));
    executed += batch.length;
    const rejected = settled.find((entry) => entry.status === 'rejected');
    if (rejected) throw rejected.reason;
  }

  const failed = plan.nodes.some((node) => node.status === NODE_STATUS.FAILED);
  const complete = plan.nodes.every((node) => node.status === NODE_STATUS.COMPLETED);
  const pendingApproval = plan.nodes.filter(
    (node) => node.approvalRequired && node.status === NODE_STATUS.PENDING,
  );
  const approvedPending = plan.nodes.filter(
    (node) => node.approvalRequired && node.status === NODE_STATUS.APPROVED,
  );
  plan.status = failed
    ? 'failed'
    : complete
      ? 'completed'
      : pendingApproval.length
        ? 'approval_required'
        : approvedPending.length
          ? 'approved'
          : 'blocked';

  return { executed, complete, pendingApproval, status: plan.status, results: context.results };
}
