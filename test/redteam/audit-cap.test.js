import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AuditLog,
  DEFAULT_MAX_AUDIT_ENTRIES,
} from '../../src/security/index.js';

test('in-memory audit retention is finite by default and fails closed at capacity', () => {
  const defaultLog = new AuditLog({ clock: () => 1 });
  assert.equal(defaultLog.maxEntries, DEFAULT_MAX_AUDIT_ENTRIES);
  assert.equal(Number.isSafeInteger(defaultLog.maxEntries), true);

  const bounded = new AuditLog({ clock: () => 1, maxEntries: 2 });
  bounded.append('test.first');
  bounded.append('test.second');
  assert.throws(
    () => bounded.append('test.third'),
    (error) => error?.code === 'AUDIT_LOG_FULL',
  );
  assert.equal(bounded.length, 2);
  assert.equal(bounded.verifyIntegrity(), true);
});
