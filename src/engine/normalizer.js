import { sha256Hex, stableStringify } from './approval.js';
import { assessToolSecurity, classifyToolRisk } from './risk.js';

const DEFAULT_MINIMUM_CONFIDENCE = 0.52;
const DEFAULT_AMBIGUITY_MARGIN = 0.08;

const FIELD_WEIGHTS = Object.freeze({
  name: 4.0,
  title: 2.8,
  description: 1.45,
  schema: 2.35,
  phrase: 4.75,
  requiredConcept: 4.25,
});

const TOKEN_STOP_WORDS = new Set([
  'a', 'an', 'and', 'as', 'at', 'by', 'for', 'from', 'in', 'into', 'is', 'it',
  'of', 'on', 'or', 'the', 'this', 'to', 'with', 'tool', 'using', 'current',
]);

export class NormalizerError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'NormalizerError';
    this.code = code;
    this.details = details;
  }
}

function normalizeText(value) {
  return String(value ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_./:-]+/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function tokens(value) {
  return new Set(normalizeText(value).split(' ').filter((token) => token.length > 1 && !TOKEN_STOP_WORDS.has(token)));
}

function stringArray(value, field, capabilityId) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new NormalizerError('CAPABILITY_PACK_INVALID', `${field} must be an array of strings.`, {
      capabilityId,
      field,
    });
  }
  return value.map((entry) => entry.trim()).filter(Boolean);
}

function normalizeRequiredConcepts(capability) {
  const aliasesByConcept = capability.inputAliases ?? capability.conceptAliases ?? {};
  if (aliasesByConcept === null || typeof aliasesByConcept !== 'object' || Array.isArray(aliasesByConcept)) {
    throw new NormalizerError('CAPABILITY_PACK_INVALID', 'inputAliases must be an object.', { capabilityId: capability.id });
  }

  const required = capability.requiredConcepts ?? capability.requiredInputs ?? [];
  if (!Array.isArray(required)) {
    throw new NormalizerError('CAPABILITY_PACK_INVALID', 'requiredConcepts must be an array.', { capabilityId: capability.id });
  }

  return required.map((entry, index) => {
    const objectEntry = entry && typeof entry === 'object' && !Array.isArray(entry);
    const id = objectEntry ? entry.id ?? entry.concept ?? entry.name : entry;
    if (typeof id !== 'string' || !id.trim()) {
      throw new NormalizerError('CAPABILITY_PACK_INVALID', 'Every required concept needs a non-empty id.', {
        capabilityId: capability.id,
        index,
      });
    }
    const objectAliases = objectEntry ? stringArray(entry.aliases, 'requiredConcept.aliases', capability.id) : [];
    const mappedAliases = stringArray(aliasesByConcept[id], `inputAliases.${id}`, capability.id);
    return Object.freeze({ id: id.trim(), aliases: Object.freeze([...new Set([id, ...objectAliases, ...mappedAliases])]) });
  });
}

function compileCapability(capability) {
  if (!capability || typeof capability !== 'object' || Array.isArray(capability)) {
    throw new NormalizerError('CAPABILITY_PACK_INVALID', 'Every capability must be an object.');
  }
  if (typeof capability.id !== 'string' || !capability.id.trim()) {
    throw new NormalizerError('CAPABILITY_PACK_INVALID', 'Every capability needs a non-empty id.');
  }

  const keywords = stringArray(capability.keywords ?? capability.cues, 'keywords', capability.id);
  const nameCues = stringArray(capability.nameCues, 'nameCues', capability.id);
  const titleCues = stringArray(capability.titleCues, 'titleCues', capability.id);
  const descriptionCues = stringArray(capability.descriptionCues, 'descriptionCues', capability.id);
  const schemaCues = stringArray(capability.schemaCues ?? capability.inputCues, 'schemaCues', capability.id);
  const phrases = stringArray(capability.phrases, 'phrases', capability.id);
  const baseCues = [capability.id, capability.title, capability.description, ...keywords].filter((value) => typeof value === 'string');

  const cueTokens = (values) => tokens(values.join(' '));
  return Object.freeze({
    source: capability,
    id: capability.id,
    phrases: Object.freeze(phrases.map(normalizeText).filter(Boolean)),
    requiredConcepts: Object.freeze(normalizeRequiredConcepts(capability)),
    tokenSets: Object.freeze({
      all: cueTokens([...baseCues, ...nameCues, ...titleCues, ...descriptionCues, ...schemaCues]),
      name: cueTokens([...baseCues, ...nameCues]),
      title: cueTokens([...baseCues, ...titleCues]),
      description: cueTokens([...baseCues, ...descriptionCues]),
      schema: cueTokens([...baseCues, ...schemaCues]),
    }),
    minimumRisk: capability.minimumRisk ?? capability.risk ?? null,
  });
}

