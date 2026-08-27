import test from 'node:test';
import assert from 'node:assert/strict';

import { CapabilityCatalog } from '../../src/core/index.js';

const IDENTITY = { tenantId: 'tenant-a', subjectId: 'subject-a' };

test('catalog search snapshots cannot mutate stored adapter, origin, or tag bindings', () => {
  const catalog = new CapabilityCatalog({ capabilities: [{
    id: 'orders.lookup',
    version: '1',
    readOnly: true,
    adapters: [{ id: 'structured.orders', kind: 'structured-api' }],
    origins: ['https://shop.example.test'],
    tags: ['orders'],
  }] });

  const first = catalog.search({ identity: IDENTITY, query: 'orders.lookup' });
  first.capabilities[0].adapters[0].id = 'attacker';
  first.capabilities[0].origins[0] = 'https://evil.example.test';
  first.capabilities[0].tags[0] = 'poisoned';

  const second = catalog.search({ identity: IDENTITY, query: 'orders.lookup' });
  assert.deepEqual(second.capabilities[0].adapters, [{ id: 'structured.orders', kind: 'structured-api' }]);
  assert.deepEqual(second.capabilities[0].origins, ['https://shop.example.test']);
  assert.deepEqual(second.capabilities[0].tags, ['orders']);
});
