import { CAPABILITIES } from './ontology.js';
import { includesPhrase, normalizeKey, tokenOverlap, tokenize } from './text.js';
import { inferRisk, riskLabel, scanToolMetadata } from './risk.js';

export function parseSchema(schema) {
  if (!schema) return { type: 'object', properties: {} };
  if (typeof schema === 'object') return schema;
  try {
    const parsed = JSON.parse(schema);
    return parsed && typeof parsed === 'object' ? parsed : { type: 'object', properties: {} };
  } catch {
    return { type: 'object', properties: {} };
  }
}

function scoreCapability(tool, capability) {
  const schema = parseSchema(tool.inputSchema);
  const nameTokens = tokenize(tool.name ?? '');
  const titleTokens = tokenize(tool.title ?? '');
  const descriptionTokens = tokenize(tool.description ?? '');
  const propertyNames = Object.keys(schema.properties ?? {});
  const schemaTokens = tokenize(propertyNames.join(' '));
  const keywordTokens = tokenize(capability.keywords.join(' '));
  const cueTokens = tokenize(capability.schemaCues.join(' '));

  const nameHits = tokenOverlap(nameTokens, keywordTokens);
  const titleHits = tokenOverlap(titleTokens, keywordTokens);
  const descriptionHits = tokenOverlap(descriptionTokens, keywordTokens);
  const schemaHits = tokenOverlap(schemaTokens, cueTokens);
  const phraseHits = capability.phrases.filter((phrase) => includesPhrase(tool.description ?? '', phrase)).length;

  let raw = nameHits * 3.2 + titleHits * 2.2 + descriptionHits * 1.45 + schemaHits * 2.35 + phraseHits * 3.5;
  const explanation = [];
  if (nameHits) explanation.push(`${nameHits} semantic cue${nameHits === 1 ? '' : 's'} in tool name`);
  if (descriptionHits) explanation.push(`${descriptionHits} cue${descriptionHits === 1 ? '' : 's'} in description`);
  if (schemaHits) explanation.push(`${schemaHits} compatible schema field${schemaHits === 1 ? '' : 's'}`);
  if (phraseHits) explanation.push(`${phraseHits} intent phrase match${phraseHits === 1 ? '' : 'es'}`);

  const text = normalizeKey(`${tool.name ?? ''} ${tool.description ?? ''}`);
  const looksLikeMutation = /\b(hold|reserve|freeze|lock|book|purchase|delete|send)\b/.test(text);
  if (capability.action === 'read' && looksLikeMutation) raw -= 4.5;
  if (capability.action !== 'read' && !looksLikeMutation) raw -= 1.5;
  if (capability.id.endsWith('.hold') && /\b(search|find|scan|seek|lookup)\b/.test(text)) raw -= 3;

  const confidence = Math.max(0, Math.min(0.99, 1 - Math.exp(-raw / 9)));
  return { capability, raw, confidence, explanation, schema };
}

export function normalizeTool(tool, { threshold = 0.35 } = {}) {
  const security = scanToolMetadata(tool);
  const ranked = CAPABILITIES.map((capability) => scoreCapability(tool, capability)).sort((a, b) => b.raw - a.raw);
  const best = ranked[0];
  const second = ranked[1];
  const separation = Math.max(0, best.confidence - (second?.confidence ?? 0));
  const adjustedConfidence = Math.max(0, Math.min(0.99, best.confidence * (0.84 + Math.min(0.16, separation))));
  const mapped = adjustedConfidence >= threshold && best.raw > 0;
  const risk = inferRisk(tool, mapped ? best.capability : null);

  return {
    tool,
    schema: best.schema,
    capability: mapped ? best.capability : null,
    confidence: mapped ? adjustedConfidence : 0,
    candidates: ranked.slice(0, 3).map((entry) => ({ capability: entry.capability.id, confidence: entry.confidence })),
    explanation: mapped
      ? [...best.explanation, `risk classified as ${riskLabel(risk).toLowerCase()}`]
      : ['No capability crossed the confidence threshold.'],
    risk,
    security,
    quarantined: security.quarantine,
  };
}

export function normalizeTools(tools, options = {}) {
  return tools.map((tool) => normalizeTool(tool, options));
}

export function selectBestTools(mappings) {
  const selected = new Map();
  for (const mapping of mappings) {
    if (!mapping.capability || mapping.quarantined) continue;
    const id = mapping.capability.id;
    const current = selected.get(id);
    if (!current || mapping.confidence > current.confidence) selected.set(id, mapping);
  }
  return selected;
}
