import { CoreError, errorShape } from './errors.js';
import { identityKey, requireIdentity } from './identity.js';
import { canonicalHash, jsonClone } from './serialization.js';
import { capabilityBindingHash, validatePlan } from './planner.js';
import { assertCapabilitySchemas, assertSchemaValue } from './schema.js';

const TERMINAL_WORKFLOW_STATES = new Set(['completed', 'failed', 'cancelled']);
const MAX_REPLAY_NODES = 100;
const APPROVAL_MISS_CODES = new Set([
  'APPROVAL_REQUIRED',
  'APPROVAL_NOT_FOUND',
  'APPROVAL_EXPIRED',
  'APPROVAL_INVALID',
  'APPROVAL_REPLAY',
  'APPROVAL_REPLAYED',
]);

/**
 * Sequential execution broker for semantic capability nodes.
 *
 * The broker accepts only an adapter/executor supplied by the trusted
 * composition root.  It never evaluates a function, script, shell command,
 * selector, or caller-provided executable value from a plan.
 */
export class ExecutionBroker {
  constructor(options = {}) {
    if (!options || typeof options !== 'object' || Array.isArray(options)) throw new CoreError('INVALID_EXECUTION', 'Broker options must be an object');
    this.store = options.store ?? options.workflowStore;
    if (!this.store || typeof this.store.get !== 'function') throw new CoreError('INVALID_EXECUTION', 'A workflow store is required');
    this.catalog = options.catalog;
    if (!this.catalog || typeof this.catalog.resolve !== 'function') {
      throw new CoreError('INVALID_EXECUTION', 'A capability catalog with resolve() is required');
    }
    this.policy = options.policy ?? options.policyEngine;
    if (this.policy !== undefined &&
        typeof this.policy?.evaluate !== 'function' &&
        typeof this.policy?.check !== 'function') {
      throw new CoreError('INVALID_EXECUTION', 'policy must expose evaluate() or check()');
    }
    this.approvalStore = options.approvalStore ?? options.approvals;
    this.approvalVerifier = options.approvalVerifier;
    // A credential resolver is trusted constructor state.  It is deliberately
    // not read from workflow.execute input, so a client cannot self-approve.
    this.approvalCredentialResolver = options.approvalCredentialResolver
      ?? options.approvalResolver
      ?? options.credentialResolver;
    this.approvalCredential = options.approvalCredential;
    this.executor = options.executor ?? options.execute;
    this.adapters = options.adapters;
    this.adapterResolver = options.adapterResolver;
    this.audit = options.audit;
    this.clock = typeof options.clock === 'function' ? options.clock : () => new Date().toISOString();
    this.replaySequence = 0;
    this.inFlightExecutions = new Map();
    // If a workflow store cannot persist a failure/reconciliation transition,
    // retain a process-local no-reinvoke guard.  A later call must not gamble
    // on a side effect whose durable outcome is still unknown.
    this.reconciliationExecutions = new Map();
  }

