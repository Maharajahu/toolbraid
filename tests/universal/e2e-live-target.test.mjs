import assert from 'node:assert/strict';
import test from 'node:test';

import { E2EFailure, liveTarget } from '../../scripts/e2e-universal-extension.mjs';

test('live target accepts an exact X post route and keeps its origin', () => {
  assert.deepEqual(liveTarget('https://x.com/thsottiaux/status/2093515916076343774', 'x'), {
    kind: 'x',
    url: 'https://x.com/thsottiaux/status/2093515916076343774',
    origin: 'https://x.com',
  });
  assert.equal(liveTarget('https://twitter.com/user/status/123/?s=20', 'x').origin, 'https://twitter.com');
});

test('live target rejects X routes that are not one post path', () => {
  for (const url of [
    'https://x.com/thsottiaux',
    'https://x.com/thsottiaux/status/not-a-number',
    'https://x.com/thsottiaux/status/123/replies',
    'https://www.x.com/thsottiaux/status/123',
    'http://x.com/thsottiaux/status/123',
  ]) {
    assert.throws(() => liveTarget(url, 'x'), (error) => error instanceof E2EFailure && error.code === 'E2E_LIVE_URL_INVALID');
  }
});
