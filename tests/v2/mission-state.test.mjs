import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MISSION_EVENTS as EVENT,
  MISSION_NODE_STATUS as NODE_STATUS,
  MISSION_PHASES as PHASE,
  MissionStateError,
  createMissionState,
  reduceMissionEvents,
  selectActiveEdgeIds,
  selectAllowedActions,
  selectMissionProgress,
  transitionMission,
} from '../../src/app/mission-state.js';

const NODES = [
  { id: 'start', trackProgress: false },
  { id: 'discover', label: 'Discover WebMCP tools' },
  { id: 'map', label: 'Map capabilities' },
  { id: 'health', label: 'Read service health' },
  { id: 'release', label: 'Read release history' },
  { id: 'deployment', label: 'Read deployment history' },
  { id: 'notice', label: 'Read status notice' },
  { id: 'review', label: 'Correlate and prepare' },
  { id: 'apply', label: 'Apply recovery' },
  { id: 'publish', label: 'Publish notice' },
  { id: 'complete-anchor', trackProgress: false },
];

const EDGES = [
  { id: 'start-discover', from: 'start', to: 'discover' },
  { id: 'discover-map', from: 'discover', to: 'map' },
  { id: 'map-health', from: 'map', to: 'health' },
  { id: 'map-release', from: 'map', to: 'release' },
  { id: 'map-deployment', from: 'map', to: 'deployment' },
  { id: 'map-notice', from: 'map', to: 'notice' },
  { id: 'health-review', from: 'health', to: 'review' },
  { id: 'release-review', from: 'release', to: 'review' },
  { id: 'deployment-review', from: 'deployment', to: 'review' },
  { id: 'notice-review', from: 'notice', to: 'review' },
  { id: 'review-apply', from: 'review', to: 'apply' },
  { id: 'review-publish', from: 'review', to: 'publish' },
  { id: 'apply-complete', from: 'apply', to: 'complete-anchor' },
  { id: 'publish-complete', from: 'publish', to: 'complete-anchor' },
];

const TOOLS = [
  { id: 'health-a', origin: 'https://health.example', name: 'probe_service' },
  { id: 'health-b', origin: 'https://backup.example', name: 'inspect_health' },
  { id: 'release-a', origin: 'https://source.example', name: 'trace_changes' },
  { id: 'deploy-a', origin: 'https://deploy.example', name: 'list_rollouts' },
  { id: 'notice-read-a', origin: 'https://status.example', name: 'read_active_notice' },
  { id: 'apply-a', origin: 'https://deploy.example', name: 'apply_recovery' },
  { id: 'publish-a', origin: 'https://status.example', name: 'publish_update' },
  { id: 'adversarial', origin: 'https://unsafe.example', name: 'override_approval' },
];

const MAPPINGS = {
  health: { primaryToolId: 'health-a', alternativeToolIds: ['health-b'] },
  release: { primaryToolId: 'release-a', alternativeToolIds: [] },
  deployment: { primaryToolId: 'deploy-a', alternativeToolIds: [] },
  notice: { primaryToolId: 'notice-read-a', alternativeToolIds: [] },
  apply: { primaryToolId: 'apply-a', alternativeToolIds: [] },
  publish: { primaryToolId: 'publish-a', alternativeToolIds: [] },
};

function initialState() {
  return createMissionState({
    missionId: 'checkout-recovery',
    objective: 'Restore checkout safely and prepare a customer update.',
    nodes: NODES,
    edges: EDGES,
    stages: {
      discovery: ['discover'],
      mapping: ['map'],
      reads: ['health', 'release', 'deployment', 'notice'],
      review: ['review'],
    },
    approvalScopes: {
      apply: ['apply'],
      publish: ['publish'],
    },
    metadata: { fixture: 'injected-recovery-data' },
  });
}

function toMapping(state = initialState()) {
  return reduceMissionEvents(state, [
    { type: EVENT.START },
    { type: EVENT.DISCOVERY_RESULT, tools: TOOLS, generation: 7 },
    { type: EVENT.TOOL_QUARANTINED, toolId: 'adversarial', reason: 'approval bypass language' },
    { type: EVENT.DISCOVERY_COMPLETED },
  ]);
}

function toReview(state = initialState()) {
  return reduceMissionEvents(toMapping(state), [
    { type: EVENT.MAPPING_COMPLETED, mappings: MAPPINGS },
    { type: EVENT.PARALLEL_READS_STARTED },
    { type: EVENT.READ_NODE_COMPLETED, nodeId: 'health' },
    { type: EVENT.READ_NODE_COMPLETED, nodeId: 'release' },
    { type: EVENT.READ_NODE_COMPLETED, nodeId: 'deployment' },
    { type: EVENT.READ_NODE_COMPLETED, nodeId: 'notice' },
    { type: EVENT.PREPARATION_COMPLETED, planRevision: 1 },
  ]);
}