  async execute(input, context = {}) {
    const operation = requireObject(input, 'execute input');
    const identity = requireIdentity(operation);
    rejectCallerApproval(operation);
    const executionContext = invocationContext(operation.context ?? context);
    const workflowId = requireWorkflowId(operation.workflowId);
    const revision = normalizeRevision(operation.revision);
    const constraints = normalizeExecutionConstraints(operation);
    const workflow = this.store.get({ identity, workflowId, revision });
    const plan = workflow?.plan ? this.#validateStoredPlan(identity, workflow) : undefined;
    if (plan) assertExecutionContext({ operation, plan, constraints });
    const executionOperation = applyExecutionConstraints(operation, constraints);
    const executionKey = executionKeyFor({ identity, workflowId, revision, constraints });
    const pending = this.inFlightExecutions.get(executionKey);
    if (pending) return pending;
    const blocked = this.reconciliationExecutions.get(executionKey);
    if (blocked && !TERMINAL_WORKFLOW_STATES.has(workflow?.state)) throw blocked;

    // Defer the state-machine entry until after the promise is registered so
    // two calls made in the same turn cannot both observe a runnable node.
    const execution = Promise.resolve().then(() => this.#executeOnce({
      operation: executionOperation,
      identity,
      workflowId,
      revision,
      context: executionContext,
      executionKey,
    }));
    this.inFlightExecutions.set(executionKey, execution);
    try {
      return await execution;
    } finally {
      if (this.inFlightExecutions.get(executionKey) === execution) {
        this.inFlightExecutions.delete(executionKey);
      }
    }
  }

  async #executeOnce({ operation, identity, workflowId, revision, context, executionKey }) {
    let workflow = this.store.get({ identity, workflowId, revision });
    if (!workflow.plan) throw new CoreError('WORKFLOW_NOT_PROPOSED', 'Workflow has no proposed plan');
    const plan = this.#validateStoredPlan(identity, workflow);
    assertExecutionContext({ operation, plan, constraints: normalizeExecutionConstraints(operation) });
    if (TERMINAL_WORKFLOW_STATES.has(workflow.state)) return executionView(workflow);
    if (workflow.state === 'draft') throw new CoreError('WORKFLOW_NOT_PROPOSED', 'Draft workflows cannot execute');
    if (workflow.state === 'proposed') {
      workflow = this.store.start({ identity, workflowId, revision });
      await this.#audit({ type: 'workflow_started', identity, workflowId, revision });
    }

    for (const nodeId of plan.order) {
      workflow = this.store.get({ identity, workflowId, revision });
      const node = plan.nodes.find((entry) => entry.id === nodeId);
      const current = workflow.nodeStates[nodeId];
      if (!current || current.state === 'completed') continue;
      if (['failed', 'cancelled'].includes(current.state)) {
        throw new CoreError('WORKFLOW_NODE_TERMINAL', `Node ${nodeId} is ${current.state}`);
      }
      this.#assertDependenciesCompleted(plan, workflow, node);

      if (!node.readOnly) {
        let approval;
        try {
          approval = await this.#approvalFor({ identity, workflow, node, operation });
        } catch (error) {
          if (error instanceof CoreError && error.code === 'POLICY_DENIED') {
            this.#failBeforeInvocation({ identity, workflowId, revision, nodeId, error });
          }
          throw error;
        }
        if (!approval) {
          const request = approvalRequest({ identity, workflow, node });
          if (workflow.state === 'awaiting_approval') {
            if (workflow.awaitingApproval?.nodeId !== nodeId || current.state !== 'awaiting_approval') {
              throw new CoreError('APPROVAL_BINDING_MISMATCH', 'Workflow approval state does not match the pending node');
            }
            return executionView(workflow, { approvalRequired: request });
          }
          workflow = this.store.awaitApproval({
            identity,
            workflowId,
            revision,
            nodeId,
            request,
          });
          await this.#audit({ type: 'approval_required', identity, workflowId, revision, nodeId });
          return executionView(workflow, { approvalRequired: request });
        }
        if (workflow.state === 'awaiting_approval') {
          workflow = this.store.resume({ identity, workflowId, revision, nodeId });
          await this.#audit({ type: 'approval_consumed', identity, workflowId, revision, nodeId });
        }
      } else if (workflow.state === 'awaiting_approval') {
        // A plan is strictly sequential.  A read-only node before the pending
        // mutation may continue only after the workflow has resumed; otherwise
        // this indicates a tampered or inconsistent store record.
        throw new CoreError('WORKFLOW_STATE', 'Workflow is awaiting approval before a read-only node');
      }

      workflow = this.store.markNode({ identity, workflowId, revision, nodeId, state: 'running' });
      await this.#audit({ type: 'node_started', identity, workflowId, revision, nodeId, readOnly: node.readOnly });
      let safeOutput;
      let invocationStarted = false;
      try {
        const output = await this.#invoke({
          identity,
          workflow,
          plan,
          node,
          operation,
          replay: false,
          context,
          onInvocationStart: () => { invocationStarted = true; },
        });
        // Treat boundary normalization as part of execution.  An adapter that
        // returns an unsupported value must not strand a node in `running`.
        safeOutput = normalizeOutput(output);
      } catch (error) {
        // A mutation has an unknown outcome as soon as its trusted adapter is
        // called.  The adapter may have committed an external side effect and
        // then failed while returning (or while its output was normalized), so
        // never convert this boundary error into an ordinary retryable node
        // failure.  Terminalize the workflow before releasing the in-flight
        // promise; a later execute call can only inspect the reconciliation
        // record and cannot invoke the mutation again.
        if (invocationStarted && !node.readOnly) {
          throw this.#terminalizeReconciliation({
            identity,
            workflowId,
            revision,
            nodeId,
            phase: 'node_invocation',
            cause: error,
            executionKey,
          });
        }
        const policyDenied = error instanceof CoreError && error.code === 'POLICY_DENIED';
        const safe = errorShape(error, {
          code: policyDenied ? 'POLICY_DENIED' : 'ADAPTER_FAILURE',
          message: policyDenied ? `Policy denied node ${nodeId}` : `Capability ${node.capabilityId} failed`,
          retryable: policyDenied ? false : true,
        });
        try {
          this.store.markNode({ identity, workflowId, revision, nodeId, state: 'failed', error: safe });
          this.store.fail({ identity, workflowId, revision, error: safe });
        } catch (persistenceError) {
          // A failed persistence transition can leave a running node behind.
          // Treat that boundary as reconciliation-required too: even when the
          // provider was not called in this attempt, the broker cannot safely
          // assume the store's state is retryable.  The process-local guard in
          // #terminalizeReconciliation prevents an implicit reinvocation when
          // a non-standard store cannot persist the terminal marker.
          throw this.#terminalizeReconciliation({
            identity,
            workflowId,
            revision,
            nodeId,
            phase: 'failure_persistence',
            cause: persistenceError,
            executionKey,
            effectMayHaveCommitted: invocationStarted && !node.readOnly,
            outcome: invocationStarted && !node.readOnly ? 'unknown' : 'not_started',
          });
        }
        await this.#audit({ type: 'node_failed', identity, workflowId, revision, nodeId, error: safe });
        throw new CoreError(
          policyDenied ? 'POLICY_DENIED' : 'EXECUTION_FAILED',
          policyDenied ? `Policy denied node ${nodeId}` : `Node ${nodeId} failed`,
          { retryable: safe.retryable === true, details: { nodeId, cause: safe }, cause: error },
        );
      }
      try {
        workflow = this.store.markNode({ identity, workflowId, revision, nodeId, state: 'completed', output: safeOutput });
      } catch (persistenceError) {
        // Completion persistence is still part of the side-effect boundary:
        // the trusted adapter has already returned successfully, but a quota
        // or durable-store error can leave the node running.  Never expose
        // that state as retryable for a mutation, because a fresh approval
        // could invoke the external effect a second time.  Read-only nodes
        // use the same terminalization path to avoid a stuck workflow while
        // accurately recording that no mutation effect was possible.
        throw this.#terminalizeReconciliation({
          identity,
          workflowId,
          revision,
          nodeId,
          phase: 'completion_persistence',
          cause: persistenceError,
          executionKey,
          effectMayHaveCommitted: !node.readOnly && invocationStarted,
          outcome: !node.readOnly && invocationStarted ? 'unknown' : 'completed',
        });
      }
      try {
        await this.#audit({ type: 'node_completed', identity, workflowId, revision, nodeId, readOnly: node.readOnly });
      } catch (error) {
        // The adapter has returned and its normalized output is durably marked
        // completed.  A failed audit append must not expose a retryable
        // `running` workflow that could make a caller repeat an ambiguous side
        // effect.  Persist a terminal reconciliation marker instead.
        throw this.#terminalizeReconciliation({
          identity,
          workflowId,
          revision,
          nodeId,
          phase: 'node_completed',
          cause: error,
          executionKey,
          effectMayHaveCommitted: !node.readOnly,
          outcome: node.readOnly ? 'completed' : 'unknown',
        });
      }
    }
    const hasMutation = plan.nodes.some((node) => !node.readOnly);
    try {
      workflow = this.store.complete({ identity, workflowId, revision });
    } catch (persistenceError) {
      // The final workflow transition can fail after every adapter has
      // returned and its node receipts are present.  Terminalize explicitly
      // so a retry cannot repeat an external mutation while completion
      // persistence is ambiguous.
      throw this.#terminalizeReconciliation({
        identity,
        workflowId,
        revision,
        phase: 'workflow_completion_persistence',
        cause: persistenceError,
        executionKey,
        effectMayHaveCommitted: hasMutation,
        outcome: hasMutation ? 'unknown' : 'completed',
      });
    }
    try {
      await this.#audit({ type: 'workflow_completed', identity, workflowId, revision });
    } catch (error) {
      // Completion was committed before the audit append.  Keep the terminal
      // completed state and surface a non-retryable reconciliation signal;
      // executing again will return the completed snapshot without invoking an
      // adapter.
      throw reconciliationError({
        phase: 'workflow_completed',
        cause: error,
        effectMayHaveCommitted: hasMutation,
        outcome: hasMutation ? 'unknown' : 'completed',
      });
    }
    return executionView(workflow);
  }

  status(input) {
    const operation = requireObject(input, 'status input');
    const identity = requireIdentity(operation);
    const workflowId = requireWorkflowId(operation.workflowId);
    const revision = normalizeRevision(operation.revision);
    const workflow = this.store.get({ identity, workflowId, revision });
    // Status is also a public exposure boundary. Validate the live catalog
    // binding and every already-recorded output before returning a snapshot;
    // a legacy store/provider must not leak an output that violates its
    // declared schema merely because no new execution was requested.
    if (workflow?.plan) this.#validateStoredPlan(identity, workflow);
    return executionView(workflow);
  }

  async replayReadonly(input, context = {}) {
    const operation = requireObject(input, 'replayReadonly input');
    const identity = requireIdentity(operation);
    rejectCallerApproval(operation);
    const executionContext = invocationContext(operation.context ?? context);
    const workflowId = requireWorkflowId(operation.workflowId);
    const revision = normalizeRevision(operation.revision);
    const workflow = this.store.get({ identity, workflowId, revision });
    if (!workflow.plan) throw new CoreError('REPLAY_NOT_AVAILABLE', 'Workflow has no recorded plan');
    const plan = this.#validateStoredPlan(identity, workflow);
    const requested = operation.nodeIds ?? operation.nodes;
    const limit = normalizeReplayLimit(operation.limit);
    let nodeIds;
    if (requested === undefined) {
      nodeIds = plan.order.filter((nodeId) => plan.nodes.find((node) => node.id === nodeId)?.readOnly && workflow.nodeStates[nodeId]?.state === 'completed');
    } else {
      if (!Array.isArray(requested) || requested.length === 0) throw new CoreError('INVALID_REPLAY', 'nodeIds must be a non-empty array');
      if (requested.length > MAX_REPLAY_NODES) throw new CoreError('INVALID_REPLAY', `nodeIds may contain at most ${MAX_REPLAY_NODES} entries`);
      nodeIds = [...new Set(requested)];
    }
    nodeIds = nodeIds.slice(0, limit);
    const byId = new Map(plan.nodes.map((node) => [node.id, node]));
    for (const nodeId of nodeIds) {
      if (typeof nodeId !== 'string' || !byId.has(nodeId)) throw new CoreError('REPLAY_NOT_AVAILABLE', `Node ${nodeId} is not recorded`);
      const node = byId.get(nodeId);
      if (!node.readOnly || node.mutates) throw new CoreError('REPLAY_MUTATION_FORBIDDEN', `Mutation node ${nodeId} cannot be replayed`);
      if (workflow.nodeStates[nodeId]?.state !== 'completed') throw new CoreError('REPLAY_NOT_AVAILABLE', `Node ${nodeId} has no completed recording`);
    }
    if (nodeIds.length === 0) throw new CoreError('REPLAY_NOT_AVAILABLE', 'No completed read-only nodes are available for replay');
    const results = [];
    for (const nodeId of nodeIds) {
      const node = byId.get(nodeId);
      const recorded = workflow.nodeStates[nodeId];
      let output;
      try {
        output = await this.#invoke({ identity, workflow, plan, node, operation, replay: true, recordedOutput: recorded.output, context: executionContext });
      } catch (error) {
        const safe = errorShape(error, { code: 'ADAPTER_FAILURE', message: `Replay of ${nodeId} failed`, retryable: true });
        await this.#audit({ type: 'replay_failed', identity, workflowId, revision, nodeId, error: safe });
        throw new CoreError('REPLAY_FAILED', `Replay of node ${nodeId} failed`, { retryable: safe.retryable === true, details: { nodeId, cause: safe }, cause: error });
      }
      results.push({
        nodeId,
        capabilityId: node.capabilityId,
        capabilityVersion: node.capabilityVersion,
        output: normalizeOutput(output),
        readOnly: true,
      });
      await this.#audit({ type: 'replay_completed', identity, workflowId, revision, nodeId });
    }
    this.replaySequence += 1;
    return {
      replayId: `replay-${this.replaySequence}`,
      workflowId,
      revision,
      tenantId: identity.tenantId,
      subjectId: identity.subjectId,
      state: 'completed',
      readOnly: true,
      nodes: results,
    };
  }

  replay(input) {
    return this.replayReadonly(input);
  }

  #validateStoredPlan(identity, workflow) {
    let plan;
    try {
      plan = validatePlan({ identity, plan: workflow.plan });
    } catch (error) {
      if (error instanceof CoreError) throw error;
      throw new CoreError('INVALID_PLAN', 'Stored workflow plan is invalid', { cause: error });
    }
    if (plan.workflowId !== workflow.workflowId || plan.revision !== workflow.revision) throw new CoreError('INVALID_PLAN', 'Stored plan workflow identity is invalid');
    for (const node of plan.nodes) {
      this.#resolveAndValidateNode({ identity, plan, workflow, node, validateStoredOutput: true });
    }
    return plan;
  }

  /**
   * Resolve the live capability descriptor at the security boundary and
   * re-check every execution-relevant binding. This is deliberately called
   * both when loading a stored workflow and immediately before invoking an
   * adapter: policy and approval callbacks may yield while a same-version
   * catalog record is replaced.
   */
  #resolveAndValidateNode({ identity, plan, workflow, node, validateStoredOutput = false }) {
    let descriptor;
    try {
      descriptor = this.catalog.resolve({ identity, capabilityId: node.capabilityId, version: node.capabilityVersion });
    } catch (error) {
      if (error instanceof CoreError) throw error;
      throw new CoreError('INVALID_PLAN', `Node ${node.id} capability could not be resolved`, { cause: error });
    }

    let schemas;
    try {
      schemas = assertCapabilitySchemas({ capability: descriptor, label: `Capability ${node.capabilityId}` });
    } catch (error) {
      throw new CoreError('INVALID_PLAN', `Node ${node.id} capability schema is invalid`, {
        retryable: false,
        details: {
          reason: 'CAPABILITY_SCHEMA_INVALID',
          ...(error instanceof CoreError ? { cause: error.toJSON() } : {}),
        },
        cause: error,
      });
    }

    let bindingHash;
    try {
      bindingHash = capabilityBindingHash(descriptor);
    } catch (error) {
      throw new CoreError('INVALID_PLAN', `Node ${node.id} capability binding is invalid`, { cause: error });
    }
    if (node.capabilityBindingHash !== bindingHash) {
      throw new CoreError('INVALID_PLAN', `Node ${node.id} capability binding no longer matches the catalog`, {
        details: { reason: 'CAPABILITY_BINDING_DRIFT', nodeId: node.id },
      });
    }
    if (descriptor.readOnly !== node.readOnly || descriptor.mutates !== node.mutates) {
      throw new CoreError('INVALID_PLAN', `Node ${node.id} mutability no longer matches catalog`);
    }
    const adapters = Array.isArray(descriptor.adapters)
      ? descriptor.adapters.map((entry) => typeof entry === 'string' ? entry : entry?.id)
      : [];
    if (node.adapter !== undefined && !adapters.includes(node.adapter)) {
      throw new CoreError('INVALID_PLAN', `Node ${node.id} adapter no longer matches catalog`);
    }
    const origins = Array.isArray(descriptor.origins)
      ? descriptor.origins
      : descriptor.origin === undefined ? [] : [descriptor.origin];
    if (node.origin !== undefined && !origins.includes(node.origin)) {
      throw new CoreError('INVALID_PLAN', `Node ${node.id} origin no longer matches catalog`);
    }

    assertSchemaValue({
      value: node.args,
      schema: schemas.inputSchema,
      code: 'INVALID_PLAN',
      reason: 'ARGUMENT_SCHEMA_INVALID',
      label: `Arguments for node ${node.id}`,
      message: `Arguments for node ${node.id} do not match the capability input schema`,
    });

    if (validateStoredOutput && workflow?.nodeStates?.[node.id]?.state === 'completed') {
      assertSchemaValue({
        value: workflow.nodeStates[node.id].output,
        schema: schemas.outputSchema,
        code: 'INVALID_PLAN',
        reason: 'STORED_OUTPUT_SCHEMA_INVALID',
        label: `Stored output for node ${node.id}`,
        message: `Stored output for node ${node.id} does not match the capability output schema`,
      });
    }
    return descriptor;
  }

  #assertDependenciesCompleted(plan, workflow, node) {
    for (const dependency of node.dependsOn) {
      if (workflow.nodeStates[dependency]?.state !== 'completed') {
        throw new CoreError('WORKFLOW_DEPENDENCY', `Node ${node.id} dependency ${dependency} is not complete`);
      }
    }
  }

  async #approvalFor({ identity, workflow, node, operation }) {
    const binding = approvalBinding({ identity, workflow, node });
    if (typeof node.origin !== 'string' || !node.origin || typeof node.adapter !== 'string' || !node.adapter) {
      throw new CoreError('APPROVAL_CONTEXT_REQUIRED', `Mutating node ${node.id} must bind origin and adapter`);
    }
    const credential = await this.#resolveApprovalCredential(binding);
    const policy = await this.#evaluatePolicy({ identity, workflow, node, credential });
    if (policy.approvalMissing) return false;

    let verifier = this.approvalVerifier;
    let verifierKind = verifier ? 'custom' : undefined;
    if (!verifier && this.approvalStore) {
      if (typeof this.approvalStore === 'function') {
        verifier = this.approvalStore;
        verifierKind = 'custom';
      } else if (typeof this.approvalStore.verifyAndConsume === 'function') {
        verifier = this.approvalStore.verifyAndConsume.bind(this.approvalStore);
        verifierKind = 'one-object';
      } else if (typeof this.approvalStore.consume === 'function') {
        verifier = this.approvalStore.consume.bind(this.approvalStore);
        verifierKind = 'consume';
      }
    }
    if (!verifier) return false;
    try {
      const candidate = {
        ...binding,
        args: jsonClone(node.args),
        argumentHash: binding.argumentHash,
        canonicalArgumentHash: binding.argumentHash,
        // A verifier may use this to check expiry with an injected clock.  It
        // is server derived, never caller supplied.
        now: this.#now(),
        operation: 'consume',
      };
      if (credential !== undefined && credential !== null) candidate.approval = jsonClone(credential);
      let result;
      // ApprovalAuthority.consume(binding, credential) needs the original args
      // so it can recompute the hash at the security boundary.  One-object
      // stores receive a nested credential and binding-compatible object.
      if (verifierKind === 'consume' && credential !== undefined && credential !== null && verifier.length >= 2) {
        result = await verifier(candidate, credential, { now: this.#now() });
      } else {
        result = await verifier(candidate);
      }
      return result === true || result?.approved === true || result?.valid === true || result?.consumed === true;
    } catch (error) {
      if (error instanceof CoreError && APPROVAL_MISS_CODES.has(error.code)) return false;
      throw new CoreError('APPROVAL_CHECK_FAILED', 'Approval verification failed', { retryable: true, cause: error });
    }
  }

  async #resolveApprovalCredential(binding) {
    if (this.approvalCredentialResolver !== undefined) {
      if (typeof this.approvalCredentialResolver === 'function') {
        return this.approvalCredentialResolver({ ...binding, binding: { ...binding } });
      }
      return this.approvalCredentialResolver;
    }
    return this.approvalCredential;
  }

  async #invoke({ identity, workflow, plan, node, operation, replay, recordedOutput, context = {}, onInvocationStart }) {
    // Re-resolve immediately before authorization/invocation. The first
    // check happens while loading the stored plan, but policy and approval
    // callbacks are asynchronous and may observe a changed catalog.
    let capability = this.#resolveAndValidateNode({ identity, plan, workflow, node });
    const adapterId = node.adapter;
    const origin = node.origin;
    if (operation.adapter !== undefined && operation.adapter !== adapterId) throw new CoreError('EXECUTION_CONTEXT', 'Caller adapter does not match the proposed plan');
    if (operation.origin !== undefined && !sameCanonicalOrigin(operation.origin, origin)) throw new CoreError('EXECUTION_CONTEXT', 'Caller origin does not match the proposed plan');
    if (node.readOnly) {
      await this.#evaluatePolicy({ identity, workflow, node });
      // A policy implementation is trusted constructor state, but it may
      // yield while a catalog record is replaced. Rebind the descriptor after
      // the callback and before selecting/invoking the adapter.
      capability = this.#resolveAndValidateNode({ identity, plan, workflow, node });
    }
    const adapter = await this.#resolveAdapter({ adapterId, origin, node, identity, replay });
    // Adapter resolution is another asynchronous trust boundary. A resolver
    // must not be able to swap the same id/version schema after the final
    // catalog check and still receive provider arguments.
    capability = this.#resolveAndValidateNode({ identity, plan, workflow, node });
    const request = {
      capabilityId: node.capabilityId,
      capabilityVersion: node.capabilityVersion,
      args: jsonClone(node.args),
      identity: { tenantId: identity.tenantId, subjectId: identity.subjectId },
      tenantId: identity.tenantId,
      subjectId: identity.subjectId,
      workflowId: workflow.workflowId,
      revision: workflow.revision,
      nodeId: node.id,
      adapter: adapterId,
      origin,
      readOnly: node.readOnly,
      replay,
      recordedOutput: replay ? normalizeOutput(recordedOutput) : null,
      plan: {
        workflowId: plan.workflowId,
        revision: plan.revision,
        planHash: plan.planHash,
      },
    };
    // AbortSignal is a cooperative read-side hint.  It is intentionally not
    // attached to mutation requests: a cancellation notification must never
    // race an already-authorized side effect or pretend that it was rolled
    // back.  The broker/adapter boundary receives the live signal object so an
    // adapter can stop at a safe semantic checkpoint if it supports aborts.
    if (node.readOnly && context?.signal !== undefined) {
      request.context = { signal: context.signal };
    }
    const invokeTrustedAdapter = (call) => {
      if (typeof onInvocationStart === 'function') onInvocationStart();
      return this.#withTimeout(Promise.resolve().then(call), node.timeoutMs);
    };
    let output;
    if (typeof adapter === 'function') {
      // Functions can only come from the trusted broker constructor/resolver,
      // never from a plan or provider metadata.
      output = await invokeTrustedAdapter(() => adapter(request));
    } else if (adapter && typeof adapter.execute === 'function') {
      output = await invokeTrustedAdapter(() => adapter.execute(request));
    } else if (adapter && typeof adapter.invoke === 'function') {
      output = await invokeTrustedAdapter(() => adapter.invoke(request));
    } else if (typeof this.executor === 'function') {
      output = await invokeTrustedAdapter(() => this.executor(request));
    } else if (this.executor && typeof this.executor.execute === 'function') {
      output = await invokeTrustedAdapter(() => this.executor.execute(request));
    } else {
      throw new CoreError('ADAPTER_UNAVAILABLE', `No executor is configured for adapter ${adapterId ?? '(none)'}`, { retryable: true });
    }
    const normalized = normalizeOutput(output);
    assertSchemaValue({
      value: normalized,
      schema: capability.outputSchema,
      code: 'OUTPUT_SCHEMA_INVALID',
      reason: 'OUTPUT_SCHEMA_INVALID',
      label: `Output for node ${node.id}`,
      message: `Output for node ${node.id} does not match the capability output schema`,
    });
    return normalized;
  }

  async #evaluatePolicy({ identity, workflow, node, credential }) {
    if (!this.policy) return { allowed: true };
    const binding = approvalBinding({ identity, workflow, node });
    const request = {
      ...binding,
      capability: node.capabilityId,
      // Action is a tiny trusted policy vocabulary, not a provider- or
      // plan-supplied operation label.  The stored plan's mutability has
      // already been checked against the catalog binding, so a rehashed plan
      // cannot relabel a write as an arbitrary capability name and bypass a
      // denyActions: ['write'] rule.
      action: node.readOnly ? 'read' : 'write',
      mutation: !node.readOnly,
      ...(credential === undefined || credential === null ? {} : { approval: jsonClone(credential) }),
    };
    let result;
    try {
      const method = typeof this.policy.evaluate === 'function'
        ? this.policy.evaluate
        : this.policy.check;
      result = await method.call(this.policy, request);
    } catch (error) {
      throw new CoreError('POLICY_DENIED', 'Policy evaluation failed closed', {
        retryable: false,
        cause: error,
      });
    }
    if (result === true || result?.allowed === true) return result;
    const code = typeof result?.code === 'string' ? result.code : 'POLICY_DENIED';
    if (!node.readOnly && APPROVAL_MISS_CODES.has(code)) return { approvalMissing: true, code };
    throw new CoreError('POLICY_DENIED', 'Policy denied workflow node', {
      retryable: false,
      details: {
        policyCode: code,
        ...(typeof result?.ruleId === 'string' ? { ruleId: result.ruleId } : {}),
      },
    });
  }

  #failBeforeInvocation({ identity, workflowId, revision, nodeId, error }) {
    const safe = errorShape(error, {
      code: 'POLICY_DENIED',
      message: `Policy denied node ${nodeId}`,
      retryable: false,
    });
    try {
      const current = this.store.get({ identity, workflowId, revision });
      if (!TERMINAL_WORKFLOW_STATES.has(current.state)) {
        this.store.fail({ identity, workflowId, revision, error: safe });
      }
    } catch {
      // The policy decision still fails closed even if a non-standard store
      // cannot persist the diagnostic terminal state.
    }
  }

  async #resolveAdapter({ adapterId, origin, node, identity, replay }) {
    if (this.adapterResolver) {
      if (typeof this.adapterResolver !== 'function') throw new CoreError('INVALID_EXECUTION', 'adapterResolver must be a function');
      const value = await this.adapterResolver({ adapterId, origin, capabilityId: node.capabilityId, identity: { ...identity }, replay });
      if (value !== undefined && value !== null) return value;
    }
    if (this.adapters instanceof Map) {
      const value = this.adapters.get(adapterId);
      if (value !== undefined) return value;
    } else if (this.adapters && typeof this.adapters === 'object' && adapterId && this.adapters[adapterId] !== undefined) {
      return this.adapters[adapterId];
    }
    return undefined;
  }

  async #audit(event) {
    if (!this.audit) return;
    const safe = jsonClone({ at: this.#now(), ...event });
    try {
      if (typeof this.audit === 'function') await this.audit(safe);
      else if (typeof this.audit.append === 'function') await this.audit.append(safe);
      else if (typeof this.audit.record === 'function') await this.audit.record(safe);
      else throw new Error('Unsupported audit sink');
    } catch (error) {
      throw new CoreError('AUDIT_FAILURE', 'Audit record could not be appended', { retryable: true, cause: error });
    }
  }

  #terminalizeReconciliation({ identity, workflowId, revision, nodeId, phase, cause, executionKey, effectMayHaveCommitted, outcome }) {
    const error = reconciliationError({ nodeId, phase, cause, effectMayHaveCommitted, outcome });
    let terminalized = false;
    try {
      const current = this.store.get({ identity, workflowId, revision });
      if (TERMINAL_WORKFLOW_STATES.has(current.state)) {
        terminalized = true;
      } else {
        this.store.fail({ identity, workflowId, revision, error: error.toJSON() });
        terminalized = true;
      }
    } catch (terminalizationError) {
      // Never replace the unknown-outcome signal with a retryable store or
      // audit error.  A normal store transitions the workflow to a terminal
      // reconciliation state; a non-standard store that cannot do so still
      // leaves the original unknown-outcome error visible to the caller.
      if (terminalizationError !== cause) error.terminalizationCause = terminalizationError;
    }
    if (!terminalized && executionKey) this.reconciliationExecutions.set(executionKey, error);
    return error;
  }

  #now() {
    const value = this.clock();
    if (value instanceof Date) return value.toISOString();
    if (typeof value === 'number' && Number.isFinite(value)) return new Date(value).toISOString();
    if (typeof value === 'string' && value.length) return value;
    throw new CoreError('INVALID_CLOCK', 'Execution clock must return a timestamp');
  }

  async #withTimeout(promise, timeoutMs) {
    if (timeoutMs === undefined) return promise;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new CoreError('EXECUTION_TIMEOUT', 'Capability execution timed out', { retryable: true })), timeoutMs);
      promise.then((value) => {
        clearTimeout(timer);
        resolve(value);
      }, (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
  }
}

