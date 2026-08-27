import { RISK_LEVELS } from '../../engine/risk.js';

export const RECOVERY_CAPABILITY_IDS = Object.freeze({
  SERVICE_HEALTH_READ: 'service.health.read',
  RELEASE_HISTORY_READ: 'release.history.read',
  DEPLOYMENT_HISTORY_READ: 'deployment.history.read',
  RECOVERY_OPTION_PREPARE: 'recovery.option.prepare',
  RECOVERY_OPTION_APPLY: 'recovery.option.apply',
  STATUS_NOTICE_READ: 'status.notice.read',
  STATUS_NOTICE_PUBLISH: 'status.notice.publish',
});

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function capability({
  id,
  title,
  purpose,
  minimumRisk,
  approvalRequired,
  externalMutation,
  semanticCues,
  requiredConcepts,
  inputAliases,
  outputAliases,
}) {
  const schemaCues = [...new Set([
    ...Object.keys(inputAliases),
    ...Object.values(inputAliases).flat(),
  ])];
  return deepFreeze({
    id,
    title,
    description: purpose,
    purpose,
    keywords: [...new Set([...semanticCues.verbs, ...semanticCues.nouns])],
    nameCues: semanticCues.names,
    titleCues: semanticCues.nouns,
    descriptionCues: [...new Set([...semanticCues.verbs, ...semanticCues.nouns, ...semanticCues.phrases])],
    schemaCues,
    phrases: semanticCues.phrases,
    requiredConcepts,
    minimumRisk,
    approvalRequired,
    externalMutation,
    policy: {
      minimumRisk,
      approvalRequired,
      externalMutation,
    },
    semanticCues,
    inputAliases,
    outputAliases,
  });
}

