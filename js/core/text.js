const TOKEN_SYNONYMS = Object.freeze({
  passage: ['journey', 'route', 'travel'],
  shelter: ['hotel', 'accommodation', 'stay'],
  space: ['room', 'accommodation'],
  nest: ['room', 'stay'],
  freeze: ['hold', 'reserve', 'lock'],
  lock: ['hold', 'reserve'],
  scan: ['search', 'find'],
  seek: ['search', 'find'],
  measure: ['distance', 'calculate'],
  walkability: ['walking', 'distance', 'access'],
  quote: ['fare', 'price', 'option'],
});

export function normalizeKey(value) {
  return String(value ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function stem(token) {
  let value = token.toLowerCase();
  if (value.length > 5 && value.endsWith('ies')) value = `${value.slice(0, -3)}y`;
  else if (value.length > 5 && value.endsWith('ing')) value = value.slice(0, -3);
  else if (value.length > 4 && value.endsWith('ed')) value = value.slice(0, -2);
  else if (value.length > 4 && value.endsWith('es')) value = value.slice(0, -2);
  else if (value.length > 3 && value.endsWith('s')) value = value.slice(0, -1);
  return value;
}

export function tokenize(value, { expand = true } = {}) {
  const base = normalizeKey(value).split(/\s+/).filter(Boolean).map(stem);
  const tokens = new Set(base);
  if (expand) {
    for (const token of base) {
      for (const synonym of TOKEN_SYNONYMS[token] ?? []) tokens.add(stem(synonym));
    }
  }
  return tokens;
}

export function tokenOverlap(source, target) {
  const a = source instanceof Set ? source : tokenize(source);
  const b = target instanceof Set ? target : tokenize(target);
  let matches = 0;
  for (const token of a) if (b.has(token)) matches += 1;
  return matches;
}

export function includesPhrase(text, phrase) {
  return normalizeKey(text).includes(normalizeKey(phrase));
}

export function getByAliases(object, aliases, fallback = undefined) {
  if (!object || typeof object !== 'object') return fallback;
  const entries = Object.entries(object);
  const normalized = new Map(entries.map(([key, value]) => [normalizeKey(key).replace(/\s/g, ''), value]));
  for (const alias of aliases) {
    const hit = normalized.get(normalizeKey(alias).replace(/\s/g, ''));
    if (hit !== undefined) return hit;
  }
  return fallback;
}
