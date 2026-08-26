import test from 'node:test';
import assert from 'node:assert/strict';
import { consumeApprovalRecord, createApprovalRecord, sha256Hex, verifyApprovalRecord } from '../js/core/approval.js';

function fixture() {
  const mapping = (name, capabilityId) => ({ tool: { name }, capability: { id: capabilityId }, schema: {}, risk: 1 });
  const plan = {
    id: 'plan-test',
    createdAt: '2026-08-26T10:00:00.000Z',
    mission: { goal: 'travel', origin: 'Coventry', destination: 'London', destinationAddress: '1 Principal Place', date: '2026-08-27', budget: 250, currency: 'GBP', passengers: 1, nights: 1 },
    nodes: [
      { id: 'travel-hold', type: 'tool', capabilityId: 'travel.hold', mapping: mapping('vectorrail.freeze_quote', 'travel.hold'), alternatives: [], dependencies: ['recommendation'], risk: 1, approvalRequired: true },
      { id: 'stay-hold', type: 'tool', capabilityId: 'accommodation.hold', mapping: mapping('nestsquare.hold_space', 'accommodation.hold'), alternatives: [], dependencies: ['recommendation'], risk: 1, approvalRequired: true },
    ],
  };
  const recommendation = {
    currency: 'GBP',
    travel: { id: 'VR-0745', provider: 'West Midlands Railway', price: 39.9 },
    stay: { id: 'NS-POINT-A', provider: 'Point A', label: 'Point A Liverpool Street', price: 145 },
  };
  return { plan, recommendation };
}

test('creates and verifies a plan-, provider-, option-, and price-bound approval', async () => {
  const { plan, recommendation } = fixture();
  const record = await createApprovalRecord({ plan, recommendation, actionIds: ['travel-hold', 'stay-hold'], now: new Date('2026-08-26T10:01:00.000Z') });
  assert.equal(await verifyApprovalRecord(record, { plan, recommendation, expectedActionIds: ['stay-hold', 'travel-hold'] }), true);
  assert.match(record.planFingerprint, /^[a-f0-9]{64}$/);
  assert.equal(record.actionFingerprints.length, 2);
});

test('blocks execution when an approved option price changes', async () => {
  const { plan, recommendation } = fixture();
  const record = await createApprovalRecord({ plan, recommendation, actionIds: ['travel-hold'] });
  const changed = structuredClone(recommendation);
  changed.travel.price = 49.9;
  await assert.rejects(
    verifyApprovalRecord(record, { plan, recommendation: changed, expectedActionIds: ['travel-hold'] }),
    (error) => error.code === 'APPROVAL_ACTION_MISMATCH',
  );
});

test('single-use approval rejects replay after consumption', async () => {
  const { plan, recommendation } = fixture();
  const record = await createApprovalRecord({ plan, recommendation, actionIds: ['stay-hold'] });
  const context = { plan, recommendation, expectedActionIds: ['stay-hold'] };
  const consumed = await consumeApprovalRecord(record, context, new Date('2026-08-26T10:02:00.000Z'));
  await assert.rejects(verifyApprovalRecord(consumed, context), (error) => error.code === 'APPROVAL_REPLAY_BLOCKED');
});

test('SHA-256 approval fingerprints match a known vector', async () => {
  assert.equal(await sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});
