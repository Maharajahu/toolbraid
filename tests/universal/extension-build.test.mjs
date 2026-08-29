import assert from 'node:assert/strict';
import { access, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildUniversalExtension } from '../../scripts/build-universal-extension.mjs';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUTPUT = path.join(PROJECT_ROOT, 'dist', 'test-toolbraid-universal-extension');

test('builds a load-unpacked MV3 extension with runtime source dependencies', async (t) => {
  t.after(async () => rm(OUTPUT, { recursive: true, force: true }));
  const result = await buildUniversalExtension({ outputDir: OUTPUT });
  assert.equal(result.manifestVersion, 3);

  const manifest = JSON.parse(await readFile(path.join(OUTPUT, 'manifest.json'), 'utf8'));
  assert.equal(manifest.background.service_worker, 'service-worker.js');
  assert.equal(manifest.side_panel.default_path, 'sidepanel.html');
  await access(path.join(OUTPUT, 'src', 'runtime', 'universal-session.js'));
  await access(path.join(OUTPUT, 'src', 'universal', 'snapshot.js'));
  await access(path.join(OUTPUT, 'multimodal-provider.js'));

  const worker = await readFile(path.join(OUTPUT, 'service-worker.js'), 'utf8');
  assert.doesNotMatch(worker, /from ['"]\.\.\/src\//);
  assert.match(worker, /createXPostAdapter\(\)/, 'production worker must register X postcondition verification');
  const universalRuntime = await readFile(path.join(OUTPUT, 'universal-runtime.js'), 'utf8');
  const multimodalProvider = await readFile(path.join(OUTPUT, 'multimodal-provider.js'), 'utf8');
  assert.doesNotMatch(universalRuntime, /from ['"]\.\.\/src\//);
  assert.doesNotMatch(multimodalProvider, /from ['"]\.\.\/src\//);
  assert.match(universalRuntime, /from ['"]\.\/src\/runtime\/index\.js['"]/);
});
