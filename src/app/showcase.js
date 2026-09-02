const SVG_NS = 'http://www.w3.org/2000/svg';

const q = (selector, root = document) => root.querySelector(selector);
const qa = (selector, root = document) => [...root.querySelectorAll(selector)];

const ROUTE_NODES = Object.freeze({
  'agent-discover': ['agent', 'discover'],
  'chrome-core': ['chrome', 'core'],
  'discover-normalize': ['discover', 'normalize'],
  'normalize-core': ['normalize', 'core'],
  'core-evidence': ['core', 'evidence'],
  'evidence-github': ['evidence', 'github'],
  'evidence-vercel': ['evidence', 'vercel'],
  'evidence-x': ['evidence', 'x'],
  'provider-core': ['github', 'core'],
  'vercel-core': ['vercel', 'core'],
  'x-core': ['x', 'core'],
  'threat-normalize': ['threat', 'normalize'],
  'core-prepare': ['core', 'prepare'],
  'prepare-authority': ['prepare', 'authority'],
  'authority-github': ['authority', 'github'],
  'authority-vercel': ['authority', 'vercel'],
  'authority-x': ['authority', 'x'],
  'github-audit': ['github', 'audit'],
  'vercel-audit': ['vercel', 'audit'],
  'x-audit': ['x', 'audit'],
  'audit-core': ['audit', 'core'],
});

const NODE_INFO = Object.freeze({
  agent: {
    kicker: 'Objective origin',
    title: 'Codex ↔ MCP bridge',
    summary: 'Codex carries the objective through MCP into ToolBraid. The bridge can request capabilities, but it cannot create browser authority.',
    tags: ['intent', 'agent session', 'no approval authority'],
    details: { Role: 'Objective runner', Sends: 'Mission intent', Receives: 'Results and receipts', Boundary: 'Cannot mint approval' },
    payload: { type: 'mission.intent', objective: 'Recover production and prepare a public update.', constraints: ['read first', 'exact approval', 'prove the outcome'] },
  },
  chrome: {
    kicker: 'Browser binding',
    title: 'Active Chrome page',
    summary: 'The extension binds the exact tab, frame, session, origin and page fingerprint used by the mission.',
    tags: ['active tab', 'exact origin', 'page fingerprint'],
    details: { Surface: 'Chrome MV3 side panel', Ownership: 'Exact tab and frame', Session: 'Bound locally', Credentials: 'Remain in the site' },
    payload: { type: 'browser.binding', tabId: 'active-tab', frameId: 0, origin: 'exact live origin', pageFingerprint: 'sha256:bound-page…' },
  },
  discover: {
    kicker: 'Live registry',
    title: 'Discover native tools',
    summary: 'ToolBraid inspects tools exposed by the active document and retains only descriptors that survive provenance and policy checks.',
    tags: ['WebMCP registry', 'live tools', 'fail closed'],
    details: { Input: 'Document registrations', Output: 'Retained descriptors', Rejects: 'Unknown origin or forged binding', Mutation: 'None' },
    payload: { type: 'registry.discovery', sources: ['document.modelContext', 'verified site adapter'], policy: 'origin allowlist + descriptor binding' },
  },
  normalize: {
    kicker: 'Canonical ontology',
    title: 'Normalize capability meaning',
    summary: 'Provider-specific names are mapped into stable capability meanings without allowing descriptions to grant themselves authority.',
    tags: ['semantic mapping', 'schema bound', 'untrusted metadata'],
    details: { Maps: 'Provider tool → canonical capability', Checks: 'Schema and provenance', Quarantine: 'Instruction-like metadata', Confidence: 'Evidence based' },
    payload: { type: 'capability.mapping', example: { providerTool: 'redeploy_vercel_deployment', canonicalEffect: 'deployment.redeploy', risk: 'transactional' } },
  },
  evidence: {
    kicker: 'Read-only evidence',
    title: 'Correlate independent reads',
    summary: 'Safe reads execute in parallel, return structured evidence and remain visibly separate from every external mutation.',
    tags: ['parallel reads', 'untrusted evidence', 'no mutation'],
    details: { Mode: 'Read only', Sources: 'GitHub · Vercel · X', Correlation: 'Mission scoped', Failure: 'Compatible fallback only' },
    payload: { type: 'evidence.batch', reads: ['read_github_commit', 'read_vercel_deployment', 'read_x_post'], mutationCount: 0 },
  },
  prepare: {
    kicker: 'Effect preparation',
    title: 'Prepare exact external effects',
    summary: 'ToolBraid derives provider-native inputs, freezes their exact scope and stops before dispatch.',
    tags: ['exact arguments', 'locked', 'provider native'],
    details: { Effects: 'Redeploy + publish update', State: 'Prepared, not dispatched', Binding: 'Origin · tool · schema · arguments', Next: 'Human review' },
    payload: { type: 'effect.envelope', requiresApproval: true, fields: ['origin', 'tool', 'schemaFingerprint', 'canonicalArguments', 'effect', 'nonce'] },
  },
  authority: {
    kicker: 'Hard boundary',
    title: 'Human authority gate',
    summary: 'External effects stop here. Each exact envelope needs a separate, trusted and short-lived user approval.',
    tags: ['trusted gesture', 'one-time nonce', 'exact effect'],
    details: { Authority: 'Trusted human DOM activation', Scope: 'One exact envelope', Lifetime: 'Short lived', Replay: 'Rejected' },
    payload: { type: 'approval.binding', creator: 'trusted-human-gesture', reusable: false, covers: ['origin', 'nativeTool', 'arguments', 'effect', 'riskClass'] },
  },
  audit: {
    kicker: 'Outcome proof',
    title: 'Receipts and audit seal',
    summary: 'Provider outcomes, postconditions and decision records return into an append-only integrity chain.',
    tags: ['postcondition', 'receipt', 'SHA-256 seal'],
    details: { Records: 'Intent through outcome', Integrity: 'Append-only SHA-256 chain', Result: 'Verified or explicitly unverified', Export: 'Inspectable audit' },
    payload: { type: 'audit.seal', algorithm: 'SHA-256', records: ['discovery', 'mapping', 'evidence', 'approval', 'dispatch', 'postcondition'], head: 'sha256:pending…' },
  },
  core: {
    kicker: 'Mission control',
    title: 'ToolBraid core',
    summary: 'ToolBraid braids browser context, live capabilities, policy, human authority and receipts into one inspectable mission.',
    tags: ['policy control plane', 'human authority', 'causal proof'],
    details: { Current: 'Objective ready', Controls: 'Discovery · policy · execution', Sources: 'Exact browser context', Output: 'Verified receipts' },
    payload: { type: 'toolbraid.mission', missionId: 'local-concept', mode: 'sandbox-event-replay', liveMutation: false },
  },
  github: {
    kicker: 'Verified site adapter',
    title: 'GitHub',
    summary: 'Repository, commit, issue and pull-request evidence can be read as structured, untrusted browser evidence.',
    tags: ['repository evidence', 'commit history', 'verified adapter'],
    details: { Reads: 'Repository · commit · issue · pull request', Actions: 'Star · comment · state change', Verification: 'Observed postcondition', Authority: 'Required for actions' },
    payload: { adapterId: 'github', readTool: 'read_github_commit', mutationExample: 'comment_github_issue', provenance: 'toolbraid.verified-adapter/github' },
  },
  vercel: {
    kicker: 'Verified site adapter',
    title: 'Vercel deployment',
    summary: 'ToolBraid reads the visible deployment and can expose exact redeploy or cancel actions only when the page supplies an unambiguous control.',
    tags: ['deployment state', 'redeploy', 'postcondition'],
    details: { Read: 'read_vercel_deployment', Mutation: 'redeploy_vercel_deployment', Risk: 'Transactional', Proof: 'Deployment state observed after action' },
    payload: { adapterId: 'vercel', tool: 'redeploy_vercel_deployment', risk: 'transactional', requiresApproval: true, additionalProperties: false },
  },
  x: {
    kicker: 'Verified site adapter',
    title: 'X publication surface',
    summary: 'ToolBraid can read a visible post, stage text and expose the exact publish control while keeping publication behind approval.',
    tags: ['read post', 'prepare text', 'publish with approval'],
    details: { Reads: 'read_x_post', Stage: 'prepare_x_post', Publish: 'publish_x_post', Verification: 'Observed page state when available' },
    payload: { adapterId: 'x-post', tools: ['read_x_post', 'prepare_x_post', 'publish_x_post'], risk: 'account-content', requiresApproval: true },
  },
  threat: {
    kicker: 'Untrusted descriptor',
    title: 'Hostile metadata',
    summary: 'A tool description tries to create or widen authority. ToolBraid quarantines it before mapping or dispatch.',
    tags: ['instruction injection', 'quarantined', 'zero dispatch'],
    details: { Attempt: 'Self-promote into an executable path', Detected: 'Metadata conflicts with provenance', Result: 'Quarantined', Dispatches: '0' },
    payload: { type: 'hostile.descriptor', instruction: '[redacted authority claim]', result: 'DESCRIPTOR_QUARANTINED', providerDispatch: false },
  },
});

