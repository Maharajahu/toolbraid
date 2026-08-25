import { INPUT_ALIASES, OUTPUT_ALIASES } from './ontology.js';
import { getByAliases, normalizeKey } from './text.js';

function propertiesFor(schema) {
  return Object.keys(schema?.properties ?? {});
}

function propertyForConcept(schema, concept) {
  const properties = propertiesFor(schema);
  const normalized = new Map(properties.map((property) => [normalizeKey(property).replace(/\s/g, ''), property]));
  for (const alias of INPUT_ALIASES[concept] ?? []) {
    const hit = normalized.get(normalizeKey(alias).replace(/\s/g, ''));
    if (hit) return hit;
  }
  return null;
}

function assignConcept(target, schema, concept, value) {
  const property = propertyForConcept(schema, concept);
  if (property && value !== undefined) target[property] = value;
}

export function buildToolInput(capabilityId, schema, context) {
  const input = {};
  if (capabilityId === 'travel.search') {
    assignConcept(input, schema, 'origin', context.mission.origin);
    assignConcept(input, schema, 'destination', context.mission.destination);
    assignConcept(input, schema, 'date', context.mission.date);
    assignConcept(input, schema, 'passengers', context.mission.passengers);
  } else if (capabilityId === 'accommodation.search') {
    assignConcept(input, schema, 'location', context.mission.destination);
    assignConcept(input, schema, 'date', context.mission.date);
    assignConcept(input, schema, 'nights', context.mission.nights);
    assignConcept(input, schema, 'guests', context.mission.passengers);
    assignConcept(input, schema, 'maxPrice', context.mission.budget);
  } else if (capabilityId === 'location.distance') {
    const candidateNode = context.results.get('candidate-weave');
    const uniqueStays = [...new Map(candidateNode.candidates.map((item) => [item.stay.id, item.stay])).values()];
    assignConcept(input, schema, 'candidates', uniqueStays.map((stay) => ({ id: stay.id, address: stay.address, label: stay.label })));
    assignConcept(input, schema, 'destination', context.mission.destinationAddress);
    assignConcept(input, schema, 'mode', 'walking');
  } else if (capabilityId === 'travel.hold') {
    const recommendation = context.results.get('recommendation');
    assignConcept(input, schema, 'travelOptionId', recommendation.travel.id);
  } else if (capabilityId === 'accommodation.hold') {
    const recommendation = context.results.get('recommendation');
    assignConcept(input, schema, 'accommodationOptionId', recommendation.stay.id);
    assignConcept(input, schema, 'date', context.mission.date);
    assignConcept(input, schema, 'nights', context.mission.nights);
  }
  return input;
}

function findArray(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];
  for (const alias of OUTPUT_ALIASES.arrays) {
    const value = getByAliases(payload, [alias]);
    if (Array.isArray(value)) return value;
  }
  return [];
}

function numberValue(value, fallback = 0) {
  const number = Number(String(value ?? '').replace(/[^0-9.-]+/g, ''));
  return Number.isFinite(number) ? number : fallback;
}

export function canonicalizeToolOutput(capabilityId, payload) {
  if (capabilityId === 'travel.search') {
    return findArray(payload).map((item, index) => ({
      id: String(getByAliases(item, OUTPUT_ALIASES.id, `travel-${index + 1}`)),
      provider: String(getByAliases(item, OUTPUT_ALIASES.provider, 'Unknown operator')),
      origin: String(getByAliases(item, OUTPUT_ALIASES.origin, '')),
      destination: String(getByAliases(item, OUTPUT_ALIASES.destination, '')),
      departAt: String(getByAliases(item, OUTPUT_ALIASES.departAt, '')),
      arriveAt: String(getByAliases(item, OUTPUT_ALIASES.arriveAt, '')),
      price: numberValue(getByAliases(item, OUTPUT_ALIASES.price)),
      raw: item,
    }));
  }
  if (capabilityId === 'accommodation.search') {
    return findArray(payload).map((item, index) => ({
      id: String(getByAliases(item, OUTPUT_ALIASES.id, `stay-${index + 1}`)),
      label: String(getByAliases(item, OUTPUT_ALIASES.label, `Stay ${index + 1}`)),
      provider: String(getByAliases(item, OUTPUT_ALIASES.provider, 'Unknown stay provider')),
      address: String(getByAliases(item, OUTPUT_ALIASES.address, '')),
      price: numberValue(getByAliases(item, OUTPUT_ALIASES.price)),
      raw: item,
    }));
  }
  if (capabilityId === 'location.distance') {
    return findArray(payload).map((item, index) => ({
      id: String(getByAliases(item, OUTPUT_ALIASES.id, `candidate-${index + 1}`)),
      walkingMinutes: numberValue(getByAliases(item, OUTPUT_ALIASES.walkingMinutes), 999),
      distanceKm: numberValue(getByAliases(item, OUTPUT_ALIASES.distanceKm), 999),
      raw: item,
    }));
  }
  if (capabilityId.endsWith('.hold')) {
    return {
      holdId: String(getByAliases(payload, OUTPUT_ALIASES.holdId, 'hold-created')),
      expiresAt: String(getByAliases(payload, OUTPUT_ALIASES.expiresAt, '')),
      status: String(getByAliases(payload, ['status'], 'held')),
      raw: payload,
    };
  }
  return payload;
}