function compilePack(capabilityPack) {
  if (!Array.isArray(capabilityPack) || capabilityPack.length === 0) {
    throw new NormalizerError('CAPABILITY_PACK_INVALID', 'capabilityPack must be a non-empty array.');
  }
  const compiled = capabilityPack.map(compileCapability);
  const ids = new Set();
  for (const capability of compiled) {
    if (ids.has(capability.id)) {
      throw new NormalizerError('CAPABILITY_PACK_INVALID', `Duplicate capability id: ${capability.id}`, { capabilityId: capability.id });
    }
    ids.add(capability.id);
  }
  return compiled;
}

function buildInverseDocumentFrequency(capabilities) {
  const frequency = new Map();
  for (const capability of capabilities) {
    for (const token of capability.tokenSets.all) frequency.set(token, (frequency.get(token) ?? 0) + 1);
  }
  return new Map([...frequency].map(([token, count]) => [token, 1 + Math.log((capabilities.length + 1) / (count + 0.5))]));
}

function parseSchema(schema) {
  if (schema === undefined || schema === null) return { type: 'object', properties: {} };
  if (typeof schema === 'string') {
    try {
      const parsed = JSON.parse(schema);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch {}
    throw new NormalizerError('TOOL_SCHEMA_INVALID', 'RegisteredTool inputSchema is not valid JSON.');
  }
  if (typeof schema !== 'object' || Array.isArray(schema)) {
    throw new NormalizerError('TOOL_SCHEMA_INVALID', 'RegisteredTool inputSchema must be an object.');
  }
  return schema;
}

function collectSchemaEvidence(schema) {
  const fields = [];
  const seen = new WeakSet();
  const stack = [{ value: schema, path: '$', depth: 0 }];
  let nodes = 0;

  while (stack.length) {
    const { value, path, depth } = stack.pop();
    if (!value || typeof value !== 'object') continue;
    if (depth > 12 || nodes >= 512 || seen.has(value)) {
      throw new NormalizerError('TOOL_SCHEMA_UNSAFE', 'Tool schema exceeded normalization safety bounds.', { path });
    }
    seen.add(value);
    nodes += 1;

    if (Array.isArray(value)) {
      for (let index = value.length - 1; index >= 0; index -= 1) {
        if (value[index] && typeof value[index] === 'object') {
          stack.push({ value: value[index], path: `${path}[${index}]`, depth: depth + 1 });
        }
      }
      continue;
    }

    for (const [key, child] of Object.entries(value)) {
      if ((key === 'properties' || key === 'patternProperties') && child && typeof child === 'object' && !Array.isArray(child)) {
        for (const [propertyName, propertySchema] of Object.entries(child)) {
          const propertyPath = `${path}.${key}.${propertyName}`;
          const title = typeof propertySchema?.title === 'string' ? propertySchema.title : '';
          const description = typeof propertySchema?.description === 'string' ? propertySchema.description : '';
          fields.push(Object.freeze({
            path: propertyPath,
            name: propertyName,
            title,
            description,
            normalized: normalizeText(`${propertyName} ${title} ${description}`),
            tokenSet: tokens(`${propertyName} ${title} ${description}`),
          }));
          if (propertySchema && typeof propertySchema === 'object') {
            stack.push({ value: propertySchema, path: propertyPath, depth: depth + 1 });
          }
        }
      } else if (child && typeof child === 'object') {
        stack.push({ value: child, path: `${path}.${key}`, depth: depth + 1 });
      }
    }
  }

  return Object.freeze({
    fields: Object.freeze(fields),
    text: normalizeText(fields.map((field) => `${field.name} ${field.title} ${field.description}`).join(' ')),
    tokenSet: tokens(fields.map((field) => `${field.name} ${field.title} ${field.description}`).join(' ')),
  });
}

function canonicalOrigin(value) {
  try {
    const parsed = new URL(value);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== value) throw new Error('not canonical');
    return parsed.origin;
  } catch {
    throw new NormalizerError('TOOL_IDENTITY_INVALID', `RegisteredTool has an invalid origin: ${value}`, { origin: value });
  }
}