const SCENARIOS = Object.freeze({
  recovery: {
    id: 'recovery',
    name: 'Production recovery',
    duration: 52000,
    boundary: 32400,
    objective: 'Diagnose a failed Vercel deployment from GitHub evidence. Prepare a redeploy and an X status update. Publish nothing without approval.',
    chapters: [
      { time: 0, name: 'Objective', phase: 'objective', title: 'Give the web a mission. Keep the final say.', detail: 'Codex asks ToolBraid to recover production and prepare a public update.', now: 'Objective ready' },
      { time: 3500, name: 'Bridge', phase: 'bridge', title: 'One page. One exact session.', detail: 'The local bridge binds the agent to the active Chrome tab and exact origin.', now: 'Binding browser context' },
      { time: 7200, name: 'Discover', phase: 'discover', title: 'Live tools enter through a verified registry.', detail: 'GitHub, Vercel and X capabilities are discovered from live browser surfaces.', now: 'Discovering native tools' },
      { time: 11800, name: 'Map', phase: 'map', title: 'Different tools. One canonical meaning.', detail: 'Provider-specific schemas are normalized without trusting their descriptions.', now: 'Mapping capabilities' },
      { time: 14800, name: 'Evidence', phase: 'evidence', title: 'Read first. Correlate before acting.', detail: 'Independent GitHub, Vercel and X reads return through separate evidence paths.', now: 'Reading three providers' },
      { time: 22400, name: 'Security', phase: 'security', title: 'Hostile authority never enters the plan.', detail: 'Instruction-like metadata is quarantined before it can influence execution.', now: 'Quarantining hostile metadata' },
      { time: 26500, name: 'Prepare', phase: 'prepare', title: 'Exact effects are prepared, then stopped.', detail: 'A Vercel redeploy and X publication envelope reach the human boundary.', now: 'Preparing two exact effects' },
      { time: 32400, name: 'Approve', phase: 'approval', title: 'The agent stops. You decide.', detail: 'Two separate approvals bind the exact target, tool, arguments and effect.', now: 'Waiting for human approval' },
      { time: 35000, name: 'Execute', phase: 'execute', title: 'Only the approved effects can move.', detail: 'The claimed envelopes cross the boundary and dispatch to their exact providers.', now: 'Executing approved effects' },
      { time: 43400, name: 'Audit', phase: 'audit', title: 'Every outcome returns with proof.', detail: 'Postconditions and receipts braid into the final append-only audit seal.', now: 'Verifying receipts' },
      { time: 50500, name: 'Sealed', phase: 'sealed', title: 'Mission complete. Authority stayed visible.', detail: 'Recovery and publication are verified; the causal chain is sealed.', now: 'Audit sealed' },
    ],
    events: [
      { id: 'objective', start: 900, duration: 2200, route: 'agent-discover', label: 'mission.intent', tone: 'intent', tool: 'start_mission', source: 'Codex / MCP', target: 'ToolBraid discovery', payload: { objective: 'Recover production; prepare an update; require approval.' } },
      { id: 'binding', start: 3800, duration: 2100, route: 'chrome-core', label: 'bind exact session', tone: 'intent', tool: 'browser.bind', source: 'Chrome page', target: 'ToolBraid', payload: { tab: 'exact', frame: 0, origin: 'bound', fingerprint: 'verified' } },
      { id: 'registry', start: 7200, duration: 1900, route: 'discover-normalize', label: 'getTools()', tone: 'evidence', tool: 'document.modelContext.getTools', source: 'Live registry', target: 'Normalizer', payload: { providers: 3, descriptors: 8, untrusted: true } },
      { id: 'mapping', start: 9700, duration: 1900, route: 'normalize-core', label: 'canonical map', tone: 'intent', tool: 'map_capabilities', source: 'Normalizer', target: 'ToolBraid', payload: { capabilities: ['release.read', 'deployment.read', 'status.read', 'deployment.redeploy', 'status.publish'] } },
      { id: 'evidence-plan', start: 13200, duration: 1500, route: 'core-evidence', label: 'read-only batch', tone: 'evidence', tool: 'run_evidence', source: 'ToolBraid', target: 'Evidence fan-out', payload: { mutationCount: 0, parallel: true } },
      { id: 'github-read', start: 15000, duration: 2200, route: 'evidence-github', label: 'read commit', tone: 'evidence', tool: 'read_github_commit', source: 'ToolBraid', target: 'GitHub', payload: { repository: 'Maharajahu/toolbraid', ref: 'latest release' } },
      { id: 'vercel-read', start: 15750, duration: 2300, route: 'evidence-vercel', label: 'read deployment', tone: 'evidence', tool: 'read_vercel_deployment', source: 'ToolBraid', target: 'Vercel', payload: { deployment: 'visible deployment', expectedState: 'ready | error' } },
      { id: 'x-read', start: 16500, duration: 2250, route: 'evidence-x', label: 'read status', tone: 'evidence', tool: 'read_x_post', source: 'ToolBraid', target: 'X', payload: { page: 'visible post', mediaMetadata: true } },
      { id: 'github-result', start: 18400, duration: 2100, route: 'provider-core', label: 'release-1841', tone: 'evidence', tool: 'read_github_commit', source: 'GitHub', target: 'ToolBraid', payload: { release: '1841', verification: 'structured evidence' } },
      { id: 'vercel-result', start: 19200, duration: 2100, route: 'vercel-core', label: 'deployment error', tone: 'evidence', tool: 'read_vercel_deployment', source: 'Vercel', target: 'ToolBraid', payload: { state: 'ERROR', deploymentId: 'dep-bound' } },
      { id: 'x-result', start: 19900, duration: 2100, route: 'x-core', label: 'notice observed', tone: 'evidence', tool: 'read_x_post', source: 'X', target: 'ToolBraid', payload: { currentNotice: 'Investigating checkout disruption' } },
      { id: 'hostile', start: 22600, duration: 2500, route: 'threat-normalize', label: 'authority injection', tone: 'threat', tool: 'forged_descriptor', source: 'Hostile metadata', target: 'Normalizer', payload: { claim: 'self-authorized', result: 'QUARANTINED', dispatched: false } },
      { id: 'prepare-effects', start: 26400, duration: 2100, route: 'core-prepare', label: 'derive exact inputs', tone: 'authority', tool: 'prepare_effects', source: 'ToolBraid', target: 'Effect preparation', payload: { effects: 2, dispatch: false } },
      { id: 'hold-effects', start: 29400, duration: 2400, route: 'prepare-authority', label: 'approval required', tone: 'authority', tool: 'request_exact_approval', source: 'Prepared effects', target: 'Human authority', payload: { separateApprovals: 2, reusable: false } },
      { id: 'redeploy', start: 34600, duration: 2800, route: 'authority-vercel', label: 'redeploy approved', tone: 'effect', tool: 'redeploy_vercel_deployment', source: 'Human authority', target: 'Vercel', payload: { approval: 'exact', arguments: {}, nonce: 'one-time' } },
      { id: 'publish', start: 37600, duration: 2800, route: 'authority-x', label: 'publish approved', tone: 'effect', tool: 'publish_x_post', source: 'Human authority', target: 'X', payload: { text: 'Reviewed incident update', approval: 'separate exact binding' } },
      { id: 'vercel-receipt', start: 41200, duration: 2600, route: 'vercel-audit', label: 'deployment verified', tone: 'effect', tool: 'postcondition.observe', source: 'Vercel', target: 'Audit', payload: { status: 'verified-success', reason: 'VERCEL_REDEPLOY_STATE_CONFIRMED' } },
      { id: 'x-receipt', start: 43300, duration: 2600, route: 'x-audit', label: 'publication receipt', tone: 'effect', tool: 'postcondition.observe', source: 'X', target: 'Audit', payload: { status: 'verified-success', receipt: 'X-PUBLISH-BOUND' } },
      { id: 'seal', start: 47200, duration: 2600, route: 'audit-core', label: 'sha256 seal', tone: 'effect', tool: 'audit.seal', source: 'Audit chain', target: 'ToolBraid', payload: { receipts: 2, integrity: 'verified', head: 'sha256:54b0…' } },
    ],
    schedules: {
      agent: [[0, 'idle'], [900, 'active'], [3600, 'complete']],
      chrome: [[0, 'idle'], [3600, 'active'], [6400, 'complete']],
      discover: [[0, 'idle'], [6500, 'active'], [9800, 'complete']],
      normalize: [[0, 'idle'], [8500, 'active'], [12600, 'complete'], [22600, 'active'], [25200, 'complete']],
      core: [[0, 'ready'], [900, 'active'], [50500, 'complete']],
      evidence: [[0, 'idle'], [13000, 'active'], [22100, 'complete']],
      github: [[0, 'idle'], [14900, 'active'], [21100, 'complete']],
      vercel: [[0, 'idle'], [15600, 'active'], [21800, 'complete'], [34500, 'active'], [44000, 'complete']],
      x: [[0, 'idle'], [16400, 'active'], [22000, 'complete'], [37500, 'active'], [46200, 'complete']],
      threat: [[0, 'idle'], [22400, 'active'], [25100, 'quarantined']],
      prepare: [[0, 'idle'], [26000, 'active'], [31800, 'complete']],
      authority: [[0, 'locked'], [29300, 'active'], [32400, 'locked'], [34500, 'active'], [41000, 'complete']],
      audit: [[0, 'idle'], [41000, 'active'], [50000, 'complete']],
    },
  },
  incident: {
    id: 'incident',
    name: 'Incident trace',
    duration: 38000,
    boundary: null,
    objective: 'Trace a production incident across independent providers. Prove compatible read-only fallback and seal the evidence. Execute no external action.',
    chapters: [
      { time: 0, name: 'Objective', phase: 'objective', title: 'Trace the incident without touching production.', detail: 'The mission explicitly forbids staging, publication and every external mutation.', now: 'Read-only objective ready' },
      { time: 3200, name: 'Bridge', phase: 'bridge', title: 'The investigation stays bound to one browser context.', detail: 'ToolBraid records the exact page and agent session before discovery.', now: 'Binding investigation context' },
      { time: 6600, name: 'Discover', phase: 'discover', title: 'Independent evidence sources enter the graph.', detail: 'Primary and fallback read capabilities are discovered and normalized.', now: 'Discovering read providers' },
      { time: 12000, name: 'Evidence', phase: 'evidence', title: 'The primary probe fails closed.', detail: 'No mutation path is opened while ToolBraid checks fallback compatibility.', now: 'Primary probe degraded' },
      { time: 20500, name: 'Fallback', phase: 'security', title: 'The route changes. The meaning does not.', detail: 'A compatible read-only fallback finishes the evidence batch and records both identities.', now: 'Verifying safe fallback' },
      { time: 29200, name: 'Audit', phase: 'audit', title: 'Read-only completion is still provable.', detail: 'The failed primary, selected fallback and zero-dispatch result enter the audit chain.', now: 'Sealing incident evidence' },
      { time: 36500, name: 'Sealed', phase: 'sealed', title: 'Incident traced. Zero external effects.', detail: 'Fallback evidence is verified and the mission terminates without approval or dispatch.', now: 'Read-only audit sealed' },
    ],
    events: [
      { id: 'incident-objective', start: 700, duration: 2100, route: 'agent-discover', label: 'read-only intent', tone: 'intent', tool: 'start_mission', source: 'Codex / MCP', target: 'Discovery', payload: { constraint: 'NO_MUTATION' } },
      { id: 'incident-bind', start: 3500, duration: 1900, route: 'chrome-core', label: 'bind context', tone: 'intent', tool: 'browser.bind', source: 'Chrome page', target: 'ToolBraid', payload: { exactSession: true } },
      { id: 'incident-registry', start: 6600, duration: 2000, route: 'discover-normalize', label: 'discover probes', tone: 'evidence', tool: 'getTools', source: 'Registry', target: 'Normalizer', payload: { primary: 'Vercel health', fallback: 'GitHub release signal' } },
      { id: 'incident-map', start: 9000, duration: 1800, route: 'normalize-core', label: 'map read semantics', tone: 'intent', tool: 'map_capabilities', source: 'Normalizer', target: 'ToolBraid', payload: { canonical: 'service.health.read' } },
      { id: 'incident-plan', start: 12100, duration: 1500, route: 'core-evidence', label: 'safe read batch', tone: 'evidence', tool: 'run_evidence', source: 'ToolBraid', target: 'Evidence', payload: { allowedEffects: ['read'] } },
      { id: 'primary-probe', start: 14500, duration: 2300, route: 'evidence-vercel', label: 'primary health probe', tone: 'evidence', tool: 'read_vercel_deployment', source: 'Evidence', target: 'Vercel', payload: { role: 'primary' } },
      { id: 'primary-fail', start: 17300, duration: 2200, route: 'vercel-core', label: 'failed closed', tone: 'threat', tool: 'read_vercel_deployment', source: 'Vercel', target: 'ToolBraid', payload: { status: 'unavailable', providerDispatchMutation: false } },
      { id: 'fallback-read', start: 20800, duration: 2400, route: 'evidence-github', label: 'compatible fallback', tone: 'evidence', tool: 'read_github_commit', source: 'ToolBraid', target: 'GitHub', payload: { role: 'fallback', canonicalMatch: true } },
      { id: 'fallback-result', start: 24200, duration: 2300, route: 'provider-core', label: 'health evidence', tone: 'evidence', tool: 'read_github_commit', source: 'GitHub', target: 'ToolBraid', payload: { serviceSignal: 'degraded after release-1841' } },
      { id: 'incident-audit', start: 29500, duration: 2200, route: 'github-audit', label: 'fallback receipt', tone: 'effect', tool: 'audit.append', source: 'GitHub evidence', target: 'Audit', payload: { primaryRecorded: true, fallbackRecorded: true, mutations: 0 } },
      { id: 'incident-seal', start: 32800, duration: 2300, route: 'audit-core', label: 'read-only seal', tone: 'effect', tool: 'audit.seal', source: 'Audit', target: 'ToolBraid', payload: { integrity: 'verified', externalEffects: 0 } },
    ],
    schedules: {
      agent: [[0, 'idle'], [700, 'active'], [3200, 'complete']], chrome: [[0, 'idle'], [3300, 'active'], [5700, 'complete']],
      discover: [[0, 'idle'], [6200, 'active'], [9300, 'complete']], normalize: [[0, 'idle'], [8000, 'active'], [11200, 'complete']],
      core: [[0, 'ready'], [700, 'active'], [36500, 'complete']], evidence: [[0, 'idle'], [11800, 'active'], [28000, 'complete']],
      github: [[0, 'idle'], [20500, 'active'], [27800, 'complete']], vercel: [[0, 'idle'], [14200, 'active'], [17500, 'degraded']],
      x: [[0, 'idle']], threat: [[0, 'idle']], prepare: [[0, 'idle']], authority: [[0, 'locked']], audit: [[0, 'idle'], [29000, 'active'], [36000, 'complete']],
    },
  },
  attack: {
    id: 'attack',
    name: 'Authority attack',
    duration: 36000,
    boundary: null,
    objective: 'Audit the live registry for authority attacks. Quarantine hostile metadata and prove origin drift and nonce replay are rejected. Dispatch nothing.',
    chapters: [
      { time: 0, name: 'Objective', phase: 'objective', title: 'Prove the boundary by attacking it.', detail: 'The security mission must terminate every challenge before provider dispatch.', now: 'Security objective ready' },
      { time: 3200, name: 'Discover', phase: 'discover', title: 'Tool descriptions are treated as untrusted input.', detail: 'The same registry and mapping path used by production is placed under pressure.', now: 'Inspecting live registry' },
      { time: 8000, name: 'Metadata', phase: 'security', title: 'A descriptor tries to grant itself authority.', detail: 'Its instruction-like metadata conflicts with provenance and enters quarantine.', now: 'Blocking metadata injection' },
      { time: 15500, name: 'Drift', phase: 'security', title: 'The origin changes after approval.', detail: 'Exact browser and execution context no longer match, so dispatch is rejected.', now: 'Rejecting origin drift' },
      { time: 22600, name: 'Replay', phase: 'security', title: 'A consumed approval nonce returns.', detail: 'One-time authority cannot be rehydrated or replayed into a second effect.', now: 'Rejecting nonce replay' },
      { time: 28600, name: 'Audit', phase: 'audit', title: 'Three attacks. Zero provider mutations.', detail: 'Each rejection code enters the same append-only integrity chain.', now: 'Sealing rejection receipts' },
      { time: 34700, name: 'Sealed', phase: 'sealed', title: 'Authority never drifted.', detail: 'Metadata injection, origin drift and nonce replay were blocked before dispatch.', now: 'Security audit sealed' },
    ],
    events: [
      { id: 'attack-objective', start: 600, duration: 2000, route: 'agent-discover', label: 'security intent', tone: 'intent', tool: 'start_mission', source: 'Codex / MCP', target: 'Discovery', payload: { expectedDispatches: 0 } },
      { id: 'attack-registry', start: 3500, duration: 2000, route: 'discover-normalize', label: 'inspect descriptors', tone: 'evidence', tool: 'getTools', source: 'Registry', target: 'Normalizer', payload: { descriptionsTrusted: false } },
      { id: 'attack-metadata', start: 8200, duration: 2600, route: 'threat-normalize', label: 'self-authorize', tone: 'threat', tool: 'forged_descriptor', source: 'Hostile metadata', target: 'Normalizer', payload: { result: 'DESCRIPTOR_QUARANTINED' } },
      { id: 'attack-map', start: 11600, duration: 1900, route: 'normalize-core', label: 'retained tools only', tone: 'evidence', tool: 'map_capabilities', source: 'Normalizer', target: 'ToolBraid', payload: { quarantinedExcluded: true } },
      { id: 'attack-drift', start: 15800, duration: 2400, route: 'chrome-core', label: 'origin drift', tone: 'threat', tool: 'verify_execution_context', source: 'Changed page context', target: 'ToolBraid', payload: { result: 'EXECUTION_CONTEXT_DRIFT', dispatched: false } },
      { id: 'attack-prepare', start: 19600, duration: 1800, route: 'core-prepare', label: 'challenge nonce', tone: 'authority', tool: 'prepare_replay_test', source: 'ToolBraid', target: 'Authority verifier', payload: { testOnly: true } },
      { id: 'attack-replay', start: 22800, duration: 2500, route: 'prepare-authority', label: 'nonce replay', tone: 'threat', tool: 'claim_approval', source: 'Consumed nonce', target: 'Human authority', payload: { result: 'APPROVAL_NONCE_REPLAY', dispatched: false } },
      { id: 'attack-receipt', start: 28600, duration: 2200, route: 'github-audit', label: '3 rejection codes', tone: 'effect', tool: 'audit.append', source: 'Security checks', target: 'Audit', payload: { checks: 3, providerMutations: 0 } },
      { id: 'attack-seal', start: 31600, duration: 2200, route: 'audit-core', label: 'security seal', tone: 'effect', tool: 'audit.seal', source: 'Audit', target: 'ToolBraid', payload: { integrity: 'verified', dispatchCount: 0 } },
    ],
    schedules: {
      agent: [[0, 'idle'], [600, 'active'], [3000, 'complete']], chrome: [[0, 'idle'], [15200, 'active'], [18500, 'denied']],
      discover: [[0, 'idle'], [3200, 'active'], [6500, 'complete']], normalize: [[0, 'idle'], [5000, 'active'], [11000, 'complete']],
      core: [[0, 'ready'], [600, 'active'], [34700, 'complete']], evidence: [[0, 'idle']], github: [[0, 'idle']], vercel: [[0, 'idle']], x: [[0, 'idle']],
      threat: [[0, 'idle'], [7800, 'active'], [11000, 'quarantined']], prepare: [[0, 'idle'], [19200, 'active'], [21800, 'complete']],
      authority: [[0, 'locked'], [22400, 'active'], [25600, 'denied']], audit: [[0, 'idle'], [28200, 'active'], [34200, 'complete']],
    },
  },
});

