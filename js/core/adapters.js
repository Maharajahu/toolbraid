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

function typeMatches(value, type) {
  if (type === 'array') return Array.isArray(value);
  if (type === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value);
  if (type === 'integer') return Number.isInteger(value);
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (type === 'string') return typeof value === 'string';
  if (type === 'boolean') return typeof value === 'boolean';
  if (type === 'null') return value === null;
  return true;
}

function validationError(message, details = {}) {
  const error = new Error(message);
  error.code = 'SCHEMA_VALIDATION_FAILED';
  error.details = details;
  return error;
}

export function validateToolInput(schema = {}, input = {}) {
  if (!typeMatches(input, schema.type ?? 'object')) {
    throw validationError(`Tool input must be ${schema.type ?? 'object'}.`, { expected: schema.type ?? 'object' });
  }
  for (const required of schema.required ?? []) {
    if (!(required in input) || input[required] === undefined || input[required] === null || input[required] === '') {
      throw validationError(`Missing required tool input field: ${required}`, { field: required });
    }
  }
  for (const [name, value] of Object.entries(input)) {
    const definition = schema.properties?.[name];
    if (!definition) continue;
    if (definition.type && !typeMatches(value, definition.type)) {
      throw validationError(`Invalid type for ${name}: expected ${definition.type}.`, { field: name, expected: definition.type });
    }
    if (definition.enum && !definition.enum.includes(value)) {
      throw validationError(`Invalid value for ${name}.`, { field: name, allowed: definition.enum });
    }
    if (typeof value === 'number') {
      if (definition.minimum !== undefined && value < definition.minimum) {
        throw validationError(`${name} must be at least ${definition.minimum}.`, { field: name, minimum: definition.minimum });
      }
      if (definition.maximum !== undefined && value > definition.maximum) {
        throw validationError(`${name} must not exceed ${definition.maximum}.`, { field: name, maximum: definition.maximum });
      }
    }
    if (Array.isArray(value) && definition.items?.type) {
      value.forEach((item, index) => {
        if (!typeMatches(item, definition.items.type)) {
          throw validationError(`Invalid item type for ${name}[${index}].`, { field: name, index, expected: definition.items.type });
        }
      });
    }
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
      holdId: String(getByAliases(payload, OUTPUT_ALIASES.holdId, '')),
      expiresAt: String(getByAliases(payload, OUTPUT_ALIASES.expiresAt, '')),
      status: String(getByAliases(payload, ['status'], 'held')),
      raw: payload,
    };
  }
  return payload;
}

export function validateCanonicalOutput(capabilityId, output) {
  const fail = (message, details = {}) => {
    const error = validationError(message, { capabilityId, ...details });
    error.code = 'OUTPUT_VALIDATION_FAILED';
    throw error;
  };

  if (['travel.search', 'accommodation.search', 'location.distance'].includes(capabilityId)) {
    if (!Array.isArray(output)) fail(`Canonical output for ${capabilityId} must be an array.`);
    output.forEach((item, index) => {
      if (!item || typeof item !== 'object' || !item.id) fail(`Canonical ${capabilityId} item ${index} is missing an id.`, { index });
      if (capabilityId !== 'location.distance' && (!Number.isFinite(item.price) || item.price < 0)) {
        fail(`Canonical ${capabilityId} item ${index} has an invalid price.`, { index });
      }
      if (capabilityId === 'location.distance' && (!Number.isFinite(item.walkingMinutes) || !Number.isFinite(item.distanceKm))) {
        fail(`Canonical location item ${index} has invalid distance data.`, { index });
      }
    });
  } else if (capabilityId.endsWith('.hold')) {
    if (!output || typeof output !== 'object' || !output.holdId || output.status !== 'held') {
      fail(`Canonical output for ${capabilityId} must contain a held holdId.`);
    }
  }
  return output;
}