function normalizeReplayLimit(value) {
  if (value === undefined) return MAX_REPLAY_NODES;
  if (!Number.isInteger(value) || value < 1 || value > MAX_REPLAY_NODES) {
    throw new CoreError('INVALID_REPLAY', `limit must be an integer from 1 to ${MAX_REPLAY_NODES}`);
  }
  return value;
}

export function approvalBinding({ identity, workflow, node }) {
  const argumentHash = node.argumentHash ?? canonicalHash(node.args);
  return {
    tenantId: identity.tenantId,
    subjectId: identity.subjectId,
    identity: { tenantId: identity.tenantId, subjectId: identity.subjectId },
    workflowId: workflow.workflowId,
    revision: workflow.revision,
    nodeId: node.id,
    origin: node.origin,
    adapter: node.adapter,
    capabilityId: node.capabilityId,
    capabilityVersion: node.capabilityVersion,
    args: jsonClone(node.args),
    argsHash: argumentHash,
    argumentHash,
    canonicalArgsHash: argumentHash,
  };
}

export function approvalRequest({ identity, workflow, node }) {
  const binding = approvalBinding({ identity, workflow, node });
  const { args: _args, ...publicBinding } = binding;
  return {
    ...publicBinding,
    expiresAt: null,
    // The request is a description for a trusted approval UI/store.  It is not
    // itself an approval and is never accepted from workflow.execute input.
    status: 'required',
  };
}

