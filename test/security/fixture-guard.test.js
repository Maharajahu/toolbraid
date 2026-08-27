import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';

import { createServer } from '../../src/server.js';
import {
  createCompositionRoot,
  createFixtureRuntime,
} from '../../src/runtime/composition-root.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function withNodeEnv(value, callback) {
  const previous = process.env.NODE_ENV;
  if (value === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = value;
  try {
    return callback();
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  }
}

function forbiddenFixture(error) {
  return error?.code === 'INSECURE_FIXTURE_FORBIDDEN';
}

test('production composition refuses fixture mode before legacy map construction', () => {
  let descriptorCalls = 0;
  const options = {
    fixture: true,
    adapter: {
      listCapabilities() {
        descriptorCalls += 1;
        return [];
      },
    },
  };

  withNodeEnv('production', () => {
    assert.throws(() => createCompositionRoot(options), forbiddenFixture);
    assert.throws(() => createFixtureRuntime(options), forbiddenFixture);
    assert.throws(() => createServer(options), forbiddenFixture);
  });

  assert.equal(descriptorCalls, 0, 'fixture dependencies were constructed before the guard');
});

test('production CLI refuses TOOLBRAID_FIXTURE before starting stdio', () => {
  const result = spawnSync(process.execPath, ['src/server.js'], {
    cwd: ROOT,
    input: '',
    encoding: 'utf8',
    env: {
      ...process.env,
      NODE_ENV: 'production',
      TOOLBRAID_FIXTURE: '1',
      TOOLBRAID_TRANSPORT: 'stdio',
    },
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /INSECURE_FIXTURE_FORBIDDEN/u);
  assert.doesNotMatch(result.stderr, /toolbraid listening/u);
});

