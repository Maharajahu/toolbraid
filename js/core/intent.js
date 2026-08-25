function tomorrowIso() {
  const date = new Date();
  date.setDate(date.getDate() + 1);
  return date.toISOString().slice(0, 10);
}

function cleanPlace(value) {
  return String(value ?? '').replace(/[,.]+$/, '').trim();
}

export function extractMission(goal, overrides = {}) {
  const text = String(goal ?? '').trim();
  const routeMatch = text.match(/\bfrom\s+([A-Za-z][A-Za-z .'-]{1,40}?)\s+to\s+([A-Za-z][A-Za-z .'-]{1,40}?)(?=\s+(?:tomorrow|today|on|under|below|for|with)|[,.;]|$)/i)
    ?? text.match(/\b([A-Za-z][A-Za-z .'-]{1,40}?)\s*(?:→|->)\s*([A-Za-z][A-Za-z .'-]{1,40}?)(?=\s+(?:tomorrow|today|on|under|below|for|with)|[,.;]|$)/i);
  const budgetMatch = text.match(/(?:under|below|max(?:imum)?|budget(?: of)?)[^\d£$€]*(?:£|GBP\s*)?(\d+(?:\.\d{1,2})?)/i)
    ?? text.match(/(?:£|GBP\s*)(\d+(?:\.\d{1,2})?)/i);
  const dateMatch = text.match(/\b(20\d{2}-\d{2}-\d{2})\b/);

  let date = overrides.date || dateMatch?.[1] || tomorrowIso();
  if (/\btoday\b/i.test(text) && !overrides.date) date = new Date().toISOString().slice(0, 10);
  if (/\btomorrow\b/i.test(text) && !overrides.date) date = tomorrowIso();

  return {
    kind: 'trip',
    goal: text || 'Plan a transport and accommodation mission.',
    origin: cleanPlace(overrides.origin || routeMatch?.[1] || 'Coventry'),
    destination: cleanPlace(overrides.destination || routeMatch?.[2] || 'London'),
    destinationAddress: cleanPlace(overrides.destinationAddress || '1 Principal Place, London EC2A 2FA'),
    date,
    passengers: Math.max(1, Number(overrides.passengers || 1)),
    nights: Math.max(1, Number(overrides.nights || 1)),
    budget: Math.max(1, Number(overrides.budget || budgetMatch?.[1] || 250)),
    currency: String(overrides.currency || 'GBP').toUpperCase(),
  };
}