function executionView(workflow, extras = {}) {
  const value = jsonClone(workflow);
  value.id = value.workflowId;
  value.status = value.state;
  value.subject = value.subjectId;
  value.cursor = value.plan?.order?.filter((nodeId) => value.nodeStates?.[nodeId]?.state === 'completed').length ?? 0;
  const results = Object.values(value.nodeStates ?? {})
    .filter((node) => node.state === 'completed')
    .sort((left, right) => left.nodeId.localeCompare(right.nodeId))
    .map((node) => ({ nodeId: node.nodeId, output: node.output }));
  return { ...value, results, ...jsonClone(extras) };
}

function normalizeOutput(value) {
  return value === undefined ? null : jsonClone(value);
}

function reconciliationError({ nodeId, phase, cause, effectMayHaveCommitted = true, outcome = 'unknown' }) {
  return new CoreError(
    'RECONCILIATION_REQUIRED',
    'Execution outcome is unknown; manual reconciliation is required',
    {
      retryable: false,
      details: {
        // The broker knows when a trusted mutation invocation crossed the
        // side-effect boundary, but cannot prove whether a provider committed
        // before returning or throwing.  Keep the record explicitly unknown;
        // callers must reconcile it instead of retrying implicitly.
        effectMayHaveCommitted: effectMayHaveCommitted === true,
        outcome,
        phase,
        ...(nodeId === undefined ? {} : { nodeId }),
      },
      cause,
    },
  );
}

