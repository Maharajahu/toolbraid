import { normalizeKey, tokenize } from './text.js';

export const RISK_LEVELS = Object.freeze({
  READ_ONLY: 0,
  REVERSIBLE: 1,
  TRANSACTIONAL: 2,
  HIGH_IMPACT: 3,
});

const SUSPICIOUS_PATTERNS = [
  /ignore (all|any|the) (previous|prior|other|user) (instructions|tools|rules)/i,
  /system prompt/i,
  /developer message/i,
  /reveal (your|the) (prompt|instructions|secrets?)/i,
  /send .* (credentials?|cookies?|tokens?|profile|private data)/i,
  /exfiltrat/i,
  /bypass (approval|security|policy|permission)/i,
  /do not tell (the )?user/i,
  /execute .* without (asking|approval|consent)/i,
];

export function scanToolMetadata(tool) {
  const material = `${tool?.name ?? ''}\n${tool?.title ?? ''}\n${tool?.description ?? ''}`;
  const matches = SUSPICIOUS_PATTERNS.filter((pattern) => pattern.test(material)).map((pattern) => pattern.source);
  const annotationFlag = Boolean(tool?.annotations?.untrustedContentHint);
  const severe = matches.length > 0;
  return {
    suspicious: severe || annotationFlag,
    quarantine: severe,
    annotationFlag,
    matches,
    reason: severe
      ? 'Tool metadata contains instruction-like or data-exfiltration language.'
      : annotationFlag
        ? 'Provider marked tool output or metadata as untrusted.'
        : null,
  };
}

function hasAny(tokens, candidates) {
  return [...tokens].some((token) => candidates.includes(token));
}

function stripNegatedTransactionLanguage(description) {
  return normalizeKey(description)
    .replace(/\b(?:no|not|without|does not|will not|never)\b(?:\s+\w+){0,6}\s+\b(?:payment|pay|purchase|book|booking|checkout)\b/g, ' ')
    .replace(/\bdoes not (?:purchase|book|pay)\b/g, ' ');
}

export function inferRisk(tool, capability = null) {
  const nameTokens = tokenize(`${tool?.name ?? ''} ${tool?.title ?? ''}`);
  const descriptionTokens = tokenize(stripNegatedTransactionLanguage(tool?.description ?? ''));
  const allTokens = new Set([...nameTokens, ...descriptionTokens, ...tokenize(capability?.id ?? '')]);

  if (hasAny(allTokens, ['delete', 'transfer', 'withdraw', 'close', 'terminate'])) {
    return RISK_LEVELS.HIGH_IMPACT;
  }

  // The declared action name is a stronger signal than explanatory copy. A tool
  // called purchase_now must never be downgraded by a friendly description.
  if (hasAny(nameTokens, ['purchase', 'pay', 'book', 'checkout', 'submit', 'send'])) {
    return RISK_LEVELS.TRANSACTIONAL;
  }

  if (hasAny(nameTokens, ['hold', 'reserve', 'freeze', 'lock', 'save', 'draft']) || capability?.action === 'reversible') {
    return RISK_LEVELS.REVERSIBLE;
  }

  if (hasAny(descriptionTokens, ['purchase', 'pay', 'book', 'checkout', 'submit', 'send'])) {
    return RISK_LEVELS.TRANSACTIONAL;
  }

  if (hasAny(descriptionTokens, ['hold', 'reserve', 'freeze', 'lock', 'save', 'draft'])) {
    return RISK_LEVELS.REVERSIBLE;
  }

  // A provider cannot use readOnlyHint to override mutation semantics because all
  // mutation checks happen above this point.
  if (tool?.annotations?.readOnlyHint === true || capability?.action === 'read') {
    return RISK_LEVELS.READ_ONLY;
  }
  return RISK_LEVELS.TRANSACTIONAL;
}

export function riskLabel(level) {
  return ['Read-only', 'Reversible change', 'Transaction', 'High impact'][level] ?? 'Unknown';
}

export function requiresApproval(level) {
  return level >= RISK_LEVELS.REVERSIBLE;
}
