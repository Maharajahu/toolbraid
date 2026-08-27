import assert from 'node:assert/strict';
import test from 'node:test';

import {
  GENESIS_HASH,
  createAuditTrail,
  verifyAuditChain,
} from '../../src/engine/audit.js';

test('creates and verifies a deterministic append-only SHA-256 audit chain', () => {
  let tick = 0;
  const trail = createAuditTrail({
    now: () => new Date(Date.parse('2026-08-27T12:00:00.000Z') + tick++ * 1000),
  });
  const first = trail.append('tool.discovered', { origin: 'https://one.example', name: 'probe' });
  const second = trail.append('tool.executed', { result: { status: 'degraded' } });

  assert.equal(first.previousHash, GENESIS_HASH);
  assert.equal(second.previousHash, first.hash);
  assert.match(second.hash, /^[a-f0-9]{64}$/);
  assert.equal(verifyAuditChain(trail.entries()), true);
  assert.deepEqual(trail.seal(), {
    algorithm: 'sha256-chain-v1',
    entries: 2,
    head: second.hash,
  });
  assert.throws(() => trail.append('late.event'), /sealed/i);
});

test('detects changed event details and broken links', () => {
  const trail = createAuditTrail({ now: () => new Date('2026-08-27T12:00:00.000Z') });
  trail.append('approval.created', { fingerprint: 'a'.repeat(64) });
  trail.append('approval.claimed', { nonce: 'n-1' });
  const tampered = trail.entries();
  tampered[0].details.fingerprint = 'b'.repeat(64);

  assert.equal(verifyAuditChain(tampered), false);
  assert.equal(verifyAuditChain(trail.entries()), true);
});
