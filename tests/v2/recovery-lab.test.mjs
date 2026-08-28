import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

test('recovery lab runbook binds both real deployments to exact GitHub commit metadata', async () => {
  const readme = await readFile(path.join(projectRoot, 'sandbox', 'recovery-lab', 'README.md'), 'utf8');
  assert.match(readme, /\$stableSha = git rev-parse HEAD/);
  assert.match(readme, /\$degradedSha = git rev-parse HEAD/);
  assert.match(readme, /--meta "githubCommitSha=\$stableSha"/);
  assert.match(readme, /--meta "githubCommitSha=\$degradedSha"/);
  assert.match(readme, /TOOLBRAID_GITHUB_REF/);
});