function errorCode(code) {
  return (error) => error instanceof MissionStateError && error.code === code;
}

test('creates an immutable, provider-neutral idle state with derived selectors', () => {
  const state = initialState();

  assert.equal(state.phase, PHASE.IDLE);
  assert.equal(state.revision, 1);
  assert.deepEqual(state.audit, []);
  assert.deepEqual(selectActiveEdgeIds(state), []);
  assert.deepEqual(selectAllowedActions(state), [EVENT.START]);
  assert.deepEqual(selectMissionProgress(state), {
    completed: 0,
    failed: 0,
    running: 0,
    total: 9,
    percent: 0,
    phase: PHASE.IDLE,
  });
  assert.equal(Object.isFrozen(state), true);
  assert.equal(Object.isFrozen(state.nodes), true);
  assert.equal(Object.isFrozen(state.nodes[0]), true);
});

test('runs discovery, quarantine, semantic mapping, parallel reads, failover, separate approvals, and execution', () => {
  let state = initialState();

  state = transitionMission(state, { type: EVENT.START });
  assert.equal(state.phase, PHASE.DISCOVERING);
  assert.deepEqual(selectActiveEdgeIds(state), ['start-discover']);

  state = transitionMission(state, { type: EVENT.DISCOVERY_RESULT, tools: TOOLS, generation: 7 });
  state = transitionMission(state, {
    type: EVENT.TOOL_QUARANTINED,
    toolId: 'adversarial',
    reason: 'approval bypass language',
  });
  assert.equal(state.quarantine.adversarial.reason, 'approval bypass language');

  state = transitionMission(state, { type: EVENT.DISCOVERY_COMPLETED });
  assert.equal(state.phase, PHASE.MAPPING);
  assert.deepEqual(selectActiveEdgeIds(state), ['discover-map']);

  state = transitionMission(state, { type: EVENT.MAPPING_COMPLETED, mappings: MAPPINGS });
  assert.equal(state.mappings.health.primaryToolId, 'health-a');
  assert.ok(selectAllowedActions(state).includes(EVENT.PARALLEL_READS_STARTED));

  state = transitionMission(state, { type: EVENT.PARALLEL_READS_STARTED });
  assert.equal(state.phase, PHASE.READING);
  assert.deepEqual(selectActiveEdgeIds(state), [
    'map-deployment',
    'map-health',
    'map-notice',
    'map-release',
  ]);

  state = transitionMission(state, { type: EVENT.READ_NODE_FAILED, nodeId: 'health', error: 'provider unavailable' });
  assert.ok(selectAllowedActions(state).includes(EVENT.PROVIDER_SWAPPED));
  state = transitionMission(state, {
    type: EVENT.PROVIDER_SWAPPED,
    nodeId: 'health',
    fromToolId: 'health-a',
    toToolId: 'health-b',
    reason: 'read-only provider failed',
  });
  assert.equal(state.mappings.health.primaryToolId, 'health-b');
  assert.equal(state.nodes.find((node) => node.id === 'health').status, NODE_STATUS.RUNNING);
  assert.deepEqual(selectActiveEdgeIds(state), ['map-health']);

  for (const nodeId of ['health', 'release', 'deployment', 'notice']) {
    state = transitionMission(state, { type: EVENT.READ_NODE_COMPLETED, nodeId });
  }
  assert.equal(state.phase, PHASE.PREPARING);
  assert.equal(state.nodes.find((node) => node.id === 'review').status, NODE_STATUS.RUNNING);
  state = transitionMission(state, { type: EVENT.PREPARATION_COMPLETED, planRevision: 1 });
  assert.equal(state.phase, PHASE.REVIEW);
  assert.equal(state.nodes.find((node) => node.id === 'review').status, NODE_STATUS.COMPLETED);
  assert.deepEqual(selectActiveEdgeIds(state), ['review-apply', 'review-publish']);

  state = transitionMission(state, { type: EVENT.NODE_SELECTED, nodeId: 'apply' });
  assert.equal(state.selectedNodeId, 'apply');
  state = transitionMission(state, {
    type: EVENT.APPLY_APPROVED,
    approvalId: 'approval-apply-1',
    nodeIds: ['apply'],
  });
  assert.equal(state.phase, PHASE.REVIEW);
  assert.equal(state.approvals.apply.granted, true);
  assert.equal(state.approvals.publish.granted, false);
  assert.deepEqual(selectActiveEdgeIds(state), ['review-apply']);

  state = transitionMission(state, {
    type: EVENT.PUBLISH_APPROVED,
    approvalId: 'approval-publish-1',
    nodeIds: ['publish'],
  });
  assert.equal(state.phase, PHASE.APPROVED);
  assert.deepEqual(selectActiveEdgeIds(state), ['review-publish']);

  state = transitionMission(state, { type: EVENT.EXECUTION_STARTED, nodeIds: ['publish', 'apply'] });
  assert.equal(state.phase, PHASE.EXECUTING);
  assert.deepEqual(selectActiveEdgeIds(state), ['review-apply', 'review-publish']);

  state = transitionMission(state, { type: EVENT.EXECUTION_NODE_COMPLETED, nodeId: 'apply' });
  assert.equal(state.phase, PHASE.EXECUTING);
  assert.deepEqual(selectActiveEdgeIds(state), ['apply-complete']);
  state = transitionMission(state, { type: EVENT.EXECUTION_NODE_COMPLETED, nodeId: 'publish' });
  assert.equal(state.phase, PHASE.COMPLETE);
  assert.deepEqual(selectActiveEdgeIds(state), ['publish-complete']);
  assert.deepEqual(selectMissionProgress(state), {
    completed: 9,
    failed: 0,
    running: 0,
    total: 9,
    percent: 100,
    phase: PHASE.COMPLETE,
  });
  assert.equal(state.audit.at(-1).sequence, state.audit.length);
  assert.equal(state.audit.at(-1).phaseTo, PHASE.COMPLETE);
});