const PRODUCT_VIEWS = Object.freeze(['topology', 'live', 'evidence', 'approvals', 'audit']);

const APPROVAL_ENVELOPES = Object.freeze({
  rollback: {
    title: 'Apply recovery',
    provider: 'Vercel',
    origin: 'https://deploy.toolbraid.test',
    tool: 'redeploy_vercel_deployment',
    schema: 'sha256:f0529a7c…',
    target: 'deployment:dep-bound-1842',
    effect: 'Redeploy the exact failed deployment from verified release-1841.',
    risk: 'transactional · external mutation',
    expiry: '5 minutes after trusted gesture',
    fingerprint: 'page:5a1b9971df242403…',
    arguments: { deploymentId: 'dep-bound-1842', releaseId: 'release-1841', strategy: 'exact-redeploy' },
  },
  publish: {
    title: 'Publish incident update',
    provider: 'X',
    origin: 'https://x.com',
    tool: 'publish_x_post',
    schema: 'sha256:88a24c19…',
    target: 'composer:incident-status',
    effect: 'Publish the reviewed incident update as a separate communication.',
    risk: 'public communication · external mutation',
    expiry: '5 minutes after trusted gesture',
    fingerprint: 'page:8d2cf3f92a4317b6…',
    arguments: { body: 'Checkout recovery is complete. Service health is verified and the incident record is sealed.' },
  },
});

const state = {
  scenarioId: 'recovery',
  time: 0,
  playing: false,
  rate: 1.5,
  lastFrame: null,
  animationFrame: null,
  selected: { type: 'node', id: 'core' },
  hovered: null,
  inspectorMode: 'inspect',
  inspectorTab: 'summary',
  blockedAtBoundary: false,
  approvals: { rollback: false, publish: false, complete: false },
  denials: { rollback: false, publish: false },
  approvalSelection: 'rollback',
  decisionEvents: [],
  productView: 'topology',
  bridgeState: 'connected',
  bridgeStamp: 0,
  bridgeGeneration: 0,
  evidenceState: 'ready',
  evidenceProgress: 100,
  evidenceTimer: null,
  provider: { mode: 'metadata', endpointOrigin: '', visionModel: '', audioModel: '' },
  auditExpanded: false,
  packetElements: new Map(),
  lastChapterIndex: -1,
};

