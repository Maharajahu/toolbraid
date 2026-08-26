import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalizeToolOutput, validateCanonicalOutput, validateToolInput } from '../js/core/adapters.js';

test('validates required provider input fields before tool execution', () => {
  assert.throws(
    () => validateToolInput({ type: 'object', required: ['from'], properties: { from: { type: 'string' } } }, {}),
    (error) => error.code === 'SCHEMA_VALIDATION_FAILED' && error.details.field === 'from',
  );
});

test('rejects malformed canonical hold output', () => {
  assert.throws(
    () => validateCanonicalOutput('travel.hold', { holdId: '', status: 'unknown' }),
    (error) => error.code === 'OUTPUT_VALIDATION_FAILED',
  );
});

test('canonicalizes and validates unfamiliar travel provider output', () => {
  const canonical = canonicalizeToolOutput('travel.search', {
    services: [{ reference: 'ALT-1', company: 'Alternative Rail', cost: '£42.50', departuretime: '09:00', arrivaltime: '10:10' }],
  });
  assert.equal(canonical[0].id, 'ALT-1');
  assert.equal(canonical[0].provider, 'Alternative Rail');
  assert.equal(canonical[0].price, 42.5);
  assert.equal(validateCanonicalOutput('travel.search', canonical), canonical);
});
