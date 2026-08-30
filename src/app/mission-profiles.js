const GUIDE_STEPS = Object.freeze([
  'objective',
  'discovery',
  'mapping',
  'evidence',
  'security',
  'approval',
  'execution',
  'audit',
]);

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

const profiles = [
  {
    id: 'production-recovery',
    title: 'Recover Production',
    shortTitle: 'Production recovery',
    kicker: 'Full recovery mission',
    summary: 'Trace the checkout incident, prepare two exact effects, then execute only after separate human approvals.',
    objective: 'Diagnose checkout after the latest deployment, prepare a safe recovery and a customer update. Do not change production or publish without my approval.',
    completion: 'mutations',
    controlledFault: null,
    accent: 'cyan',
    icon: 'rollback',
    proof: '4 safe reads · 2 approvals · 2 receipts',
    constraints: ['Production', 'Read first', 'Exact approval'],
    outcome: {
      title: 'Checkout restored',
      summary: 'The verified release was restored, the reviewed update was published, and the audit chain was sealed.',
      authority: '2 explicit approvals',
    },
    guide: {
      objective: ['Objective is explicit and bounded.', 'The engine knows the outcome and what it must never do silently.', 'Discover the allowlisted provider origins.'],
      discovery: ['Native WebMCP registrations are being inspected.', 'Only tools exposed to this orchestrator can enter the mission.', 'Normalize safe capabilities and quarantine hostile metadata.'],
      mapping: ['Live tools were mapped to seven canonical capabilities.', 'The plan depends on semantics, not vendor-specific tool names.', 'Run the read-only evidence batch.'],
      evidence: ['Independent evidence is being correlated before any effect is prepared.', 'Recovery decisions remain grounded in live outputs and failover is auditable.', 'Prepare the exact rollback and customer update.'],
      security: ['Hostile metadata was excluded before scoring.', 'A provider cannot promote itself into an approval or execution path.', 'Present the two exact external effects.'],
      approval: ['Both external effects are locked.', 'Only a trusted human gesture can create separate, short-lived bindings.', 'Approve each exact effect or leave it locked.'],
      execution: ['Only the claimed approval pair can execute.', 'Origin, schema, arguments, effect and nonce are rechecked at dispatch.', 'Verify receipts and postconditions.'],
      audit: ['Receipts were committed and the SHA-256 chain was sealed.', 'The full decision path is independently inspectable.', 'Mission complete.'],
    },
  },
  {
    id: 'incident-trace',
    title: 'Trace an Incident',
    shortTitle: 'Incident trace',
    kicker: 'Read-only resilience mission',
    summary: 'Trigger a controlled primary probe failure, verify real provider fallback, and seal a read-only incident report.',
    objective: 'Trace the checkout incident across independent providers. Prove that read-only fallback works and seal the evidence. Do not stage, publish, or change production.',
    completion: 'read-only',
    controlledFault: 'primary-health-unavailable',
    accent: 'amber',
    icon: 'pulse',
    proof: 'Primary fails · fallback verified · sealed audit',
    constraints: ['Recovery lab', 'Read-only', 'No mutation'],
    outcome: {
      title: 'Incident traced safely',
      summary: 'The primary probe failed closed, the compatible fallback completed the read, and no external effect was prepared or executed.',
      authority: '0 mutations',
    },
    guide: {
      objective: ['The objective explicitly forbids every mutation.', 'Read-only completion is a first-class mission outcome.', 'Discover the allowlisted provider origins.'],
      discovery: ['Native registrations are being inspected.', 'The same origin and metadata boundary applies to investigation work.', 'Normalize the live capabilities.'],
      mapping: ['The health capability has a primary and a compatible fallback.', 'Provider substitution can preserve canonical semantics.', 'Run the controlled read-only incident trace.'],
      evidence: ['The primary health probe is failing inside the disposable recovery lab.', 'ToolBraid must fail closed, select only a compatible read fallback, and record both identities.', 'Seal the read-only evidence report.'],
      security: ['The hostile provider stayed quarantined while fallback remained eligible.', 'Failure handling never weakens the authority boundary.', 'Finish without preparing or executing a mutation.'],
      approval: ['No approval is requested.', 'A read-only objective must not manufacture a write path.', 'Proceed directly to the audit seal.'],
      execution: ['No external execution occurred.', 'The incident mission terminates on verified evidence.', 'Verify the evidence and fallback receipts.'],
      audit: ['The read-only chain was verified and sealed.', 'Judges can inspect the failed primary and selected fallback in one trail.', 'Mission complete.'],
    },
  },
  {
    id: 'authority-attack',
    title: 'Stop an Authority Attack',
    shortTitle: 'Authority attack',
    kicker: 'Fail-closed security mission',
    summary: 'Quarantine hostile tool metadata, reject execution-context drift, and prove a consumed approval nonce cannot be replayed.',
    objective: 'Audit the live tool registry for authority attacks. Quarantine hostile metadata and prove that origin drift and approval replay are rejected. Execute no external action.',
    completion: 'security',
    controlledFault: null,
    accent: 'coral',
    icon: 'lock',
    proof: 'Hostile metadata · drift blocked · replay blocked',
    constraints: ['Security lab', 'Fail closed', 'No dispatch'],
    outcome: {
      title: 'Authority attack stopped',
      summary: 'The hostile descriptor was quarantined, context drift was rejected, nonce replay was blocked, and no provider mutation was dispatched.',
      authority: '3 attacks blocked',
    },
    guide: {
      objective: ['The mission asks for proof, not a simulated success screen.', 'Every challenge must terminate before external dispatch.', 'Discover the live registry.'],
      discovery: ['Tool descriptions and schemas are being treated as untrusted input.', 'Instruction-like metadata cannot grant itself authority.', 'Normalize only the retained tools.'],
      mapping: ['Canonical mappings exclude the quarantined descriptor.', 'A hostile tool cannot become a primary or fallback candidate.', 'Run the authority challenges.'],
      evidence: ['The challenge uses the same approval verifier as production execution.', 'Security proof is generated from real rejection codes.', 'Check drift and one-time nonce enforcement.'],
      security: ['Hostile metadata, origin drift and nonce replay were all rejected.', 'No rejection path called a provider mutation.', 'Seal the security audit.'],
      approval: ['No human approval is requested by the attack test.', 'The harness can verify denial without minting production authority.', 'Proceed to the sealed rejection trail.'],
      execution: ['External dispatch count remains zero.', 'Rejected authority never crosses the browser boundary.', 'Verify the audit chain.'],
      audit: ['The rejection evidence was committed and sealed.', 'Each blocked challenge exposes its exact engine code.', 'Mission complete.'],
    },
  },
];

export const MISSION_GUIDE_STEPS = GUIDE_STEPS;
export const MISSION_PROFILES = deepFreeze(profiles);
export const DEFAULT_MISSION_PROFILE_ID = MISSION_PROFILES[0].id;

export function missionProfileById(profileId) {
  return MISSION_PROFILES.find(({ id }) => id === profileId) ?? MISSION_PROFILES[0];
}

export function resolveMissionProfile(search = '') {
  const params = new URLSearchParams(search);
  return missionProfileById(params.get('mission'));
}