function scenario() { return SCENARIOS[state.scenarioId]; }

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function formatTime(milliseconds) {
  const total = Math.max(0, Math.round(milliseconds / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function currentChapterIndex() {
  const chapters = scenario().chapters;
  for (let index = chapters.length - 1; index >= 0; index -= 1) {
    if (state.time >= chapters[index].time) return index;
  }
  return 0;
}

function scheduledState(nodeId) {
  const schedule = scenario().schedules[nodeId] ?? [[0, 'idle']];
  let result = schedule[0][1];
  for (const [time, value] of schedule) {
    if (state.time < time) break;
    result = value;
  }
  if (nodeId === 'authority' && state.scenarioId === 'recovery' && state.approvals.complete && state.time >= scenario().boundary) {
    return state.time >= 41000 ? 'complete' : 'active';
  }
  return result;
}

function createPacket(event) {
  const group = document.createElementNS(SVG_NS, 'g');
  group.classList.add('flow-packet');
  group.dataset.eventId = event.id;
  group.dataset.tone = event.tone;
  group.setAttribute('role', 'button');
  group.setAttribute('tabindex', '0');
  group.setAttribute('aria-label', `${event.label}: ${event.source} to ${event.target}`);

  const ring = document.createElementNS(SVG_NS, 'circle');
  ring.classList.add('packet-ring');
  ring.setAttribute('r', '9');
  const core = document.createElementNS(SVG_NS, 'circle');
  core.setAttribute('r', '4');

  const width = Math.max(66, event.label.length * 5.2 + 18);
  const bubble = document.createElementNS(SVG_NS, 'rect');
  bubble.setAttribute('width', String(width));
  bubble.setAttribute('height', '20');
  bubble.setAttribute('rx', '8');
  bubble.dataset.packetBubble = '';
  const text = document.createElementNS(SVG_NS, 'text');
  text.textContent = event.label;
  text.dataset.packetText = '';

  group.append(ring, core, bubble, text);
  group.addEventListener('click', (clickEvent) => {
    clickEvent.stopPropagation();
    selectItem({ type: 'event', id: event.id });
  });
  group.addEventListener('keydown', (keyboardEvent) => {
    if (keyboardEvent.key !== 'Enter' && keyboardEvent.key !== ' ') return;
    keyboardEvent.preventDefault();
    selectItem({ type: 'event', id: event.id });
  });
  return { group, width };
}

function rebuildPackets() {
  const layer = q('#packet-layer');
  layer.replaceChildren();
  state.packetElements.clear();
  for (const event of scenario().events) {
    const packet = createPacket(event);
    packet.group.hidden = true;
    packet.group.style.display = 'none';
    layer.append(packet.group);
    state.packetElements.set(event.id, packet);
  }
}

function renderPackets() {
  const active = [];
  for (const event of scenario().events) {
    const packet = state.packetElements.get(event.id);
    if (!packet) continue;
    const progress = (state.time - event.start) / event.duration;
    const visible = progress >= 0 && progress <= 1;
    packet.group.hidden = !visible;
    packet.group.style.display = visible ? '' : 'none';
    packet.group.classList.remove('is-lead');
    if (!visible) continue;
    active.push(event);
    const route = q(`#route-${CSS.escape(event.route)}`);
    if (!route) continue;
    const length = route.getTotalLength();
    const eased = progress < .5 ? 2 * progress * progress : 1 - ((-2 * progress + 2) ** 2) / 2;
    const point = route.getPointAtLength(length * eased);
    packet.group.setAttribute('transform', `translate(${point.x.toFixed(2)} ${point.y.toFixed(2)})`);
    const left = point.x > 880;
    const bubble = q('[data-packet-bubble]', packet.group);
    const label = q('[data-packet-text]', packet.group);
    const x = left ? -packet.width - 14 : 14;
    bubble.setAttribute('x', String(x));
    bubble.setAttribute('y', '-27');
    label.setAttribute('x', String(x + 9));
    label.setAttribute('y', '-13');
  }
  if (active.length) {
    const lead = active[active.length - 1];
    state.packetElements.get(lead.id)?.group.classList.add('is-lead');
  }
}

function renderRoutes() {
  const activeRoutes = new Set();
  const completedRoutes = new Set();
  for (const event of scenario().events) {
    if (state.time >= event.start && state.time <= event.start + event.duration) activeRoutes.add(event.route);
    if (state.time > event.start + event.duration) completedRoutes.add(event.route);
  }
  for (const route of qa('.route')) {
    const id = route.dataset.route;
    route.classList.toggle('is-live', activeRoutes.has(id));
    route.classList.toggle('is-complete', !activeRoutes.has(id) && completedRoutes.has(id));
  }
}

function renderNodes() {
  for (const node of qa('.graph-node')) node.dataset.state = scheduledState(node.dataset.node);
}

function activeEvent() {
  const events = scenario().events.filter((event) => state.time >= event.start && state.time <= event.start + event.duration);
  return events.at(-1) ?? null;
}

function nextEvent() {
  return scenario().events.find((event) => event.start > state.time) ?? null;
}

function setPlayIcon() {
  const path = state.playing ? '<path d="M8 6h3v12H8zM14 6h3v12h-3z"></path>' : '<path d="m9 6 9 6-9 6V6Z"></path>';
  for (const button of qa('[data-action="toggle-play"]')) {
    const svg = q('svg', button);
    if (svg) svg.innerHTML = path;
    button.classList.toggle('is-playing', state.playing);
    button.setAttribute('aria-label', state.playing ? 'Pause mission' : 'Play mission');
  }
  q('[data-play-label]').textContent = state.playing ? 'Pause mission' : state.time >= scenario().duration ? 'Replay mission' : 'Run guided mission';
}

function renderNarrative() {
  const index = currentChapterIndex();
  const chapter = scenario().chapters[index];
  q('[data-chapter-index]').textContent = String(index + 1).padStart(2, '0');
  q('[data-chapter-name]').textContent = chapter.name;
  q('[data-story-title]').textContent = chapter.title;
  q('[data-story-detail]').textContent = chapter.detail;
  q('[data-now-label]').textContent = activeEvent()?.label ?? chapter.now;
  q('[data-next-label]').textContent = nextEvent()?.label ?? 'Mission complete';
  q('[data-runtime-state]').textContent = state.blockedAtBoundary ? 'Waiting for you' : chapter.phase === 'sealed' ? 'Verified + sealed' : state.playing ? 'Replaying events' : 'Paused';
  document.body.dataset.phase = chapter.phase;

  if (index !== state.lastChapterIndex) {
    state.lastChapterIndex = index;
    renderChapterNavigation();
    if (state.inspectorMode !== 'inspect' || (state.selected.type === 'node' && ['agent', 'authority', 'core'].includes(state.selected.id))) renderInspector();
  }
}

function renderTimeline() {
  const activeScenario = scenario();
  const percent = Math.min(100, (state.time / activeScenario.duration) * 100);
  const input = q('[data-timeline]');
  input.max = String(activeScenario.duration);
  input.value = String(Math.round(state.time));
  q('[data-timeline-progress]').style.width = `${percent}%`;
  q('[data-current-time]').textContent = formatTime(state.time);
  q('[data-total-time]').textContent = formatTime(activeScenario.duration);
}

function renderChapterNavigation() {
  const nav = q('[data-chapter-nav]');
  const markers = q('[data-timeline-markers]');
  const activeIndex = currentChapterIndex();
  nav.innerHTML = scenario().chapters.map((chapter, index) => `<button type="button" data-seek="${chapter.time}" class="${index === activeIndex ? 'is-active' : ''}">${escapeHtml(chapter.name)}</button>`).join('');
  markers.innerHTML = scenario().chapters.slice(1, -1).map((chapter) => `<i style="left:${(chapter.time / scenario().duration) * 100}%"></i>`).join('');
}

function itemEvents(selection = state.selected) {
  if (selection.type === 'event') return scenario().events.filter((event) => event.id === selection.id);
  return scenario().events.filter((event) => ROUTE_NODES[event.route]?.includes(selection.id));
}

function auditRows(events) {
  const elapsed = events.filter((event) => event.start <= state.time);
  if (!elapsed.length) return '<li><time>—</time><span>No mission event has reached this component yet.</span></li>';
  return elapsed.map((event) => `<li><time>${formatTime(event.start)}</time><span><strong>${escapeHtml(event.label)}</strong><br>${escapeHtml(event.source)} → ${escapeHtml(event.target)}</span></li>`).join('');
}

function prettyJson(value) { return escapeHtml(JSON.stringify(value, null, 2)); }

const OP_ICON_PATHS = Object.freeze({
  browser: '<rect x="3" y="4" width="18" height="15" rx="2"></rect><path d="M3 8h18M7 6h.1M10 6h.1"></path>',
  mission: '<circle cx="12" cy="12" r="8.2"></circle><circle cx="12" cy="12" r="3"></circle><path d="M12 1.8v3M12 19.2v3M1.8 12h3M19.2 12h3"></path>',
  provider: '<path d="M5 7.2h14v9.6H5zM8 7.2V4.5h8v2.7M8 19.5h8M12 16.8v2.7"></path><circle cx="8" cy="12" r="1"></circle><path d="M11 12h5"></path>',
  pulse: '<circle cx="12" cy="12" r="9"></circle><path d="M2.8 12h4l1.8-4.2 3.2 8.4 2.2-5.1 1.3.9h5.9"></path>',
  lock: '<rect x="5" y="10" width="14" height="10.5" rx="2.2"></rect><path d="M8 10V7.5a4 4 0 0 1 8 0V10M12 14v3"></path>',
  proof: '<path d="M5.2 2.8h9l4.6 4.6v13.8H5.2V2.8ZM14.2 2.8v4.6h4.6"></path><path d="m8.5 14 2.2 2.2 4.8-5"></path>',
  branch: '<path d="M7 4v16M7 9h7a4 4 0 0 0 4-4V4M7 15h7a4 4 0 0 1 4 4v1"></path><circle cx="7" cy="3" r="1.6"></circle><circle cx="18" cy="3" r="1.6"></circle><circle cx="18" cy="21" r="1.6"></circle>',
  deployment: '<path d="m12 3 7 3.6-7 3.6-7-3.6L12 3Z"></path><path d="m5 11.2 7 3.6 7-3.6M5 15.8l7 3.6 7-3.6"></path>',
  status: '<path d="M3.5 4.2h17v12.5H9l-4.2 3v-3H3.5V4.2Z"></path><circle cx="7" cy="10.5" r="1.1"></circle><path d="M10.3 8.3h6.5M10.3 12.5h4.5"></path>',
  quarantine: '<path d="M12 2.8 19 5.5v5.7c0 4.4-2.7 7.8-7 10-4.3-2.2-7-5.6-7-10V5.5L12 2.8Z"></path><path d="m9 9 6 6M15 9l-6 6"></path>',
  check: '<path d="m4.5 12.5 4.5 4.3L19.5 6.5"></path><circle cx="12" cy="12" r="9"></circle>',
});

const OP_BRAND_MARKS = Object.freeze({
  codex: '<path d="M12 3.7a5.2 5.2 0 0 1 5.2 5.2v3.3L12 15.3l-2.8-1.7"></path><path d="M12 3.7a5.2 5.2 0 0 1 5.2 5.2v3.3L12 15.3l-2.8-1.7" transform="rotate(60 12 12)"></path><path d="M12 3.7a5.2 5.2 0 0 1 5.2 5.2v3.3L12 15.3l-2.8-1.7" transform="rotate(120 12 12)"></path><path d="M12 3.7a5.2 5.2 0 0 1 5.2 5.2v3.3L12 15.3l-2.8-1.7" transform="rotate(180 12 12)"></path><path d="M12 3.7a5.2 5.2 0 0 1 5.2 5.2v3.3L12 15.3l-2.8-1.7" transform="rotate(240 12 12)"></path><path d="M12 3.7a5.2 5.2 0 0 1 5.2 5.2v3.3L12 15.3l-2.8-1.7" transform="rotate(300 12 12)"></path>',
  mcp: '<path d="m6 17 5.2-9a4 4 0 0 1 6.4 4l-4.8 8a3.2 3.2 0 0 1-5.6-3.2l4.8-8M8.8 7 6.5 4.8M15.2 19l2.3 2.2"></path>',
  toolbraid: '<path d="M3.2 7.2C6.1 2.8 9.2 2.8 12 7.2l4.7 7.3c1.5 2.4 3 2.5 4.1.3"></path><path d="M3.2 16.8c2.9 4.4 6 4.4 8.8 0l4.7-7.3c1.5-2.4 3-2.5 4.1-.3"></path><circle cx="12" cy="12" r="1.7"></circle>',
  chrome: '<path class="chrome-arc chrome-red" d="M12 3a9 9 0 0 1 7.8 4.5H12"></path><path class="chrome-arc chrome-yellow" d="M19.8 7.5A9 9 0 0 1 12 21l3.9-6.8"></path><path class="chrome-arc chrome-green" d="M12 21a9 9 0 0 1 0-18l3.9 6.8"></path><circle class="chrome-center" cx="12" cy="12" r="3.8"></circle>',
});

function opIcon(name) {
  return `<svg viewBox="0 0 24 24" aria-hidden="true">${OP_ICON_PATHS[name] ?? OP_ICON_PATHS.provider}</svg>`;
}

function opBrand(name) {
  return `<svg viewBox="0 0 24 24" aria-hidden="true">${OP_BRAND_MARKS[name]}</svg>`;
}

function opsItem(icon, title, detail, itemState, tone = '') {
  return `<li class="ops-item"><span class="ops-item-icon">${opIcon(icon)}</span><span class="ops-item-copy"><strong>${escapeHtml(title)}</strong><small>${escapeHtml(detail)}</small></span><span class="ops-item-state"${tone ? ` data-tone="${escapeHtml(tone)}"` : ''}>${escapeHtml(itemState)}</span></li>`;
}

function operationalSnapshot() {
  const activeScenario = scenario();
  const elapsed = activeScenario.events.filter((event) => event.start <= state.time);
  const discovered = elapsed.some((event) => event.id.includes('registry') || event.tool === 'getTools' || event.tool === 'document.modelContext.getTools');
  const quarantined = elapsed.filter((event) => event.payload?.result === 'DESCRIPTOR_QUARANTINED' || event.id.includes('hostile') || event.id.includes('metadata')).length;
  const receipts = elapsed.filter((event) => event.id.includes('receipt') || event.tool === 'postcondition.observe').length;
  const explicitApprovals = Number(state.approvals.rollback) + Number(state.approvals.publish);
  const replayedApprovals = activeScenario.id === 'recovery'
    ? elapsed.filter((event) => ['redeploy', 'publish'].includes(event.id)).length
    : 0;
  const approvals = Math.max(explicitApprovals, replayedApprovals);
  const toolCatalog = {
    recovery: [
      ['branch', 'read_github_commit', 'Repository evidence', 'READ'],
      ['deployment', 'read_vercel_deployment', 'Deployment state', 'READ'],
      ['status', 'read_x_post', 'Visible status evidence', 'READ'],
      ['deployment', 'redeploy_vercel_deployment', 'Exact production effect', 'APPROVAL'],
      ['status', 'publish_x_post', 'Exact communication effect', 'APPROVAL'],
    ],
    incident: [
      ['deployment', 'read_vercel_deployment', 'Primary health source', 'READ'],
      ['branch', 'read_github_commit', 'Compatible fallback', 'READ'],
      ['proof', 'audit.append', 'Fallback receipt', 'LOCAL'],
    ],
    attack: [
      ['provider', 'getTools', 'Untrusted descriptor scan', 'READ'],
      ['quarantine', 'forged_descriptor', 'Excluded before mapping', 'BLOCKED'],
      ['lock', 'verify_execution_context', 'Origin and nonce guard', 'LOCAL'],
    ],
  }[activeScenario.id];
  const packs = activeScenario.id === 'incident' ? 2 : 3;
  return {
    elapsed,
    discovered,
    quarantined,
    receipts,
    approvals,
    toolCatalog,
    packs,
    progress: Math.round((state.time / activeScenario.duration) * 100),
    chapter: activeScenario.chapters[currentChapterIndex()],
  };
}

function definitionRows(entries) {
  return entries.map(([key, value]) => '<div><dt>' + escapeHtml(key) + '</dt><dd>' + escapeHtml(value) + '</dd></div>').join('');
}

function currentBrowserContext() {
  const contexts = {
    recovery: {
      page: 'https://deploy.toolbraid.test/recovery',
      title: 'Failed deployment · recovery fixture',
      tab: '1044942 · frame 0',
      session: 'session:replay-7F3A',
      fingerprint: '5a1b9971df242403…',
      provenance: 'Universal · sandbox replay',
    },
    incident: {
      page: 'https://status.toolbraid.test/incident',
      title: 'Service incident · evidence fixture',
      tab: '1044943 · frame 0',
      session: 'session:replay-A91C',
      fingerprint: '8e4ca1010b73a145…',
      provenance: 'Verified adapter · sandbox replay',
    },
    attack: {
      page: 'https://registry.toolbraid.test/challenge',
      title: 'Authority challenge · hostile fixture',
      tab: '1044944 · frame 0',
      session: 'session:replay-C44E',
      fingerprint: 'd71f84a9c2e03b1f…',
      provenance: 'Generated tool · quarantined fixture',
    },
  };
  return contexts[state.scenarioId];
}

function renderProductNavigation() {
  document.body.dataset.activeProductView = state.productView;
  for (const button of qa('.product-rail [data-product-view]')) {
    const active = button.dataset.productView === state.productView;
    button.classList.toggle('is-active', active);
    if (active) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  }
  for (const panel of qa('[data-product-panel]')) panel.hidden = panel.dataset.productPanel !== state.productView;
}

function renderLiveWorkspace() {
  const context = currentBrowserContext();
  const marks = {
    codex: opBrand('codex'),
    mcp: opBrand('mcp'),
    native: opIcon('provider'),
    chrome: opBrand('chrome'),
    toolbraid: opBrand('toolbraid'),
  };
  for (const mark of qa('[data-bridge-mark]')) mark.innerHTML = marks[mark.dataset.bridgeMark] ?? '';
  const badge = q('[data-bridge-badge]');
  const stateCopy = {
    connected: 'Connected replay',
    checking: 'Rechecking route',
    offline: 'Bridge offline',
  }[state.bridgeState];
  badge.dataset.state = state.bridgeState;
  badge.innerHTML = '<i></i>' + escapeHtml(stateCopy);
  q('[data-bridge-lane]').dataset.state = state.bridgeState;
  q('[data-bridge-updated]').textContent = 'Handshake ' + formatTime(state.bridgeStamp);
  q('[data-live-context]').innerHTML = definitionRows([
    ['Mode', context.provenance],
    ['Origin', new URL(context.page).origin],
    ['Page', context.page],
    ['Title', context.title],
    ['Tab / frame', context.tab],
    ['Session', context.session],
    ['Snapshot', context.fingerprint],
  ]);
  q('[data-action="refresh-bridge"]').disabled = state.bridgeState === 'checking';
  const toggle = q('[data-action="toggle-bridge"]');
  toggle.disabled = state.bridgeState === 'checking';
  toggle.textContent = state.bridgeState === 'offline' ? 'Recover replay route' : 'Replay disconnect';
  q('[data-bridge-transport]').textContent = state.bridgeState === 'connected' ? 'Native pipe ready' : state.bridgeState === 'checking' ? 'Handshake in progress' : 'Native pipe closed';
  q('[data-bridge-permission]').textContent = state.bridgeState === 'offline' ? 'Grant retained · route closed' : 'Exact origin granted';
  q('[data-bridge-owner]').textContent = state.bridgeState === 'offline' ? 'No active route owner' : context.session;
  q('[data-bridge-drift]').textContent = state.bridgeState === 'offline' ? 'No dispatch possible' : 'Fail closed';
}

function evidenceRecords(snapshot) {
  const context = currentBrowserContext();
  const providerReads = snapshot.elapsed.filter((event) => event.tone === 'evidence' && (event.tool.startsWith('read_') || event.tool.includes('snapshot')));
  const lastRead = providerReads.at(-1);
  return [
    {
      code: 'DOM',
      title: 'DOM / ARIA snapshot',
      detail: context.fingerprint + ' · exact page binding',
      label: 'BOUND',
      state: 'ready',
    },
    {
      code: 'WEB',
      title: 'Structured provider reads',
      detail: providerReads.length ? providerReads.length + ' records · latest ' + lastRead?.tool : 'Waiting for the read phase',
      label: providerReads.length ? 'READY' : 'WAITING',
      state: providerReads.length ? 'ready' : 'none',
    },
    {
      code: 'IMG',
      title: 'Visible-frame metadata',
      detail: 'Replay frame reference · no raw screenshot retained',
      label: 'EPHEMERAL',
      state: 'ready',
    },
    {
      code: 'VID',
      title: 'Rendered video keyframes',
      detail: 'No rendered top-frame video in this mission fixture',
      label: 'NONE',
      state: 'none',
    },
    {
      code: 'AUD',
      title: 'Rendered audio and captions',
      detail: 'Optional provider path · no media bytes captured',
      label: 'NONE',
      state: 'none',
    },
    {
      code: 'QRT',
      title: 'Quarantined evidence',
      detail: snapshot.quarantined ? snapshot.quarantined + ' hostile descriptor excluded before mapping' : 'No hostile descriptor observed yet',
      label: snapshot.quarantined ? 'BLOCKED' : 'CLEAR',
      state: snapshot.quarantined ? 'blocked' : 'ready',
    },
  ];
}

function renderEvidenceWorkspace() {
  const snapshot = operationalSnapshot();
  const reads = snapshot.elapsed.filter((event) => event.tone === 'evidence' && event.tool.startsWith('read_')).length;
  const badge = q('[data-evidence-badge]');
  const evidenceCopy = {
    ready: state.provider.mode === 'configured' ? 'Provider preview ready' : 'Metadata ready',
    analyzing: 'Analyzing ' + state.evidenceProgress + '%',
    cancelled: 'Analysis cancelled',
  }[state.evidenceState] ?? 'Metadata ready';
  badge.dataset.state = state.evidenceState === 'analyzing' ? 'checking' : 'connected';
  badge.innerHTML = '<i></i>' + escapeHtml(evidenceCopy);
  q('[data-evidence-total]').textContent = String(snapshot.elapsed.length + 1);
  q('[data-evidence-reads]').textContent = String(reads);
  q('[data-evidence-quarantined]').textContent = String(snapshot.quarantined);
  q('[data-evidence-progress-label]').textContent = state.evidenceState === 'analyzing' ? state.evidenceProgress + '% LOCAL SCAN' : state.evidenceState.toUpperCase();
  const progress = q('[data-evidence-progress]');
  progress.hidden = state.evidenceState !== 'analyzing';
  progress.style.setProperty('--progress', state.evidenceProgress + '%');
  q('[data-action="analyze-evidence"]').disabled = state.evidenceState === 'analyzing';
  q('[data-action="cancel-evidence"]').hidden = state.evidenceState !== 'analyzing';
  q('[data-evidence-records]').innerHTML = evidenceRecords(snapshot).map((record) =>
    '<article class="evidence-record" data-state="' + escapeHtml(record.state) + '">' +
      '<i>' + escapeHtml(record.code) + '</i>' +
      '<span><strong>' + escapeHtml(record.title) + '</strong><small>' + escapeHtml(record.detail) + '</small></span>' +
      '<b>' + escapeHtml(record.label) + '</b>' +
    '</article>'
  ).join('');
  q('[data-provider-mode]').textContent = state.provider.mode === 'configured' ? 'PREVIEW SAVED' : 'METADATA ONLY';
  q('[data-provider-note]').textContent = state.provider.mode === 'configured'
    ? state.provider.endpointOrigin + ' · ' + (state.provider.visionModel || 'vision model unset') + ' · no request sent'
    : 'No endpoint configured. Deterministic metadata remains available.';
}

function approvalStatus(scope) {
  if (state.scenarioId !== 'recovery') return 'not-required';
  if (state.approvals.complete) return 'executed';
  if (state.denials[scope]) return 'denied';
  if (state.approvals[scope]) return 'approved';
  if (state.blockedAtBoundary) return 'ready';
  return 'locked';
}

function decisionLabel(event) {
  const scope = APPROVAL_ENVELOPES[event.scope]?.title ?? event.scope;
  return scope + ' · ' + event.decision;
}

function pushDecision(scope, decision) {
  state.decisionEvents.push({
    id: 'decision-' + (state.decisionEvents.length + 1),
    start: state.time,
    label: decisionLabel({ scope, decision }),
    tone: decision === 'denied' ? 'threat' : decision === 'executed' ? 'effect' : 'authority',
    tool: 'human.authority',
    source: 'Trusted side-panel gesture',
    target: 'Audit chain',
    route: 'prepare-authority',
    scope,
    decision,
    payload: { scope, decision, oneTime: true, credentials: false },
  });
}

function renderApprovalsWorkspace() {
  const badge = q('[data-approval-view-badge]');
  const executeButtons = qa('[data-action="execute"]');
  if (state.scenarioId !== 'recovery') {
    badge.classList.remove('view-status-warning');
    badge.dataset.state = 'connected';
    badge.innerHTML = '<i></i>No mutation path';
    q('[data-approval-count]').textContent = '0 EXTERNAL EFFECTS';
    q('[data-approval-records]').innerHTML = '<div class="receipt-empty">This mission proves a read-only or rejection path. It creates no external approval surface.</div>';
    q('[data-approval-history]').innerHTML = '<li><time>—</time><span>No human decision is required.</span></li>';
    q('[data-envelope-title]').textContent = 'No approval required';
    q('[data-envelope-status]').textContent = 'NOT APPLICABLE';
    q('[data-approval-envelope]').innerHTML = definitionRows([
      ['Mission', scenario().name],
      ['External effects', '0'],
      ['Outcome', 'Read-only or rejected before dispatch'],
    ]);
    q('[data-envelope-arguments]').textContent = '{}';
    for (const button of qa('[data-approval-decision]')) button.disabled = true;
    for (const button of executeButtons) button.disabled = true;
    return;
  }

  const scopes = ['rollback', 'publish'];
  const approvedCount = scopes.filter((scope) => state.approvals[scope]).length;
  const ready = state.blockedAtBoundary;
  const complete = state.approvals.complete;
  badge.classList.toggle('view-status-warning', !complete);
  badge.dataset.state = complete ? 'connected' : 'checking';
  badge.innerHTML = '<i></i>' + (complete ? 'Execution sealed' : ready ? 'Your decision required' : 'Evidence first');
  q('[data-approval-count]').textContent = approvedCount + ' / 2 APPROVED';
  q('[data-approval-records]').innerHTML = scopes.map((scope, index) => {
    const envelope = APPROVAL_ENVELOPES[scope];
    const status = approvalStatus(scope);
    return '<button class="approval-record' + (state.approvalSelection === scope ? ' is-selected' : '') + '" type="button" data-approval-record="' + scope + '" data-status="' + status + '">' +
      '<i>0' + (index + 1) + '</i>' +
      '<span><strong>' + escapeHtml(envelope.title) + '</strong><small>' + escapeHtml(envelope.provider) + ' · ' + escapeHtml(envelope.tool) + '</small></span>' +
      '<b>' + escapeHtml(status.toUpperCase()) + '</b>' +
    '</button>';
  }).join('');

  q('[data-approval-history]').innerHTML = state.decisionEvents.length
    ? state.decisionEvents.slice().reverse().map((event) => '<li><time>' + formatTime(event.start) + '</time><span>' + escapeHtml(decisionLabel(event)) + '</span></li>').join('')
    : '<li><time>—</time><span>No trusted decision has been recorded.</span></li>';

  const selected = state.approvalSelection;
  const envelope = APPROVAL_ENVELOPES[selected];
  const status = approvalStatus(selected);
  q('[data-envelope-title]').textContent = envelope.title;
  q('[data-envelope-status]').textContent = status.toUpperCase();
  q('[data-approval-envelope]').innerHTML = definitionRows([
    ['Origin', envelope.origin],
    ['Provider tool', envelope.tool],
    ['Schema', envelope.schema],
    ['Target', envelope.target],
    ['Predicted effect', envelope.effect],
    ['Risk class', envelope.risk],
    ['Expiry', envelope.expiry],
    ['Page fingerprint', envelope.fingerprint],
    ['Nonce', complete ? 'consumed · replay rejected' : 'unclaimed · one time'],
  ]);
  q('[data-envelope-arguments]').textContent = JSON.stringify(envelope.arguments, null, 2);
  for (const button of qa('[data-approval-decision]')) {
    button.dataset.approvalScope = selected;
    button.disabled = !ready || complete;
  }
  for (const button of executeButtons) button.disabled = !(ready && state.approvals.rollback && state.approvals.publish && !complete);
}

function allAuditRecords() {
  return [
    ...scenario().events.filter((event) => event.start <= state.time),
    ...state.decisionEvents,
  ].sort((left, right) => left.start - right.start || left.id.localeCompare(right.id));
}

function replayHash(record, index) {
  const input = scenario().id + '|' + record.id + '|' + record.start + '|' + record.label + '|' + index;
  let hash = 2166136261;
  for (let cursor = 0; cursor < input.length; cursor += 1) {
    hash ^= input.charCodeAt(cursor);
    hash = Math.imul(hash, 16777619);
  }
  return 'replay:' + (hash >>> 0).toString(16).padStart(8, '0');
}

function receiptRecords() {
  return allAuditRecords().filter((event) => event.id.includes('receipt') || event.tool === 'postcondition.observe' || event.decision === 'executed');
}

function renderAuditWorkspace() {
  const records = allAuditRecords();
  const receipts = receiptRecords();
  const sealed = state.time >= scenario().duration;
  const visible = state.auditExpanded ? records : records.slice(-10);
  const badge = q('[data-audit-badge]');
  badge.dataset.state = sealed ? 'connected' : 'checking';
  badge.innerHTML = '<i></i>' + (sealed ? 'Replay chain sealed' : 'Chain open');
  q('[data-receipt-count]').textContent = receipts.length + ' RECORD' + (receipts.length === 1 ? '' : 'S');
  q('[data-receipt-records]').innerHTML = receipts.length
    ? receipts.map((event, index) => {
      const verified = event.tool === 'postcondition.observe' || event.payload?.integrity === 'verified' || event.decision === 'executed';
      return '<article class="receipt-record"><i>✓</i><div><strong>' + escapeHtml(event.label) + '</strong><small>' +
        escapeHtml(event.source) + ' → ' + escapeHtml(event.target) + ' · ' +
        (verified ? 'browser-observed or local decision proof' : 'dispatch receipt only') +
        '</small><code>' + escapeHtml(replayHash(event, index)) + '</code></div></article>';
    }).join('')
    : '<div class="receipt-empty">Receipts appear only after a read fallback, rejection proof, supported postcondition or trusted execution decision reaches the chain.</div>';
  const sealEvent = records.findLast((event) => event.tool === 'audit.seal');
  q('[data-audit-head]').textContent = sealEvent?.payload?.head
    ? 'fixture:' + sealEvent.payload.head
    : sealed
      ? 'fixture:' + replayHash(records.at(-1) ?? { id: 'empty', start: 0, label: 'empty' }, records.length)
      : 'sha256:pending…';
  q('[data-full-audit-chain]').innerHTML = visible.length
    ? visible.map((event, index) => '<li><time>' + formatTime(event.start) + '</time><i></i><span><strong>' +
      escapeHtml(event.label) + '</strong>' + escapeHtml(event.source) + ' → ' + escapeHtml(event.target) +
      '</span><code>' + escapeHtml(replayHash(event, index)) + '</code></li>').join('')
    : '<li><time>—</time><i></i><span><strong>Objective ready</strong>No retained event has reached the local replay chain.</span><code>replay:pending</code></li>';
  q('[data-action="toggle-audit"]').textContent = state.auditExpanded ? 'Show recent records only' : 'Show all retained records (' + records.length + ')';
}

function renderActiveProductView() {
  renderProductNavigation();
  if (state.productView === 'live') renderLiveWorkspace();
  if (state.productView === 'evidence') renderEvidenceWorkspace();
  if (state.productView === 'approvals') renderApprovalsWorkspace();
  if (state.productView === 'audit') renderAuditWorkspace();
}

function setProductView(view, { focus = true } = {}) {
  if (!PRODUCT_VIEWS.includes(view)) return;
  if (view !== 'topology') pause();
  state.productView = view;
  renderActiveProductView();
  const panel = q('[data-product-panel="' + view + '"]');
  if (focus) panel?.focus({ preventScroll: true });
}

function refreshBridge() {
  const generation = ++state.bridgeGeneration;
  state.bridgeState = 'checking';
  renderLiveWorkspace();
  showToast('Bridge handshake replay', 'Verifying the page-bound MCP route without sending a live request.', 'info');
  window.setTimeout(() => {
    if (generation !== state.bridgeGeneration) return;
    state.bridgeState = 'connected';
    state.bridgeStamp = state.time;
    if (state.productView === 'live') renderLiveWorkspace();
    showToast('Bridge route verified', 'Codex remains a caller; extension-owned UI retains mutation authority.', 'success');
  }, 720);
}

function toggleBridgeReplay() {
  if (state.bridgeState === 'checking') return;
  if (state.bridgeState === 'offline') {
    refreshBridge();
    return;
  }
  state.bridgeGeneration += 1;
  state.bridgeState = 'offline';
  renderLiveWorkspace();
  showToast('Bridge route closed', 'The local replay now exposes the offline, zero-dispatch state.', 'warning');
}

function centerMobileStage() {
  if (!window.matchMedia('(max-width: 820px)').matches) return;
  const viewport = q('.stage-viewport');
  if (!viewport || viewport.scrollWidth <= viewport.clientWidth) return;
  viewport.scrollLeft = Math.max(0, (viewport.scrollWidth - viewport.clientWidth) / 2);
}

function startEvidenceAnalysis() {
  if (state.evidenceTimer) window.clearInterval(state.evidenceTimer);
  state.evidenceState = 'analyzing';
  state.evidenceProgress = 0;
  renderEvidenceWorkspace();
  showToast('Local evidence scan started', 'Only deterministic replay records and metadata are inspected.', 'info');
  state.evidenceTimer = window.setInterval(() => {
    state.evidenceProgress = Math.min(100, state.evidenceProgress + 10);
    if (state.evidenceProgress >= 100) {
      window.clearInterval(state.evidenceTimer);
      state.evidenceTimer = null;
      state.evidenceState = 'ready';
      showToast('Evidence scan complete', 'No raw page, video, audio or credential bytes were retained.', 'success');
    }
    if (state.productView === 'evidence') renderEvidenceWorkspace();
  }, 110);
}

function cancelEvidenceAnalysis() {
  if (state.evidenceTimer) window.clearInterval(state.evidenceTimer);
  state.evidenceTimer = null;
  state.evidenceState = 'cancelled';
  if (state.productView === 'evidence') renderEvidenceWorkspace();
  showToast('Evidence scan cancelled', 'Metadata remains available and no partial provider result is claimed.', 'warning');
}

function saveProviderPreview(form) {
  const data = new FormData(form);
  const endpoint = String(data.get('endpoint') ?? '').trim();
  if (!endpoint) {
    showToast('Endpoint required', 'Enter one exact HTTPS origin or keep metadata-only mode.', 'warning');
    q('[name="endpoint"]', form)?.focus();
    return;
  }
  let parsed;
  try {
    parsed = new URL(endpoint);
  } catch {
    showToast('Endpoint is invalid', 'Use an exact HTTPS origin.', 'danger');
    q('[name="endpoint"]', form)?.focus();
    return;
  }
  const localHttp = parsed.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname);
  if (parsed.protocol !== 'https:' && !localHttp) {
    showToast('Endpoint rejected', 'Only HTTPS or an explicit loopback HTTP origin is accepted.', 'danger');
    q('[name="endpoint"]', form)?.focus();
    return;
  }
  state.provider = {
    mode: 'configured',
    endpointOrigin: parsed.origin,
    visionModel: String(data.get('visionModel') ?? '').trim().slice(0, 80),
    audioModel: String(data.get('audioModel') ?? '').trim().slice(0, 80),
  };
  const key = q('[name="apiKey"]', form);
  if (key) key.value = '';
  renderEvidenceWorkspace();
  showToast('Provider preview saved', 'The API key was cleared and no network request was sent.', 'success');
}

function useMetadataOnly(form = q('[data-provider-form]')) {
  state.provider = { mode: 'metadata', endpointOrigin: '', visionModel: '', audioModel: '' };
  form?.reset();
  renderEvidenceWorkspace();
  showToast('Metadata-only mode active', 'Universal evidence remains deterministic and fully usable.', 'info');
}

function denyApproval(scope) {
  if (!state.blockedAtBoundary || !(scope in APPROVAL_ENVELOPES) || state.approvals.complete) return;
  state.approvals[scope] = false;
  state.denials[scope] = true;
  pushDecision(scope, 'denied');
  renderApprovalDock();
  renderApprovalsWorkspace();
  showToast('Exact effect denied', APPROVAL_ENVELOPES[scope].title + ' remains behind the human boundary.', 'warning');
}

function exportAudit() {
  const records = allAuditRecords().map((record, index) => ({
    sequence: index + 1,
    timestamp: formatTime(record.start),
    event: record.label,
    source: record.source,
    target: record.target,
    tool: record.tool,
    hash: replayHash(record, index),
    payload: record.payload,
  }));
  const payload = {
    kind: 'toolbraid-sandbox-replay',
    scenario: scenario().id,
    objective: scenario().objective,
    liveMutation: false,
    records,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'toolbraid-' + scenario().id + '-replay-audit.json';
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
  showToast('Redacted replay exported', 'The local file contains fixture events only.', 'success');
}

let helpReturnTarget = null;

function openHelp() {
  helpReturnTarget = document.activeElement;
  q('[data-drawer-backdrop]').hidden = false;
  q('[data-help-drawer]').hidden = false;
  q('[data-action="open-help"]').setAttribute('aria-expanded', 'true');
  q('[data-action="close-help"]').focus();
}

function closeHelp({ restoreFocus = true } = {}) {
  q('[data-drawer-backdrop]').hidden = true;
  q('[data-help-drawer]').hidden = true;
  q('[data-action="open-help"]').setAttribute('aria-expanded', 'false');
  if (restoreFocus && helpReturnTarget instanceof HTMLElement) helpReturnTarget.focus();
  helpReturnTarget = null;
}

function renderOperationalInspector(mode) {
  const snapshot = operationalSnapshot();
  const activeScenario = scenario();
  const commonHero = (eyebrow, title, summary, chips = '') => `<section class="ops-hero"><span class="ops-eyebrow">${escapeHtml(eyebrow)}</span><h3>${escapeHtml(title)}</h3><p>${escapeHtml(summary)}</p>${chips ? `<div class="ops-chip-row">${chips}</div>` : ''}</section>`;
  const pill = (text, tone = '') => `<span class="ops-pill"${tone ? ` data-tone="${tone}"` : ''}>${escapeHtml(text)}</span>`;
  const modeData = { title: 'ToolBraid operations', status: 'replay', content: '' };

  if (mode === 'context') {
    modeData.title = 'Exact browser context';
    modeData.status = 'bound';
    modeData.content = `${commonHero('ACTIVE CONTEXT', 'Agent-to-page binding', 'The replay keeps the same authority model as the extension: exact page ownership, local bridge identity and no credential transfer.', `${pill('session bound', 'ready')}${pill('sandbox replay')}`)}
      <div class="ops-chain" aria-label="Codex to Chrome bridge"><span class="ops-chain-node"><i data-brand="codex">${opBrand('codex')}</i><b>Codex</b><small>agent</small></span><i class="ops-chain-link"></i><span class="ops-chain-node"><i data-brand="mcp">${opBrand('mcp')}</i><b>MCP</b><small>transport</small></span><i class="ops-chain-link"></i><span class="ops-chain-node"><i data-brand="toolbraid">${opBrand('toolbraid')}</i><b>ToolBraid</b><small>policy</small></span><i class="ops-chain-link"></i><span class="ops-chain-node"><i data-brand="chrome">${opBrand('chrome')}</i><b>Chrome</b><small>page</small></span></div>
      <section class="ops-section"><div class="ops-section-head"><strong>Exact ownership</strong><span>LOCAL ONLY</span></div><div class="ops-metrics"><div class="ops-metric"><small>Tab / frame</small><strong>active / 0</strong></div><div class="ops-metric"><small>Origin</small><strong>bound</strong></div><div class="ops-metric"><small>Drift</small><strong>${state.scenarioId === 'attack' && state.time >= 15800 ? 'rejected' : 'none'}</strong></div></div><code class="ops-code">pageFingerprint: sandbox:${escapeHtml(activeScenario.id)}:exact-context</code></section>
      <p class="ops-warning">The live extension retains the real tab, frame, session, origin and page fingerprint. This local surface shows representative replay state only.</p>`;
  } else if (mode === 'mission') {
    modeData.title = 'Multi-page mission';
    modeData.status = snapshot.chapter.phase;
    const members = [
      ['browser', 'Active Chrome page', 'Exact tab and origin', scheduledState('chrome')],
      ['branch', 'GitHub member', 'Repository evidence', scheduledState('github')],
      ['deployment', 'Vercel member', 'Deployment context', scheduledState('vercel')],
      ['status', 'X member', 'Visible publication surface', scheduledState('x')],
    ];
    modeData.content = `${commonHero('MULTI-PAGE CONTINUITY', activeScenario.name, activeScenario.objective, `${pill(`chapter ${currentChapterIndex() + 1}/${activeScenario.chapters.length}`)}${pill(state.blockedAtBoundary ? 'pending authority' : 'exact ownership', state.blockedAtBoundary ? 'warning' : 'ready')}`)}
      <section class="ops-section"><div class="ops-section-head"><strong>Mission progress</strong><span>${snapshot.progress}%</span></div><div class="ops-progress"><i style="width:${snapshot.progress}%"></i></div></section>
      <section class="ops-section"><div class="ops-section-head"><strong>Bound members</strong><span>4 / 16 MAX</span></div><ul class="ops-list">${members.map(([icon, title, detail, memberState]) => opsItem(icon, title, detail, memberState, memberState === 'complete' ? 'ready' : memberState === 'degraded' ? 'warning' : '')).join('')}</ul></section>`;
  } else if (mode === 'tools') {
    modeData.title = 'Tools and capability packs';
    modeData.status = snapshot.discovered ? 'retained' : 'waiting';
    const rows = snapshot.toolCatalog.map(([icon, title, detail, toolState]) => opsItem(icon, title, detail, snapshot.discovered ? toolState : 'WAITING', toolState === 'BLOCKED' ? 'danger' : toolState === 'APPROVAL' ? 'warning' : snapshot.discovered ? 'ready' : ''));
    modeData.content = `${commonHero('DISCOVERY', 'Verified tool surface', 'Static trusted packs expose only exact GitHub, Vercel and X page shapes. Invalid or instruction-like descriptors stay outside the executable registry.', `${pill(`${snapshot.packs} trusted packs`, 'ready')}${pill(`${snapshot.quarantined} quarantined`, snapshot.quarantined ? 'danger' : '')}`)}
      <div class="ops-metrics"><div class="ops-metric"><small>Active packs</small><strong>${snapshot.discovered ? snapshot.packs : 0}</strong></div><div class="ops-metric"><small>Retained tools</small><strong>${snapshot.discovered ? snapshot.toolCatalog.length : 0}</strong></div><div class="ops-metric"><small>Budget</small><strong>${snapshot.discovered ? snapshot.toolCatalog.length : 0} / 32</strong></div></div>
      <section class="ops-section"><div class="ops-section-head"><strong>Current capability surface</strong><span>FAIL CLOSED</span></div><ul class="ops-list">${rows.join('')}</ul></section>`;
  } else if (mode === 'media') {
    modeData.title = 'Multimodal evidence';
    modeData.status = 'metadata only';
    modeData.content = `${commonHero('MULTIMODAL CONTEXT', 'Evidence without authority', 'Visible images, rendered video keyframes, audio and captions can enrich read evidence, but media never creates action authority.', `${pill('metadata only', 'warning')}${pill('ephemeral capture')}`)}
      <section class="ops-section"><div class="ops-section-head"><strong>Current replay media</strong><span>0 RETAINED BYTES</span></div><ul class="ops-list">${opsItem('pulse', 'Visual frames', 'Bound screenshot or rendered keyframes', 'AVAILABLE')}${opsItem('status', 'Captions and text tracks', 'Normalized as untrusted evidence', 'NONE')}${opsItem('pulse', 'Audio stream', 'Optional session provider', 'NONE')}</ul></section>
      <p class="ops-warning">The live provider is disabled by default. Any endpoint permission is exact-origin and its API key remains in extension session storage.</p>`;
  } else if (mode === 'human') {
    modeData.title = 'Secure human handoff';
    modeData.status = state.blockedAtBoundary ? 'approval waiting' : 'no handoff';
    modeData.content = `${commonHero('INTERVENTION HANDOFF', 'Credentials stay with you', 'Login, MFA, passkeys and CAPTCHA challenges are returned to an exact-origin human surface. ToolBraid resumes only after trusted completion proof.', `${pill(state.blockedAtBoundary ? 'approval waiting' : 'no active handoff', state.blockedAtBoundary ? 'warning' : 'ready')}${pill('credentials never stored')}`)}
      <section class="ops-section"><div class="ops-section-head"><strong>Supported human-only steps</strong><span>5–15 MIN TTL</span></div><ul class="ops-list">${opsItem('lock', 'Login or passkey', 'Exact-origin approved surface', 'USER')}${opsItem('lock', 'One-time code / MFA', 'No code retained by ToolBraid', 'USER')}${opsItem('check', 'CAPTCHA checkbox', 'One eligible user-authorized attempt', 'EXPERIMENTAL', 'warning')}</ul></section>
      <p class="ops-warning">Challenge solving and CAPTCHA iframe traversal remain with the user. The agent cannot manufacture handoff completion.</p>`;
  } else if (mode === 'proof') {
    modeData.title = 'Receipts and audit proof';
    modeData.status = snapshot.receipts ? 'recorded' : 'pending';
    const sealComplete = state.time >= activeScenario.duration;
    modeData.content = `${commonHero('EXECUTION PROOF', 'From intent to retained receipt', 'Every decision and supported postcondition returns to an inspectable local chain. Generic dispatch is never relabelled as remote success.', `${pill(`${snapshot.approvals}/2 approvals`, snapshot.approvals === 2 ? 'ready' : 'warning')}${pill(`${snapshot.receipts} receipts`, snapshot.receipts ? 'ready' : '')}`)}
      <div class="ops-metrics"><div class="ops-metric"><small>Audit records</small><strong>${snapshot.elapsed.length}</strong></div><div class="ops-metric"><small>Receipts</small><strong>${snapshot.receipts}</strong></div><div class="ops-metric"><small>Seal</small><strong>${sealComplete ? 'closed' : 'open'}</strong></div></div>
      <section class="ops-section"><div class="ops-section-head"><strong>Recent causal records</strong><span>APPEND ONLY</span></div><ol class="audit-list">${auditRows(snapshot.elapsed.slice(-5))}</ol><code class="ops-code">replay-chain: ${escapeHtml(activeScenario.id)} · ${snapshot.elapsed.length} bounded records</code></section>
      <p class="ops-warning">This concept visualizes the production audit contract; it is not presented as a signed external audit log.</p>`;
  }

  return modeData;
}

function resolvedNodeInfo(nodeId) {
  const base = NODE_INFO[nodeId] ?? NODE_INFO.core;
  const chapter = scenario().chapters[currentChapterIndex()];
  if (nodeId === 'core') {
    return {
      ...base,
      details: { ...base.details, Current: activeEvent()?.label ?? chapter.now },
      payload: { ...base.payload, scenario: scenario().id, objective: scenario().objective },
    };
  }
  if (nodeId === 'agent') {
    return { ...base, payload: { ...base.payload, objective: scenario().objective } };
  }
  if (nodeId === 'authority') {
    return { ...base, details: { ...base.details, State: scheduledState('authority') } };
  }
  return base;
}

function renderInspector() {
  const inspector = q('.inspector');
  const kickerByMode = {
    inspect: 'Context inspector',
    context: 'Browser ownership',
    mission: 'Mission continuity',
    tools: 'Capability registry',
    media: 'Evidence capture',
    human: 'Human authority',
    proof: 'Outcome verification',
  };
  inspector.dataset.mode = state.inspectorMode;
  q('[data-inspector-kicker]').textContent = kickerByMode[state.inspectorMode] ?? 'ToolBraid operations';
  for (const button of qa('[data-inspector-mode]')) {
    const active = button.dataset.inspectorMode === state.inspectorMode;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-pressed', String(active));
  }
  if (state.inspectorMode !== 'inspect') {
    const view = renderOperationalInspector(state.inspectorMode);
    q('#inspector-title').textContent = view.title;
    q('[data-inspector-status]').innerHTML = `<i></i>${escapeHtml(view.status)}`;
    q('[data-inspector-body]').innerHTML = view.content;
    return;
  }
  const event = state.selected.type === 'event' ? scenario().events.find((candidate) => candidate.id === state.selected.id) : null;
  const info = event ? {
    kicker: 'Communication packet',
    title: event.label,
    summary: `${event.source} communicates with ${event.target} through an inspectable ToolBraid event.`,
    tags: [event.tone, event.tool, `${formatTime(event.start)} event`],
    details: { Source: event.source, Target: event.target, Tool: event.tool, Route: event.route },
    payload: event.payload,
  } : resolvedNodeInfo(state.selected.id);
  const status = event ? event.tone : scheduledState(state.selected.id);
  q('#inspector-title').textContent = info.title;
  q('[data-inspector-status]').innerHTML = `<i></i>${escapeHtml(status)}`;
  const events = itemEvents();
  const tags = info.tags.map((tag) => `<span>${escapeHtml(tag)}</span>`).join('');
  const details = Object.entries(info.details).map(([key, value]) => `<div><dt>${escapeHtml(key)}</dt><dd>${escapeHtml(value)}</dd></div>`).join('');

  let content;
  if (state.inspectorTab === 'payload') {
    content = `<section class="inspector-hero"><small>Bound payload</small><h3>${escapeHtml(info.title)}</h3><p>Concept data is representative and contains no credential, raw login URL or live mutation authority.</p></section><section class="inspector-section"><small>Structured event</small><pre class="payload-code">${prettyJson(info.payload)}</pre></section>`;
  } else if (state.inspectorTab === 'audit') {
    content = `<section class="inspector-hero"><small>Causal history</small><h3>${escapeHtml(info.title)}</h3><p>Every event remains connected to its source, target and place in the mission timeline.</p></section><section class="inspector-section"><small>Events observed by current time</small><ol class="audit-list">${auditRows(events)}</ol></section>`;
  } else {
    content = `<section class="inspector-hero"><small>${escapeHtml(info.kicker)}</small><h3>${escapeHtml(info.title)}</h3><p>${escapeHtml(info.summary)}</p><div class="inspector-tags">${tags}</div></section><section class="inspector-section"><small>Exact role</small><dl>${details}</dl></section>`;
  }
  q('[data-inspector-body]').innerHTML = content;
  for (const tab of qa('[data-inspector-tab]')) tab.setAttribute('aria-selected', String(tab.dataset.inspectorTab === state.inspectorTab));
}

function relatedRoutesForSelection(selection) {
  if (!selection) return [];
  if (selection.type === 'event') return [scenario().events.find((event) => event.id === selection.id)?.route].filter(Boolean);
  return Object.entries(ROUTE_NODES).filter(([, nodes]) => nodes.includes(selection.id)).map(([route]) => route);
}

function renderHighlight() {
  const selection = state.hovered ?? state.selected;
  const routes = new Set(relatedRoutesForSelection(selection));
  const nodes = new Set(selection ? [selection.id] : []);
  for (const route of routes) for (const node of ROUTE_NODES[route] ?? []) nodes.add(node);
  const inspecting = Boolean(selection);
  q('.routes').classList.toggle('is-inspecting', inspecting);
  q('.nodes').classList.toggle('is-inspecting', inspecting);
  for (const route of qa('.route')) route.classList.toggle('is-related', routes.has(route.dataset.route));
  for (const node of qa('.graph-node')) {
    node.classList.toggle('is-related', nodes.has(node.dataset.node));
    node.classList.toggle('is-selected', state.selected.type === 'node' && state.selected.id === node.dataset.node);
  }
}

function renderApprovalDock() {
  const dock = q('[data-approval-dock]');
  dock.hidden = !state.blockedAtBoundary;
  for (const scope of ['rollback', 'publish']) {
    const button = q('[data-approve="' + scope + '"]');
    const status = approvalStatus(scope);
    button.setAttribute('aria-pressed', String(state.approvals[scope]));
    button.dataset.status = status;
    q('[data-approval-state="' + scope + '"]').textContent = state.denials[scope] ? 'Denied' : state.approvals[scope] ? 'Approved ✓' : 'Review';
  }
  for (const button of qa('[data-action="execute"]')) {
    button.disabled = !(state.blockedAtBoundary && state.approvals.rollback && state.approvals.publish && !state.approvals.complete);
  }
}

function render() {
  renderNarrative();
  renderTimeline();
  renderNodes();
  renderRoutes();
  renderPackets();
  renderApprovalDock();
  renderHighlight();
  setPlayIcon();
  if (state.productView !== 'topology') renderActiveProductView();
}

function pause() {
  state.playing = false;
  state.lastFrame = null;
  if (state.animationFrame) cancelAnimationFrame(state.animationFrame);
  state.animationFrame = null;
  setPlayIcon();
}

function animationTick(timestamp) {
  if (!state.playing) return;
  if (state.lastFrame === null) state.lastFrame = timestamp;
  const delta = Math.min(80, timestamp - state.lastFrame) * state.rate;
  state.lastFrame = timestamp;
  const activeScenario = scenario();
  const previous = state.time;
  state.time = Math.min(activeScenario.duration, state.time + delta);

  if (activeScenario.boundary !== null
      && previous < activeScenario.boundary
      && state.time >= activeScenario.boundary
      && !state.approvals.complete) {
    state.time = activeScenario.boundary;
    state.blockedAtBoundary = true;
    pause();
    showToast('Human checkpoint reached', 'Two exact effects are prepared. The agent cannot continue without you.', 'warning');
    render();
    return;
  }

  if (state.time >= activeScenario.duration) {
    state.time = activeScenario.duration;
    pause();
    showToast('Mission replay complete', activeScenario.chapters.at(-1).detail, 'success');
    render();
    return;
  }
  render();
  state.animationFrame = requestAnimationFrame(animationTick);
}

function play() {
  if (state.time >= scenario().duration) resetMission({ keepSelection: true });
  if (state.blockedAtBoundary) return;
  state.playing = true;
  state.lastFrame = null;
  setPlayIcon();
  state.animationFrame = requestAnimationFrame(animationTick);
}

function togglePlay() { state.playing ? pause() : play(); }

function seek(milliseconds, { playAfter = false } = {}) {
  pause();
  state.blockedAtBoundary = false;
  state.time = Math.max(0, Math.min(scenario().duration, Number(milliseconds) || 0));
  state.lastChapterIndex = -1;
  render();
  if (state.inspectorMode !== 'inspect') renderInspector();
  if (playAfter) play();
}

function resetMission({ keepSelection = false } = {}) {
  pause();
  if (state.evidenceTimer) window.clearInterval(state.evidenceTimer);
  state.evidenceTimer = null;
  state.time = 0;
  state.blockedAtBoundary = false;
  state.approvals = { rollback: false, publish: false, complete: false };
  state.denials = { rollback: false, publish: false };
  state.decisionEvents = [];
  state.approvalSelection = 'rollback';
  state.auditExpanded = false;
  state.evidenceState = 'ready';
  state.evidenceProgress = 100;
  state.bridgeState = 'connected';
  state.bridgeStamp = 0;
  state.bridgeGeneration += 1;
  state.lastChapterIndex = -1;
  if (!keepSelection) state.selected = { type: 'node', id: 'core' };
  renderInspector();
  render();
}

function setScenario(scenarioId) {
  if (!SCENARIOS[scenarioId] || scenarioId === state.scenarioId) return;
  state.scenarioId = scenarioId;
  state.selected = { type: 'node', id: 'core' };
  for (const button of qa('[data-scenario]')) {
    const active = button.dataset.scenario === scenarioId;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-pressed', String(active));
  }
  rebuildPackets();
  resetMission({ keepSelection: true });
  showToast('Mission changed', `${scenario().name} is ready for interactive replay.`, 'info');
}

function selectItem(selection) {
  state.selected = selection;
  state.hovered = null;
  state.inspectorMode = 'inspect';
  renderInspector();
  renderHighlight();
  q('.inspector').classList.add('is-open');
}

function showToast(title, detail, tone = 'info') {
  const region = q('[data-toast-region]');
  while (region.children.length >= 3) region.firstElementChild?.remove();
  const toast = document.createElement('article');
  toast.className = 'toast';
  toast.dataset.tone = tone;
  toast.innerHTML = `<i></i><div><strong>${escapeHtml(title)}</strong><small>${escapeHtml(detail)}</small></div>`;
  region.append(toast);
  window.setTimeout(() => toast.remove(), 3900);
}

function approve(scope) {
  if (!state.blockedAtBoundary || !(scope in state.approvals)) return;
  state.approvals[scope] = !state.approvals[scope];
  state.denials[scope] = false;
  pushDecision(scope, state.approvals[scope] ? 'approved' : 'revoked');
  renderApprovalDock();
  if (state.productView === 'approvals') renderApprovalsWorkspace();
  if (state.productView === 'audit') renderAuditWorkspace();
  if (state.inspectorMode !== 'inspect') renderInspector();
  showToast(state.approvals[scope] ? 'Exact effect approved' : 'Approval removed', scope === 'rollback' ? 'Vercel redeploy envelope updated.' : 'X publication envelope updated.', state.approvals[scope] ? 'success' : 'warning');
}

function executeApproved() {
  if (!state.blockedAtBoundary || !(state.approvals.rollback && state.approvals.publish) || state.approvals.complete) return;
  pushDecision('rollback', 'executed');
  pushDecision('publish', 'executed');
  state.approvals.complete = true;
  state.blockedAtBoundary = false;
  state.time = Math.max(state.time, scenario().boundary + 500);
  showToast('Authority claimed once', 'Only the two approved effects can cross the boundary.', 'success');
  render();
  if (state.inspectorMode !== 'inspect') renderInspector();
  play();
}

function followNextPacket() {
  const events = itemEvents();
  const next = events.find((event) => event.start > state.time) ?? events[0];
  if (!next) {
    showToast('No packet on this path', 'Select another component or replay the mission.', 'warning');
    return;
  }
  state.selected = { type: 'event', id: next.id };
  state.inspectorMode = 'inspect';
  renderInspector();
  seek(Math.max(0, next.start - 500), { playAfter: true });
}

function replaySegment() {
  const events = itemEvents();
  const target = state.selected.type === 'event' ? events[0] : events.find((event) => event.start <= state.time && event.start + event.duration >= state.time) ?? events[0];
  if (!target) return;
  seek(Math.max(0, target.start - 650), { playAfter: true });
}

function initializeInteractions() {
  for (const node of qa('.graph-node')) {
    const selection = { type: 'node', id: node.dataset.node };
    node.addEventListener('pointerenter', () => { state.hovered = selection; renderHighlight(); });
    node.addEventListener('pointerleave', () => { state.hovered = null; renderHighlight(); });
    node.addEventListener('click', () => selectItem(selection));
    node.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      selectItem(selection);
    });
  }

  document.addEventListener('click', (event) => {
    const productButton = event.target.closest('button[data-product-view]');
    if (productButton) {
      setProductView(productButton.dataset.productView);
      return;
    }
    const scenarioButton = event.target.closest('[data-scenario]');
    if (scenarioButton) { setScenario(scenarioButton.dataset.scenario); return; }
    const approvalRecord = event.target.closest('[data-approval-record]');
    if (approvalRecord) {
      state.approvalSelection = approvalRecord.dataset.approvalRecord;
      renderApprovalsWorkspace();
      return;
    }
    const decision = event.target.closest('[data-approval-decision]');
    if (decision) {
      const scope = decision.dataset.approvalScope;
      if (decision.dataset.approvalDecision === 'approve') approve(scope);
      if (decision.dataset.approvalDecision === 'deny') denyApproval(scope);
      return;
    }
    const modeButton = event.target.closest('[data-inspector-mode]');
    if (modeButton) {
      state.inspectorMode = modeButton.dataset.inspectorMode;
      renderInspector();
      q('.inspector').classList.add('is-open');
      return;
    }
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (action === 'toggle-play') togglePlay();
    if (action === 'reset') { resetMission(); showToast('Mission reset', 'The local event replay returned to the objective.', 'info'); }
    if (action === 'close-inspector') q('.inspector').classList.remove('is-open');
    if (action === 'execute') executeApproved();
    if (action === 'follow-packet') followNextPacket();
    if (action === 'replay-segment') replaySegment();
    if (action === 'refresh-bridge') refreshBridge();
    if (action === 'toggle-bridge') toggleBridgeReplay();
    if (action === 'analyze-evidence') startEvidenceAnalysis();
    if (action === 'cancel-evidence') cancelEvidenceAnalysis();
    if (action === 'metadata-only') useMetadataOnly();
    if (action === 'toggle-audit') { state.auditExpanded = !state.auditExpanded; renderAuditWorkspace(); }
    if (action === 'export-audit') exportAudit();
    if (action === 'open-help') openHelp();
    if (action === 'close-help') closeHelp();
    if (action === 'inspect-context') {
      state.inspectorMode = 'context';
      setProductView('topology', { focus: false });
      renderInspector();
      q('.inspector').classList.add('is-open');
    }
    const approval = event.target.closest('[data-approve]');
    if (approval) approve(approval.dataset.approve);
    const tab = event.target.closest('[data-inspector-tab]');
    if (tab) { state.inspectorTab = tab.dataset.inspectorTab; renderInspector(); }
    const seekButton = event.target.closest('[data-seek]');
    if (seekButton) seek(Number(seekButton.dataset.seek));
    const rateButton = event.target.closest('[data-rate]');
    if (rateButton) {
      state.rate = Number(rateButton.dataset.rate);
      for (const button of qa('[data-rate]')) button.classList.toggle('is-active', button === rateButton);
    }
  });

  q('[data-timeline]').addEventListener('input', (event) => seek(event.target.value));
  q('[data-provider-form]').addEventListener('submit', (event) => {
    event.preventDefault();
    saveProviderPreview(event.currentTarget);
  });
  q('[data-drawer-backdrop]').addEventListener('click', () => closeHelp());

  document.addEventListener('keydown', (event) => {
    const help = q('[data-help-drawer]');
    if (event.key === 'Escape') {
      if (!help.hidden) closeHelp();
      else q('.inspector').classList.remove('is-open');
      return;
    }
    if (!help.hidden && event.key === 'Tab') {
      const focusable = qa('button, a[href], input, [tabindex="0"]', help).filter((element) => !element.disabled && !element.hidden);
      const first = focusable[0];
      const last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      return;
    }
    if (event.target.closest('input, textarea, select, button, [role="button"]')) return;
    const viewIndex = Number(event.key) - 1;
    if (Number.isInteger(viewIndex) && PRODUCT_VIEWS[viewIndex]) {
      event.preventDefault();
      setProductView(PRODUCT_VIEWS[viewIndex]);
      return;
    }
    if (event.code === 'Space' && state.productView === 'topology') {
      event.preventDefault();
      togglePlay();
    }
  });

  const viewport = q('.stage-viewport');
  viewport.addEventListener('pointermove', (event) => {
    const rect = viewport.getBoundingClientRect();
    viewport.style.setProperty('--mx', `${((event.clientX - rect.left) / rect.width) * 100}%`);
    viewport.style.setProperty('--my', `${((event.clientY - rect.top) / rect.height) * 100}%`);
  });

  document.addEventListener('visibilitychange', () => { if (document.hidden) pause(); });
}

function initialize() {
  const params = new URLSearchParams(window.location.search);
  const requestedScenario = params.get('scenario');
  if (requestedScenario && SCENARIOS[requestedScenario]) state.scenarioId = requestedScenario;
  const requestedPanel = params.get('panel');
  if (['inspect', 'context', 'mission', 'tools', 'media', 'human', 'proof'].includes(requestedPanel)) state.inspectorMode = requestedPanel;
  const requestedView = params.get('view');
  if (PRODUCT_VIEWS.includes(requestedView)) state.productView = requestedView;
  const requestedTime = Number(params.get('t'));
  if (Number.isFinite(requestedTime) && requestedTime >= 0) state.time = Math.min(requestedTime, scenario().duration);
  if (params.get('gate') === '1' && scenario().boundary !== null) {
    state.time = scenario().boundary;
    state.blockedAtBoundary = true;
  }
  for (const button of qa('[data-scenario]')) {
    const active = button.dataset.scenario === state.scenarioId;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-pressed', String(active));
  }
  rebuildPackets();
  initializeInteractions();
  renderChapterNavigation();
  renderInspector();
  render();
  renderActiveProductView();
  window.requestAnimationFrame(() => window.requestAnimationFrame(centerMobileStage));
  window.setTimeout(centerMobileStage, 140);
  if (state.inspectorMode !== 'inspect') q('.inspector').classList.add('is-open');
  if (params.get('autoplay') === '1') play();
}

initialize();