export function toolIdentity(tool) {
  if (!tool || typeof tool !== 'object' || typeof tool.name !== 'string' || !tool.name.trim()) {
    throw new NormalizerError('TOOL_IDENTITY_INVALID', 'RegisteredTool requires a non-empty name.');
  }
  const origin = canonicalOrigin(tool.origin);
  const name = tool.name.trim();
  return Object.freeze({ origin, name, key: `${origin}\u0000${name}` });
}

export function fingerprintToolSchema(toolOrSchema) {
  const candidate = toolOrSchema && typeof toolOrSchema === 'object' && Object.hasOwn(toolOrSchema, 'inputSchema')
    ? toolOrSchema.inputSchema
    : toolOrSchema;
  const schema = parseSchema(candidate);
  return sha256Hex(stableStringify(schema));
}

function suppliedAssessment(securityAssessments, tool, identity) {
  if (!securityAssessments) return null;
  if (typeof securityAssessments.get === 'function') {
    return securityAssessments.get(tool) ?? securityAssessments.get(identity.key) ?? null;
  }
  if (typeof securityAssessments === 'object') return securityAssessments[identity.key] ?? null;
  throw new TypeError('securityAssessments must be map-like or an object.');
}

function normalizeAssessment(assessment) {
  if (!assessment || typeof assessment !== 'object') {
    throw new NormalizerError('SECURITY_ASSESSMENT_INVALID', 'Security assessment must be an object.');
  }
  const metadata = assessment.metadata ?? assessment;
  if (!metadata || typeof metadata !== 'object' || typeof metadata.quarantined !== 'boolean') {
    throw new NormalizerError('SECURITY_ASSESSMENT_INVALID', 'Security assessment must contain metadata.quarantined.');
  }
  return { assessment, metadata };
}

function matchingTokens(source, cues) {
  const matches = [];
  for (const cue of cues) if (source.has(cue)) matches.push(cue);
  return matches;
}

function addTokenEvidence(evidence, source, sourceTokens, cueTokens, weight, idf) {
  for (const token of matchingTokens(sourceTokens, cueTokens)) {
    const weightedScore = weight * (idf.get(token) ?? 1);
    evidence.push(Object.freeze({
      source,
      type: 'token-match',
      cue: token,
      matched: token,
      weight: Number(weightedScore.toFixed(4)),
    }));
  }
}

function compact(value) {
  return normalizeText(value).replace(/\s+/g, '');
}

function propertyMatchesAlias(field, alias) {
  const aliasText = normalizeText(alias);
  const aliasTokens = tokens(aliasText);
  const compactAlias = compact(aliasText);
  const compactName = compact(field.name);
  if (compactAlias.length >= 3 && compactName.includes(compactAlias)) return true;
  if (aliasTokens.size === 0) return false;
  return [...aliasTokens].every((token) => field.tokenSet.has(token));
}