test('rejects invalid transitions without modifying the frozen source state', () => {
  const state = initialState();
  const snapshot = structuredClone(state);

  assert.throws(
    () => transitionMission(state, { type: EVENT.PARALLEL_READS_STARTED }),
    errorCode('INVALID_TRANSITION'),
  );
  assert.throws(
    () => transitionMission(state, { type: 'provider.magic.branch' }),
    errorCode('EVENT_UNKNOWN'),
  );
  assert.deepEqual(state, snapshot);
  assert.deepEqual(state.audit, []);
});

test('fails closed when mapping selects a quarantined tool or omits a capability node', () => {
  const mappingState = toMapping();
  const quarantinedMapping = {
    ...MAPPINGS,
    health: { primaryToolId: 'adversarial', alternativeToolIds: ['health-a'] },
  };

  assert.throws(
    () => transitionMission(mappingState, { type: EVENT.MAPPING_COMPLETED, mappings: quarantinedMapping }),
    errorCode('MAPPING_QUARANTINED'),
  );
  const { publish, ...incomplete } = MAPPINGS;
  assert.throws(
    () => transitionMission(mappingState, { type: EVENT.MAPPING_COMPLETED, mappings: incomplete }),
    errorCode('MAPPING_INCOMPLETE'),
  );
  assert.equal(mappingState.phase, PHASE.MAPPING);
  assert.deepEqual(mappingState.mappings, {});
});

test('permits provider substitution only after a failed read and never for mutation nodes', () => {
  let state = transitionMission(toMapping(), { type: EVENT.MAPPING_COMPLETED, mappings: MAPPINGS });
  state = transitionMission(state, { type: EVENT.PARALLEL_READS_STARTED });

  assert.throws(
    () => transitionMission(state, {
      type: EVENT.PROVIDER_SWAPPED,
      nodeId: 'health',
      fromToolId: 'health-a',
      toToolId: 'health-b',
    }),
    errorCode('PROVIDER_SWAP_FORBIDDEN'),
  );
  state = transitionMission(state, { type: EVENT.READ_NODE_FAILED, nodeId: 'health' });
  assert.throws(
    () => transitionMission(state, {
      type: EVENT.PROVIDER_SWAPPED,
      nodeId: 'apply',
      fromToolId: 'apply-a',
      toToolId: 'health-b',
    }),
    errorCode('PROVIDER_SWAP_FORBIDDEN'),
  );
});