export const RECOVERY_CAPABILITIES = deepFreeze([
  capability({
    id: RECOVERY_CAPABILITY_IDS.SERVICE_HEALTH_READ,
    title: 'Read service health',
    purpose: 'Establish the current service condition, impact, and incident window.',
    minimumRisk: RISK_LEVELS.READ_ONLY,
    approvalRequired: false,
    externalMutation: false,
    semanticCues: {
      names: ['probe_service', 'inspect_health', 'read_incident_window', 'service_status'],
      verbs: ['probe', 'inspect', 'read', 'check', 'measure'],
      nouns: ['service', 'health', 'incident', 'impact', 'error rate', 'availability'],
      phrases: ['current service health', 'incident window', 'affected customers'],
    },
    requiredConcepts: ['serviceId'],
    inputAliases: {
      serviceId: ['service', 'service_id', 'serviceId', 'component', 'component_id', 'application', 'target'],
      windowMinutes: ['window', 'window_minutes', 'windowMinutes', 'lookback', 'lookback_minutes', 'since_minutes'],
    },
    outputAliases: {
      status: ['status', 'state', 'health', 'condition', 'availability_state'],
      impact: ['impact', 'severity', 'user_impact', 'affected', 'affected_users'],
      errorRate: ['error_rate', 'errorRate', 'failure_rate', 'failureRate', 'errors_percent'],
      startedAt: ['started_at', 'startedAt', 'incident_start', 'since', 'first_seen_at'],
      observedAt: ['observed_at', 'observedAt', 'checked_at', 'timestamp', 'as_of'],
    },
  }),
  capability({
    id: RECOVERY_CAPABILITY_IDS.RELEASE_HISTORY_READ,
    title: 'Read release history',
    purpose: 'Inspect recent source and release changes that may explain the incident.',
    minimumRisk: RISK_LEVELS.READ_ONLY,
    approvalRequired: false,
    externalMutation: false,
    semanticCues: {
      names: ['trace_changes', 'inspect_release_candidate', 'list_releases', 'change_history'],
      verbs: ['trace', 'inspect', 'list', 'read', 'compare'],
      nouns: ['release', 'revision', 'commit', 'change', 'candidate', 'source history'],
      phrases: ['recent releases', 'change evidence', 'release candidate'],
    },
    requiredConcepts: ['serviceId'],
    inputAliases: {
      serviceId: ['service', 'service_id', 'serviceId', 'application', 'repository', 'component'],
      limit: ['limit', 'count', 'max_results', 'maxResults', 'recent', 'take'],
      since: ['since', 'from', 'after', 'start_time', 'startTime'],
    },
    outputAliases: {
      releases: ['releases', 'changes', 'revisions', 'commits', 'candidates', 'items'],
      releaseId: ['release_id', 'releaseId', 'revision', 'sha', 'commit', 'id'],
      summary: ['summary', 'change_summary', 'changeSummary', 'message', 'description'],
      releasedAt: ['released_at', 'releasedAt', 'created_at', 'timestamp', 'committed_at'],
      author: ['author', 'owner', 'committer', 'created_by', 'createdBy'],
    },
  }),
  capability({
    id: RECOVERY_CAPABILITY_IDS.DEPLOYMENT_HISTORY_READ,
    title: 'Read deployment history',
    purpose: 'Read recent rollout state and connect deployed versions to release evidence.',
    minimumRisk: RISK_LEVELS.READ_ONLY,
    approvalRequired: false,
    externalMutation: false,
    semanticCues: {
      names: ['list_rollouts', 'deployment_history', 'inspect_deployments', 'read_rollout_state'],
      verbs: ['list', 'inspect', 'read', 'trace', 'compare'],
      nouns: ['deployment', 'rollout', 'environment', 'production', 'version', 'history'],
      phrases: ['recent deployments', 'rollout state', 'deployed release'],
    },
    requiredConcepts: ['serviceId', 'environment'],
    inputAliases: {
      serviceId: ['service', 'service_id', 'serviceId', 'application', 'component'],
      environment: ['environment', 'env', 'stage', 'target_environment', 'targetEnvironment'],
      limit: ['limit', 'count', 'max_results', 'maxResults', 'recent', 'take'],
    },
    outputAliases: {
      deployments: ['deployments', 'rollouts', 'history', 'runs', 'items'],
      deploymentId: ['deployment_id', 'deploymentId', 'rollout_id', 'rolloutId', 'id'],
      releaseId: ['release_id', 'releaseId', 'revision', 'version', 'sha'],
      status: ['status', 'state', 'rollout_state', 'deployment_state'],
      deployedAt: ['deployed_at', 'deployedAt', 'started_at', 'created_at', 'timestamp'],
      previousReleaseId: ['previous_release_id', 'previousReleaseId', 'rollback_target', 'prior_version'],
    },
  }),
  capability({
    id: RECOVERY_CAPABILITY_IDS.RECOVERY_OPTION_PREPARE,
    title: 'Prepare recovery option',
    purpose: 'Prepare and quote a reversible recovery candidate without applying it.',
    minimumRisk: RISK_LEVELS.REVERSIBLE,
    approvalRequired: false,
    externalMutation: false,
    semanticCues: {
      names: ['stage_recovery', 'prepare_rollback', 'preview_recovery', 'quote_recovery'],
      verbs: ['prepare', 'stage', 'preview', 'quote', 'validate'],
      nouns: ['recovery', 'rollback', 'candidate', 'option', 'precondition', 'quote'],
      phrases: ['prepare recovery', 'recovery candidate', 'rollback preview'],
    },
    requiredConcepts: ['deploymentId', 'targetReleaseId', 'strategy'],
    inputAliases: {
      deploymentId: ['deployment_id', 'deploymentId', 'rollout_id', 'rolloutId', 'current_deployment'],
      targetReleaseId: ['target_release_id', 'targetReleaseId', 'rollback_target', 'target_revision', 'version'],
      strategy: ['strategy', 'mode', 'recovery_mode', 'recoveryMode', 'action'],
      reason: ['reason', 'rationale', 'justification', 'incident_summary'],
    },
    outputAliases: {
      recoveryOptionId: ['recovery_option_id', 'recoveryOptionId', 'option_id', 'optionId', 'quote_id', 'id'],
      quoteRevision: ['quote_revision', 'quoteRevision', 'revision', 'version', 'etag'],
      targetReleaseId: ['target_release_id', 'targetReleaseId', 'rollback_target', 'target_revision'],
      expiresAt: ['expires_at', 'expiresAt', 'expiry', 'valid_until', 'validUntil'],
      effectSummary: ['effect_summary', 'effectSummary', 'summary', 'impact', 'preview'],
      preconditions: ['preconditions', 'checks', 'requirements', 'guards'],
    },
  }),
  capability({
    id: RECOVERY_CAPABILITY_IDS.RECOVERY_OPTION_APPLY,
    title: 'Apply recovery option',
    purpose: 'Apply the exact recovery option and quote revision approved by the human.',
    minimumRisk: RISK_LEVELS.TRANSACTIONAL,
    approvalRequired: true,
    externalMutation: true,
    semanticCues: {
      names: ['apply_recovery', 'execute_rollback', 'activate_recovery', 'run_recovery'],
      verbs: ['apply', 'execute', 'activate', 'rollback', 'restore'],
      nouns: ['recovery', 'rollback', 'production', 'deployment', 'option'],
      phrases: ['apply recovery', 'execute rollback', 'restore deployment'],
    },
    requiredConcepts: ['recoveryOptionId', 'quoteRevision', 'idempotencyKey'],
    inputAliases: {
      recoveryOptionId: ['recovery_option_id', 'recoveryOptionId', 'option_id', 'optionId', 'quote_id'],
      quoteRevision: ['quote_revision', 'quoteRevision', 'revision', 'version', 'etag'],
      idempotencyKey: ['idempotency_key', 'idempotencyKey', 'request_id', 'requestId', 'operation_key'],
    },
    outputAliases: {
      operationId: ['operation_id', 'operationId', 'change_id', 'changeId', 'execution_id', 'id'],
      status: ['status', 'state', 'result', 'outcome'],
      appliedAt: ['applied_at', 'appliedAt', 'completed_at', 'timestamp'],
      activeReleaseId: ['active_release_id', 'activeReleaseId', 'release_id', 'version', 'revision'],
    },
  }),
  capability({
    id: RECOVERY_CAPABILITY_IDS.STATUS_NOTICE_READ,
    title: 'Read status notice',
    purpose: 'Read the currently published customer notice and its revision.',
    minimumRisk: RISK_LEVELS.READ_ONLY,
    approvalRequired: false,
    externalMutation: false,
    semanticCues: {
      names: ['read_active_notice', 'get_status_message', 'inspect_notice', 'current_update'],
      verbs: ['read', 'get', 'inspect', 'fetch', 'view'],
      nouns: ['status', 'notice', 'update', 'message', 'incident communication'],
      phrases: ['active notice', 'customer update', 'public status message'],
    },
    requiredConcepts: ['serviceId'],
    inputAliases: {
      serviceId: ['service', 'service_id', 'serviceId', 'component', 'product'],
      noticeId: ['notice_id', 'noticeId', 'incident_id', 'incidentId', 'id'],
    },
    outputAliases: {
      noticeId: ['notice_id', 'noticeId', 'incident_id', 'incidentId', 'id'],
      title: ['title', 'headline', 'subject', 'name'],
      body: ['body', 'message', 'content', 'text', 'description'],
      status: ['status', 'state', 'phase'],
      noticeRevision: ['notice_revision', 'noticeRevision', 'revision', 'version', 'etag'],
      updatedAt: ['updated_at', 'updatedAt', 'modified_at', 'timestamp'],
    },
  }),
  capability({
    id: RECOVERY_CAPABILITY_IDS.STATUS_NOTICE_PUBLISH,
    title: 'Publish status notice',
    purpose: 'Publish the exact customer update approved by the human.',
    minimumRisk: RISK_LEVELS.TRANSACTIONAL,
    approvalRequired: true,
    externalMutation: true,
    semanticCues: {
      names: ['publish_update', 'post_status_notice', 'send_customer_notice', 'update_incident'],
      verbs: ['publish', 'post', 'send', 'update', 'announce'],
      nouns: ['status', 'notice', 'customer update', 'incident', 'message'],
      phrases: ['publish update', 'customer notice', 'public status message'],
    },
    requiredConcepts: ['noticeId', 'noticeRevision', 'body', 'idempotencyKey'],
    inputAliases: {
      noticeId: ['notice_id', 'noticeId', 'incident_id', 'incidentId', 'id'],
      noticeRevision: ['notice_revision', 'noticeRevision', 'revision', 'version', 'etag'],
      title: ['title', 'headline', 'subject', 'name'],
      body: ['body', 'message', 'content', 'text', 'description'],
      idempotencyKey: ['idempotency_key', 'idempotencyKey', 'request_id', 'requestId', 'operation_key'],
    },
    outputAliases: {
      publicationId: ['publication_id', 'publicationId', 'update_id', 'updateId', 'operation_id', 'id'],
      status: ['status', 'state', 'result', 'outcome'],
      publishedAt: ['published_at', 'publishedAt', 'created_at', 'timestamp'],
      noticeRevision: ['notice_revision', 'noticeRevision', 'revision', 'version', 'etag'],
    },
  }),
]);

const CAPABILITIES_BY_ID = new Map(RECOVERY_CAPABILITIES.map((entry) => [entry.id, entry]));

export const RECOVERY_ONTOLOGY = deepFreeze({
  id: 'toolbraid.production-recovery',
  version: 1,
  title: 'Production recovery',
  capabilities: RECOVERY_CAPABILITIES,
});

export function getRecoveryCapability(capabilityId) {
  return CAPABILITIES_BY_ID.get(capabilityId) ?? null;
}