function scoreCapability(toolText, schemaEvidence, capability, idf) {
  const evidence = [];
  addTokenEvidence(evidence, 'tool.name', toolText.nameTokens, capability.tokenSets.name, FIELD_WEIGHTS.name, idf);
  addTokenEvidence(evidence, 'tool.title', toolText.titleTokens, capability.tokenSets.title, FIELD_WEIGHTS.title, idf);
  addTokenEvidence(evidence, 'tool.description', toolText.descriptionTokens, capability.tokenSets.description, FIELD_WEIGHTS.description, idf);
  addTokenEvidence(evidence, 'tool.inputSchema', schemaEvidence.tokenSet, capability.tokenSets.schema, FIELD_WEIGHTS.schema, idf);

  const combinedText = `${toolText.name} ${toolText.title} ${toolText.description} ${schemaEvidence.text}`;
  for (const phrase of capability.phrases) {
    if (!phrase || !combinedText.includes(phrase)) continue;
    evidence.push(Object.freeze({
      source: 'tool.metadata',
      type: 'phrase-match',
      cue: phrase,
      matched: phrase,
      weight: FIELD_WEIGHTS.phrase,
    }));
  }

  const requiredConcepts = capability.requiredConcepts.map((concept) => {
    const field = schemaEvidence.fields.find((candidate) => concept.aliases.some((alias) => propertyMatchesAlias(candidate, alias)));
    if (field) {
      evidence.push(Object.freeze({
        source: 'tool.inputSchema',
        type: 'required-concept',
        cue: concept.id,
        matched: field.name,
        path: field.path,
        weight: FIELD_WEIGHTS.requiredConcept,
      }));
    }
    return Object.freeze({ concept: concept.id, matched: Boolean(field), property: field?.name ?? null, path: field?.path ?? null });
  });

  const missingRequiredConcepts = requiredConcepts.filter((entry) => !entry.matched).map((entry) => entry.concept);
  const rawScore = evidence.reduce((total, entry) => total + entry.weight, 0);
  const confidence = Math.min(0.99, 1 - Math.exp(-rawScore / 14));
  return Object.freeze({
    capabilityId: capability.id,
    eligible: missingRequiredConcepts.length === 0,
    rawScore: Number(rawScore.toFixed(4)),
    confidence: Number(confidence.toFixed(4)),
    evidence: Object.freeze(evidence.sort((left, right) => right.weight - left.weight || left.source.localeCompare(right.source))),
    requiredConcepts: Object.freeze(requiredConcepts),
    missingRequiredConcepts: Object.freeze(missingRequiredConcepts),
  });
}

function validateThreshold(name, value, { upperInclusive = true } = {}) {
  const upperValid = upperInclusive ? value <= 1 : value < 1;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || !upperValid) {
    throw new RangeError(`${name} must be between 0 and 1.`);
  }
  return value;
}

function candidateFromDecision({ tool, identity, schemaFingerprint, security, capability, score, ambiguityMargin }) {
  return Object.freeze({
    tool,
    identity,
    origin: identity.origin,
    name: identity.name,
    capabilityId: capability.id,
    confidence: score.confidence,
    ambiguityMargin,
    rawScore: score.rawScore,
    schemaFingerprint,
    evidence: score.evidence,
    requiredConcepts: score.requiredConcepts,
    security,
    risk: classifyToolRisk(tool, { capabilityPolicy: capability.minimumRisk }),
  });
}