test('requires both independent approvals and exact approved execution scope', () => {
  let state = toReview();
  state = transitionMission(state, { type: EVENT.APPLY_APPROVED, nodeIds: ['apply'] });

  assert.equal(state.phase, PHASE.REVIEW);
  assert.throws(
    () => transitionMission(state, { type: EVENT.EXECUTION_STARTED }),
    errorCode('INVALID_TRANSITION'),
  );
  assert.throws(
    () => transitionMission(state, { type: EVENT.APPLY_APPROVED, nodeIds: ['apply'] }),
    errorCode('APPROVAL_DUPLICATE'),
  );

  state = transitionMission(state, { type: EVENT.PUBLISH_APPROVED, nodeIds: ['publish'] });
  assert.throws(
    () => transitionMission(state, { type: EVENT.EXECUTION_STARTED, nodeIds: ['apply'] }),
    errorCode('EXECUTION_SCOPE_INVALID'),
  );
  assert.equal(state.phase, PHASE.APPROVED);
});

test('fails closed when preparation fails before the human checkpoint', () => {
  let state = reduceMissionEvents(toMapping(), [
    { type: EVENT.MAPPING_COMPLETED, mappings: MAPPINGS },
    { type: EVENT.PARALLEL_READS_STARTED },
    { type: EVENT.READ_NODE_COMPLETED, nodeId: 'health' },
    { type: EVENT.READ_NODE_COMPLETED, nodeId: 'release' },
    { type: EVENT.READ_NODE_COMPLETED, nodeId: 'deployment' },
    { type: EVENT.READ_NODE_COMPLETED, nodeId: 'notice' },
  ]);

  assert.equal(state.phase, PHASE.PREPARING);
  state = transitionMission(state, { type: EVENT.PREPARATION_FAILED, error: 'quote could not be prepared' });
  assert.equal(state.phase, PHASE.PREPARING);
  assert.equal(state.nodes.find((node) => node.id === 'review').status, NODE_STATUS.FAILED);
  assert.deepEqual(selectAllowedActions(state), [EVENT.NODE_SELECTED, EVENT.RESET]);
  assert.throws(
    () => transitionMission(state, { type: EVENT.APPLY_APPROVED, nodeIds: ['apply'] }),
    errorCode('INVALID_TRANSITION'),
  );
  state = transitionMission(state, { type: EVENT.RESET });
  assert.equal(state.phase, PHASE.IDLE);
});

test('invalidation clears approvals and stale work before returning to mapping', () => {
  let state = toReview();
  state = transitionMission(state, { type: EVENT.APPLY_APPROVED, approvalId: 'a-1' });
  const beforeRevision = state.revision;
  state = transitionMission(state, {
    type: EVENT.PLAN_INVALIDATED,
    reason: 'WebMCP toolchange generation advanced',
  });

  assert.equal(state.phase, PHASE.MAPPING);
  assert.equal(state.revision, beforeRevision + 1);
  assert.equal(state.discovery.completed, true);
  assert.deepEqual(state.mappings, {});
  assert.equal(state.approvals.apply.granted, false);
  assert.equal(state.approvals.publish.granted, false);
  assert.equal(state.nodes.find((node) => node.id === 'health').status, NODE_STATUS.PENDING);
  assert.equal(state.nodes.find((node) => node.id === 'map').status, NODE_STATUS.RUNNING);
});

test('audit is deterministic for identical initial data and event sequences', () => {
  const events = [
    { type: EVENT.START },
    { type: EVENT.DISCOVERY_RESULT, tools: TOOLS, generation: 7 },
    { type: EVENT.TOOL_QUARANTINED, toolId: 'adversarial', reason: 'approval bypass language' },
    { type: EVENT.DISCOVERY_COMPLETED },
    { type: EVENT.MAPPING_COMPLETED, mappings: MAPPINGS },
  ];
  const first = reduceMissionEvents(initialState(), events);
  const second = reduceMissionEvents(initialState(), structuredClone(events));

  assert.deepEqual(first.audit, second.audit);
  assert.deepEqual(first.audit.map((entry) => entry.sequence), [1, 2, 3, 4, 5]);
  assert.equal(first.audit.every((entry) => !('timestamp' in entry)), true);
});

test('reset returns to idle while retaining an append-only audit trail', () => {
  let state = toReview();
  const priorAuditLength = state.audit.length;
  state = transitionMission(state, { type: EVENT.RESET });

  assert.equal(state.phase, PHASE.IDLE);
  assert.equal(state.audit.length, priorAuditLength + 1);
  assert.equal(state.audit.at(-1).type, EVENT.RESET);
  assert.equal(state.audit.at(-1).phaseFrom, PHASE.REVIEW);
  assert.deepEqual(state.discovery.tools, []);
  assert.deepEqual(state.mappings, {});
  assert.deepEqual(selectActiveEdgeIds(state), []);
  assert.deepEqual(selectAllowedActions(state), [EVENT.START]);
  assert.equal(selectMissionProgress(state).percent, 0);
});
