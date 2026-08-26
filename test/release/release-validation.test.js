import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import {
  PUBLIC_TOOL_NAMES as MCP_PUBLIC_TOOL_NAMES,
} from '../../src/mcp/tools.js';
import {
  createCompositionRoot,
  PUBLIC_TOOL_NAMES as RUNTIME_PUBLIC_TOOL_NAMES,
} from '../../src/runtime/composition-root.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const SOURCE = path.join(ROOT, 'src');

const PUBLIC_TOOLS = [
  'capabilities.search',
  'capabilities.describe',
  'plan.propose',
  'workflow.execute',
  'workflow.status',
  'workflow.replay_readonly',
];

async function readText(relativePath) {
  return readFile(path.join(ROOT, relativePath), 'utf8');
}

async function javascriptFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await javascriptFiles(absolute));
    else if (/\.(?:[cm]?js)$/u.test(entry.name)) files.push(absolute);
  }
  return files.sort();
}

test('release metadata declares the supported runtime and required gates', async () => {
  const packageJson = JSON.parse(await readText('package.json'));
  assert.equal(packageJson.private, true, 'the package is not published accidentally');
  assert.match(packageJson.engines?.node ?? '', />=\s*20(?:\D|$)/u);
  assert.equal(packageJson.scripts?.test, 'node --test');
  assert.equal(packageJson.scripts?.check, 'node --check src/server.js && node --test');
  assert.equal(packageJson.dependencies, undefined, 'runtime must remain dependency-free');
});

test('every source module passes Node syntax checking', async () => {
  const files = await javascriptFiles(SOURCE);
  assert.ok(files.length > 0, 'source tree is empty');
  for (const file of files) {
    const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    assert.equal(result.status, 0, `${path.relative(ROOT, file)} failed --check:\n${result.stderr}`);
  }
});

test('the six public tools are represented in source', async () => {
  const files = await javascriptFiles(SOURCE);
  const source = (await Promise.all(files.map((file) => readFile(file, 'utf8')))).join('\n');
  for (const tool of PUBLIC_TOOLS) assert.ok(source.includes(tool), `missing public tool ${tool}`);
});

test('public dispatch exposes exactly the six tools and no approval grant', async () => {
  assert.deepEqual([...MCP_PUBLIC_TOOL_NAMES], PUBLIC_TOOLS);
  assert.deepEqual([...RUNTIME_PUBLIC_TOOL_NAMES], PUBLIC_TOOLS);
  const runtime = createCompositionRoot({ identity: { tenantId: 'release-tenant', subject: 'release-subject' } });
  for (const forbidden of ['approval.grant', 'shell.exec', 'filesystem.read']) {
    await assert.rejects(runtime.callTool(forbidden, {}), (error) => error?.code === 'TOOL_NOT_FOUND');
  }
});

test('runtime source does not introduce direct code or shell execution', async () => {
  const files = await javascriptFiles(SOURCE);
  const source = (await Promise.all(files.map((file) => readFile(file, 'utf8')))).join('\n');
  assert.doesNotMatch(source, /from\s+['"]node:(?:child_process|vm)['"]/u);
  // Ignore harmless property calls such as RegExp.prototype.exec; only a
  // bare global-style invocation is prohibited by this release assertion.
  assert.doesNotMatch(source, /(?<![\w.$])(?:eval|Function)\s*\(/u);
  assert.doesNotMatch(source, /(?<![\w.$])(?:exec|execFile|execSync|spawn|spawnSync|fork)\s*\(/u);
});

test('container baseline is non-root and does not install runtime packages', async () => {
  const dockerfile = await readText('Dockerfile');
  assert.match(dockerfile, /^FROM\s+node:[^\s]+-alpine\s*$/mu);
  assert.doesNotMatch(dockerfile, /:latest\b/u);
  assert.match(dockerfile, /^COPY\s+--chown=node:node\s+package\.json/mu);
  assert.match(dockerfile, /^USER\s+node\s*$/mu);
  assert.match(dockerfile, /^CMD\s+\["node",\s*"src\/server\.js"\]/mu);
  assert.doesNotMatch(dockerfile, /npm\s+(?:install|ci)\b/u);
});

test('CI runs the repository gates with read-only permissions', async () => {
  const workflow = await readText('.github/workflows/ci.yml');
  assert.match(workflow, /permissions:\s*\n\s+contents:\s+read/u);
  assert.match(workflow, /run:\s+npm test\b/u);
  assert.match(workflow, /run:\s+npm run check\b/u);
  assert.match(workflow, /node --test test\/release/u);
  assert.match(workflow, /actions\/checkout@v4/u);
  assert.match(workflow, /actions\/setup-node@v4/u);
});

test('release and security guidance is present', async () => {
  for (const file of [
    'SECURITY.md',
    'docs/ARCHITECTURE.md',
    'docs/OPERATIONS.md',
    'docs/RELEASE.md',
    'docs/THREAT-CONTROL-MATRIX.md',
    'CHANGELOG.md',
  ]) {
    const content = await readText(file);
    assert.ok(content.trim().length > 200, `${file} is unexpectedly sparse`);
  }
  const security = await readText('SECURITY.md');
  assert.match(security, /fail closed/u);
  assert.match(security, /single-use nonce/u);
  const matrix = await readText('docs/THREAT-CONTROL-MATRIX.md');
  assert.match(matrix, /Malicious provider\/page output/u);
  assert.match(matrix, /Mutation through replay/u);
});

test('tracked project files contain no private-key material', async () => {
  const files = await javascriptFiles(SOURCE);
  const text = (await Promise.all(files.map((file) => readFile(file, 'utf8')))).join('\n');
  assert.doesNotMatch(text, /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u);
});