export function normalizeDiscoveredTools({
  tools: discoveredTools,
  capabilityPack,
  securityAssessments = null,
  assessSecurity = assessToolSecurity,
  minimumConfidence = DEFAULT_MINIMUM_CONFIDENCE,
  ambiguityMargin = DEFAULT_AMBIGUITY_MARGIN,
} = {}) {
  if (!Array.isArray(discoveredTools)) throw new TypeError('tools must be an array of RegisteredTool objects.');
  if (typeof assessSecurity !== 'function') throw new TypeError('assessSecurity must be a function.');
  const minimum = validateThreshold('minimumConfidence', minimumConfidence);
  const requiredMargin = validateThreshold('ambiguityMargin', ambiguityMargin);
  const capabilities = compilePack(capabilityPack);
  const idf = buildInverseDocumentFrequency(capabilities);
  const accepted = [];
  const rejected = [];
  const quarantined = [];
  let scoredTools = 0;

  for (const tool of discoveredTools) {
    const identity = toolIdentity(tool);
    const provided = suppliedAssessment(securityAssessments, tool, identity);
    const { assessment, metadata } = normalizeAssessment(provided ?? assessSecurity(tool));
    if (metadata.quarantined || assessment.allowedForScoring === false) {
      quarantined.push(Object.freeze({ identity, tool, scored: false, security: assessment }));
      continue;
    }

    scoredTools += 1;
    let schema;
    let schemaEvidence;
    let schemaFingerprint;
    try {
      schema = parseSchema(tool.inputSchema);
      schemaEvidence = collectSchemaEvidence(schema);
      schemaFingerprint = fingerprintToolSchema(schema);
    } catch (error) {
      rejected.push(Object.freeze({
        identity,
        tool,
        reasonCode: error?.code ?? 'TOOL_SCHEMA_INVALID',
        reason: error instanceof Error ? error.message : String(error),
        bestCandidate: null,
        secondCandidate: null,
        ambiguityMargin: null,
        security: assessment,
      }));
      continue;
    }

    const toolText = Object.freeze({
      name: normalizeText(tool.name),
      title: normalizeText(tool.title),
      description: normalizeText(tool.description),
      nameTokens: tokens(tool.name),
      titleTokens: tokens(tool.title),
      descriptionTokens: tokens(tool.description),
    });
    const scores = capabilities
      .map((capability) => ({ capability, score: scoreCapability(toolText, schemaEvidence, capability, idf) }))
      .sort((left, right) => Number(right.score.eligible) - Number(left.score.eligible)
        || right.score.confidence - left.score.confidence
        || left.capability.id.localeCompare(right.capability.id));

    const eligible = scores.filter((entry) => entry.score.eligible);
    const best = eligible[0] ?? null;
    const second = eligible[1] ?? null;
    const margin = best ? Number((best.score.confidence - (second?.score.confidence ?? 0)).toFixed(4)) : 0;

    let reasonCode = null;
    if (!best) reasonCode = 'REQUIRED_CONCEPTS_MISSING';
    else if (best.score.confidence < minimum) reasonCode = 'LOW_CONFIDENCE';
    else if (second && margin < requiredMargin) reasonCode = 'AMBIGUOUS_MAPPING';

    if (reasonCode) {
      rejected.push(Object.freeze({
        identity,
        tool,
        reasonCode,
        reason: reasonCode === 'LOW_CONFIDENCE'
          ? `Best confidence ${best.score.confidence} is below ${minimum}.`
          : reasonCode === 'AMBIGUOUS_MAPPING'
            ? `Top-two margin ${margin} is below ${requiredMargin}.`
            : 'No capability had all required input concepts.',
        bestCandidate: best ? Object.freeze({ capabilityId: best.capability.id, ...best.score }) : scores[0] ? Object.freeze({ capabilityId: scores[0].capability.id, ...scores[0].score }) : null,
        secondCandidate: second ? Object.freeze({ capabilityId: second.capability.id, ...second.score }) : null,
        ambiguityMargin: margin,
        schemaFingerprint,
        security: assessment,
      }));
      continue;
    }

    accepted.push(candidateFromDecision({
      tool,
      identity,
      schemaFingerprint,
      security: assessment,
      capability: best.capability,
      score: best.score,
      ambiguityMargin: margin,
    }));
  }

  const byCapability = new Map(capabilities.map((capability) => [capability.id, []]));
  for (const candidate of accepted) byCapability.get(candidate.capabilityId).push(candidate);

  const mappings = capabilities.map((capability) => {
    const ranked = byCapability.get(capability.id)
      .sort((left, right) => right.confidence - left.confidence || left.identity.key.localeCompare(right.identity.key));
    return Object.freeze({
      capabilityId: capability.id,
      capability: capability.source,
      primary: ranked[0] ?? null,
      alternatives: Object.freeze(ranked.slice(1)),
      ranked: Object.freeze([...ranked]),
    });
  });

  return Object.freeze({
    mappings: Object.freeze(mappings),
    accepted: Object.freeze(accepted),
    rejected: Object.freeze(rejected),
    quarantined: Object.freeze(quarantined),
    stats: Object.freeze({
      discoveredTools: discoveredTools.length,
      securityExcludedTools: quarantined.length,
      scoredTools,
      acceptedTools: accepted.length,
      rejectedTools: rejected.length,
    }),
    policy: Object.freeze({ minimumConfidence: minimum, ambiguityMargin: requiredMargin }),
  });
}

export function normalizeTools(tools, capabilityPack, options = {}) {
  return normalizeDiscoveredTools({ ...options, tools, capabilityPack });
}

export { DEFAULT_AMBIGUITY_MARGIN, DEFAULT_MINIMUM_CONFIDENCE };
