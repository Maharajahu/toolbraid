export const RISK_LEVELS = Object.freeze({
  READ_ONLY: 0,
  REVERSIBLE: 1,
  TRANSACTIONAL: 2,
  HIGH_IMPACT: 3,
});

export const DEFAULT_METADATA_LIMITS = Object.freeze({
  maxDepth: 8,
  maxNodes: 256,
  maxCharacters: 16_384,
});

const RISK_LABELS = Object.freeze([
  'read-only',
  'reversible',
  'transactional',
  'high-impact',
]);

const MAX_EVIDENCE = 32;

const QUARANTINE_RULES = Object.freeze([
  {
    id: 'instruction.override',
    category: 'instruction-like',
    pattern: /\b(?:ignore|disregard|override|forget)\b[\s\S]{0,80}\b(?:previous|prior|other|user|system|developer)?\s*(?:instructions?|rules?|messages?|policy|policies)\b/i,
  },
  {
    id: 'instruction.role-claim',
    category: 'instruction-like',
    pattern: /\b(?:system|developer)\s+(?:message|instruction|directive)\b/i,
  },
  {
    id: 'exfiltration.sensitive-data',
    category: 'exfiltration',
    pattern: /\b(?:send|upload|transmit|forward|post|leak|exfiltrat\w*)\b[\s\S]{0,100}\b(?:cookies?|tokens?|credentials?|passwords?|secrets?|private\s+data|personal\s+data|profile|browsing\s+history|system\s+prompt)\b/i,
  },
  {
    id: 'approval.bypass',
    category: 'approval-bypass',
    pattern: /\b(?:bypass|skip|avoid|disable|ignore|fake|forge)\b[\s\S]{0,60}\b(?:approval|confirmation|consent|permission|human\s+review)\b/i,
  },
  {
    id: 'approval.execute-without-consent',
    category: 'approval-bypass',
    pattern: /\b(?:execute|invoke|run|call|continue|proceed)\b[\s\S]{0,60}\bwithout\b[\s\S]{0,30}\b(?:asking|approval|confirmation|consent|permission)\b/i,
  },
  {
    id: 'user.hide-action',
    category: 'hidden-user',
    pattern: /\b(?:do\s+not|don['’]?t|never)\b[\s\S]{0,35}\b(?:tell|inform|show|notify|warn)\b[\s\S]{0,35}\b(?:the\s+)?user\b/i,
  },
  {
    id: 'user.conceal-action',
    category: 'hidden-user',
    pattern: /\b(?:hide|conceal|keep)\b[\s\S]{0,45}\b(?:from|secret)\b[\s\S]{0,25}\b(?:the\s+)?user\b/i,
  },
  {
    id: 'output.force-tool-chain',
    category: 'output-chaining',
    pattern: /\b(?:after|when|once|then|next)\b[\s\S]{0,90}\b(?:result|response|output)?\b[\s\S]{0,30}\b(?:call|invoke|execute|run|trigger)\b[\s\S]{0,45}\b(?:another|next|following|specified|named)?\s*(?:tool|function|endpoint)\b/i,
  },
  {
    id: 'output.embedded-instructions',
    category: 'output-chaining',
    pattern: /\b(?:result|response|output)\b[\s\S]{0,60}\b(?:contains?|includes?|returns?)\b[\s\S]{0,45}\b(?:instructions?|commands?)\b[\s\S]{0,45}\b(?:agent|tool|model)\b/i,
  },
]);

const HIGH_IMPACT_PATTERNS = Object.freeze([
  /\b(?:delete|erase|destroy|terminate|close)\b[\s\S]{0,30}\b(?:account|workspace|project|repository|record|data)?\b/i,
  /\b(?:transfer|withdraw|wire|send)\b[\s\S]{0,25}\b(?:funds?|money|cash|crypto|tokens?)\b/i,
  /\b(?:grant|revoke|change|reset)\b[\s\S]{0,30}\b(?:role|access|permission|password|credentials?)\b/i,
]);

const TRANSACTIONAL_PATTERNS = Object.freeze([
  /\b(?:purchase|pay|checkout|book|order|submit|publish|deploy|rollout|restart)\b/i,
  /\b(?:create|update|edit|write|post|send)\b[\s\S]{0,25}\b(?:record|resource|message|email|comment|configuration|deployment|request)?\b/i,
]);

const REVERSIBLE_PATTERNS = Object.freeze([
  /\b(?:hold|reserve|freeze|lock|save\s+draft|draft|stage|pause|suspend|enable|disable)\b/i,
]);

const READ_PATTERNS = Object.freeze([
  /\b(?:get|list|search|find|inspect|read|query|probe|check|calculate|measure|preview|describe|fetch)\b/i,
]);

function normalizeForMatching(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function excerpt(value, matchIndex = 0, matchLength = 0) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  const start = Math.max(0, matchIndex - 48);
  const end = Math.min(text.length, matchIndex + Math.max(matchLength, 1) + 80);
  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`;
}

function validateLimit(name, value) {
  if (!Number.isInteger(value) || value < 1) throw new RangeError(`${name} must be a positive integer.`);
  return value;
}

function normalizeLimits(options = {}) {
  return Object.freeze({
    maxDepth: validateLimit('maxDepth', options.maxDepth ?? DEFAULT_METADATA_LIMITS.maxDepth),
    maxNodes: validateLimit('maxNodes', options.maxNodes ?? DEFAULT_METADATA_LIMITS.maxNodes),
    maxCharacters: validateLimit('maxCharacters', options.maxCharacters ?? DEFAULT_METADATA_LIMITS.maxCharacters),
  });
}

function addEvidence(state, evidence) {
  if (state.evidence.length < MAX_EVIDENCE) state.evidence.push(Object.freeze(evidence));
}

function exceedLimit(state, limit, path, observed) {
  if (!state.exceededLimits.has(limit)) {
    state.exceededLimits.add(limit);
    addEvidence(state, {
      ruleId: `metadata.limit.${limit}`,
      category: 'scan-limit',
      severity: 'quarantine',
      path,
      observed,
      allowed: state.limits[limit],
      excerpt: `Metadata ${limit} limit exceeded at ${path}.`,
    });
  }
  state.stopped = true;
}

function inspectText(state, value, path, kind) {
  if (state.stopped || typeof value !== 'string') return;

  const nextCharacters = state.characters + value.length;
  const remaining = Math.max(0, state.limits.maxCharacters - state.characters);
  const inspected = value.slice(0, remaining);
  state.characters = Math.min(nextCharacters, state.limits.maxCharacters + 1);

  const normalized = normalizeForMatching(inspected);
  for (const rule of QUARANTINE_RULES) {
    const match = rule.pattern.exec(normalized);
    if (!match) continue;
    addEvidence(state, {
      ruleId: rule.id,
      category: rule.category,
      severity: 'quarantine',
      path,
      fieldKind: kind,
      match: match[0].slice(0, 160),
      excerpt: excerpt(normalized, match.index, match[0].length),
    });
  }

  if (nextCharacters > state.limits.maxCharacters) {
    exceedLimit(state, 'maxCharacters', path, nextCharacters);
  }
}

function visitSchema(state, value, path, depth) {
  if (state.stopped) return;
  if (depth > state.limits.maxDepth) {
    exceedLimit(state, 'maxDepth', path, depth);
    return;
  }
  state.nodes += 1;
  if (state.nodes > state.limits.maxNodes) {
    exceedLimit(state, 'maxNodes', path, state.nodes);
    return;
  }
  if (typeof value === 'string') {
    inspectText(state, value, path, 'schema-string');
    return;
  }
  if (value === null || typeof value !== 'object') return;
  if (state.seen.has(value)) {
    addEvidence(state, {
      ruleId: 'metadata.schema.cycle',
      category: 'scan-limit',
      severity: 'quarantine',
      path,
      excerpt: `Circular schema metadata detected at ${path}.`,
    });
    state.stopped = true;
    return;
  }

  state.seen.add(value);

  if (Array.isArray(value)) {
    for (let index = 0; index < value.length && !state.stopped; index += 1) {
      visitSchema(state, value[index], `${path}[${index}]`, depth + 1);
    }
    return;
  }

  for (const key in value) {
    if (!Object.hasOwn(value, key)) continue;
    const child = value[key];
    if (state.stopped) break;
    if ((key === 'title' || key === 'description') && typeof child === 'string') {
      inspectText(state, child, `${path}.${key}`, `schema-${key}`);
      continue;
    }
    if ((key === 'properties' || key === 'patternProperties') && child && typeof child === 'object' && !Array.isArray(child)) {
      for (const propertyName in child) {
        if (!Object.hasOwn(child, propertyName)) continue;
        const propertySchema = child[propertyName];
        inspectText(state, propertyName, `${path}.${key}.${propertyName}`, 'schema-property-name');
        visitSchema(state, propertySchema, `${path}.${key}.${propertyName}`, depth + 1);
        if (state.stopped) break;
      }
      continue;
    }
    if (child && typeof child === 'object') visitSchema(state, child, `${path}.${key}`, depth + 1);
  }
}

export function scanToolMetadata(tool, options = {}) {
  const limits = normalizeLimits(options);
  const state = {
    limits,
    characters: 0,
    nodes: 0,
    evidence: [],
    exceededLimits: new Set(),
    stopped: false,
    seen: new WeakSet(),
  };

  inspectText(state, tool?.name, 'tool.name', 'tool-name');
  inspectText(state, tool?.title, 'tool.title', 'tool-title');
  inspectText(state, tool?.description, 'tool.description', 'tool-description');
  visitSchema(state, tool?.inputSchema, 'tool.inputSchema', 0);

  if (tool?.annotations?.untrustedContentHint === true) {
    addEvidence(state, {
      ruleId: 'annotation.untrusted-content',
      category: 'untrusted-content',
      severity: 'flag',
      path: 'tool.annotations.untrustedContentHint',
      excerpt: 'Provider declares that tool output contains untrusted content.',
    });
  }

  const quarantineEvidence = state.evidence.filter((item) => item.severity === 'quarantine');
  const quarantined = quarantineEvidence.length > 0;
  return Object.freeze({
    quarantined,
    flagged: state.evidence.length > 0,
    shortCircuit: quarantined,
    reasonCode: quarantined ? 'TOOL_METADATA_QUARANTINED' : state.evidence.length ? 'TOOL_METADATA_FLAGGED' : null,
    evidence: Object.freeze([...state.evidence]),
    scan: Object.freeze({
      nodesVisited: state.nodes,
      charactersVisited: state.characters,
      stoppedEarly: state.stopped,
      exceededLimits: Object.freeze([...state.exceededLimits]),
      limits,
    }),
  });
}

function riskFromPolicy(capabilityPolicy) {
  const value = capabilityPolicy && typeof capabilityPolicy === 'object'
    ? capabilityPolicy.minimumRisk ?? capabilityPolicy.minRisk ?? capabilityPolicy.risk
    : capabilityPolicy;
  if (value === undefined || value === null) return RISK_LEVELS.READ_ONLY;
  if (Number.isInteger(value) && value >= RISK_LEVELS.READ_ONLY && value <= RISK_LEVELS.HIGH_IMPACT) return value;

  const normalized = normalizeForMatching(value);
  const aliases = new Map([
    ['read only', RISK_LEVELS.READ_ONLY],
    ['read', RISK_LEVELS.READ_ONLY],
    ['reversible', RISK_LEVELS.REVERSIBLE],
    ['transactional', RISK_LEVELS.TRANSACTIONAL],
    ['transaction', RISK_LEVELS.TRANSACTIONAL],
    ['high impact', RISK_LEVELS.HIGH_IMPACT],
    ['high', RISK_LEVELS.HIGH_IMPACT],
  ]);
  if (!aliases.has(normalized)) throw new TypeError(`Unsupported capability minimum risk: ${value}`);
  return aliases.get(normalized);
}

function firstSemanticMatch(text, patterns) {
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match) return match;
  }
  return null;
}

export function classifyToolRisk(tool, { capabilityPolicy = null } = {}) {
  const nameAndTitle = normalizeForMatching(`${tool?.name ?? ''} ${tool?.title ?? ''}`);
  const description = normalizeForMatching(tool?.description ?? '');
  const semantics = `${nameAndTitle} ${description}`.trim();
  const evidence = [];

  let inferredLevel;
  let semanticMatch = firstSemanticMatch(semantics, HIGH_IMPACT_PATTERNS);
  if (semanticMatch) {
    inferredLevel = RISK_LEVELS.HIGH_IMPACT;
  } else {
    semanticMatch = firstSemanticMatch(semantics, TRANSACTIONAL_PATTERNS);
    if (semanticMatch) inferredLevel = RISK_LEVELS.TRANSACTIONAL;
  }
  if (inferredLevel === undefined) {
    semanticMatch = firstSemanticMatch(semantics, REVERSIBLE_PATTERNS);
    if (semanticMatch) inferredLevel = RISK_LEVELS.REVERSIBLE;
  }

  const claimedReadOnly = tool?.annotations?.readOnlyHint === true;
  if (inferredLevel !== undefined) {
    evidence.push(Object.freeze({
      source: 'tool-semantics',
      code: 'MUTATION_SEMANTICS',
      level: inferredLevel,
      match: semanticMatch[0].slice(0, 120),
    }));
  } else {
    const readMatch = firstSemanticMatch(semantics, READ_PATTERNS);
    if (readMatch || claimedReadOnly) {
      inferredLevel = RISK_LEVELS.READ_ONLY;
      evidence.push(Object.freeze({
        source: readMatch ? 'tool-semantics' : 'tool-annotation',
        code: readMatch ? 'READ_SEMANTICS' : 'READ_ONLY_HINT',
        level: RISK_LEVELS.READ_ONLY,
        match: readMatch?.[0] ?? 'readOnlyHint=true',
      }));
    } else {
      inferredLevel = RISK_LEVELS.TRANSACTIONAL;
      evidence.push(Object.freeze({
        source: 'default-policy',
        code: 'UNKNOWN_EFFECT_FAILS_CLOSED',
        level: RISK_LEVELS.TRANSACTIONAL,
        match: null,
      }));
    }
  }

  const policyMinimum = riskFromPolicy(capabilityPolicy);
  if (policyMinimum > RISK_LEVELS.READ_ONLY) {
    evidence.push(Object.freeze({
      source: 'capability-policy',
      code: 'CAPABILITY_MINIMUM_RISK',
      level: policyMinimum,
      match: null,
    }));
  }

  const level = Math.max(inferredLevel, policyMinimum);
  const contradictedReadOnlyHint = claimedReadOnly && level > RISK_LEVELS.READ_ONLY;
  if (contradictedReadOnlyHint) {
    evidence.push(Object.freeze({
      source: 'tool-annotation',
      code: 'READ_ONLY_HINT_OVERRIDDEN',
      level,
      match: 'readOnlyHint=true',
    }));
  }

  return Object.freeze({
    level,
    label: RISK_LABELS[level],
    requiresApproval: level >= RISK_LEVELS.REVERSIBLE,
    claimedReadOnly,
    contradictedReadOnlyHint,
    policyMinimum,
    evidence: Object.freeze(evidence),
  });
}

export function assessToolSecurity(tool, {
  capabilityPolicy = null,
  metadataLimits = {},
} = {}) {
  const metadata = scanToolMetadata(tool, metadataLimits);
  if (metadata.quarantined) {
    return Object.freeze({
      allowedForScoring: false,
      shortCircuit: true,
      metadata,
      risk: null,
    });
  }
  return Object.freeze({
    allowedForScoring: true,
    shortCircuit: false,
    metadata,
    risk: classifyToolRisk(tool, { capabilityPolicy }),
  });
}