function requireWorkflowId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:@/+\-]{0,199}$/.test(value)) throw new CoreError('INVALID_WORKFLOW', 'workflowId is invalid');
  return value;
}

function normalizeRevision(value) {
  const revision = value ?? 1;
  if (!Number.isInteger(revision) || revision < 1 || revision > 2_147_483_647) throw new CoreError('INVALID_WORKFLOW', 'revision must be a positive integer');
  return revision;
}

function rejectCallerApproval(operation) {
  for (const key of ['approval', 'approvals', 'approvalRecord', 'approvalToken', 'nonce']) {
    if (operation[key] !== undefined) throw new CoreError('UNTRUSTED_APPROVAL', 'Approvals must come from the trusted server-side approval store');
  }
}

function requireObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CoreError('INVALID_INPUT', `${label} must be an object`);
  return value;
}

function invocationContext(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value;
}

function normalizeExecutionConstraints(operation) {
  const origin = operation.origin === undefined
    ? undefined
    : canonicalExecutionOrigin(operation.origin);
  const adapter = operation.adapter === undefined
    ? undefined
    : canonicalExecutionAdapter(operation.adapter);
  return { origin, adapter };
}

function applyExecutionConstraints(operation, constraints) {
  if (constraints.origin === operation.origin && constraints.adapter === operation.adapter) return operation;
  return {
    ...operation,
    ...(constraints.origin === undefined ? {} : { origin: constraints.origin }),
    ...(constraints.adapter === undefined ? {} : { adapter: constraints.adapter }),
  };
}

function executionKeyFor({ identity, workflowId, revision, constraints }) {
  // Context constraints are validated before this key is consulted.  Keep
  // idempotency and the reconciliation no-reinvoke guard workflow-scoped so
  // an omitted origin/adapter cannot evade a guard by retrying with the
  // explicit planned values.  `constraints` remains an input here for a
  // single canonical call shape and to make the non-partitioning intentional.
  void constraints;
  return `${identityKey(identity)}:${encodeURIComponent(workflowId)}:${revision}`;
}

function assertExecutionContext({ operation, plan, constraints }) {
  if (!plan || !Array.isArray(plan.nodes)) return;
  for (const node of plan.nodes) {
    if (constraints.adapter !== undefined && constraints.adapter !== node.adapter) {
      throw new CoreError('EXECUTION_CONTEXT', `Caller adapter does not match the proposed plan for node ${node.id}`);
    }
    if (constraints.origin !== undefined && !sameCanonicalOrigin(constraints.origin, node.origin)) {
      throw new CoreError('EXECUTION_CONTEXT', `Caller origin does not match the proposed plan for node ${node.id}`);
    }
  }
}

function canonicalExecutionAdapter(value) {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new CoreError('EXECUTION_CONTEXT', 'Caller adapter is invalid');
  }
  return value;
}

function canonicalExecutionOrigin(value) {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new CoreError('EXECUTION_CONTEXT', 'Caller origin is invalid');
  }
  try {
    const parsed = new URL(value);
    if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.username || parsed.password ||
        parsed.pathname !== '/' || parsed.search || parsed.hash || !parsed.hostname) {
      throw new Error('origin must be an HTTP(S) origin');
    }
    return parsed.origin;
  } catch (error) {
    throw new CoreError('EXECUTION_CONTEXT', 'Caller origin is invalid', { cause: error });
  }
}

function sameCanonicalOrigin(left, right) {
  if (left === undefined || right === undefined) return left === right;
  try {
    return canonicalExecutionOrigin(left) === canonicalExecutionOrigin(right);
  } catch {
    return false;
  }
}
