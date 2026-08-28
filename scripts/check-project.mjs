import { readdir, readFile, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const required = [
  'index.html', 'manifest.webmanifest', 'package.json', 'vercel.json', 'README.md', 'LICENSE',
  'src/app/main.js', 'src/app/mission-controller.js', 'src/app/mission-state.js',
  'src/app/constellation.js', 'src/app/icons.js', 'src/app/mission-control.css',
  'src/engine/approval.js', 'src/engine/audit.js', 'src/engine/executor.js',
  'src/engine/graph.js', 'src/engine/normalizer.js', 'src/engine/risk.js', 'src/engine/webmcp.js',
  'src/packs/recovery/adapters.js', 'src/packs/recovery/ontology.js', 'src/packs/recovery/plan.js',
  'src/providers/recovery/catalog.js',
  'providers/recovery/runtime.js', 'providers/recovery/provider.css',
  'providers/recovery/signals.html', 'providers/recovery/signals.js',
  'providers/recovery/pulse.html', 'providers/recovery/pulse.js',
  'providers/recovery/source.html', 'providers/recovery/source.js',
  'providers/recovery/deploy.html', 'providers/recovery/deploy.js',
  'providers/recovery/status.html', 'providers/recovery/status.js',
  'providers/recovery/mirage.html', 'providers/recovery/mirage.js',
  'scripts/serve.mjs', 'scripts/serve-multi-origin.mjs', 'scripts/build-standalone.mjs',
  'scripts/build-vercel-multi-origin.mjs',
  'scripts/smoke.mjs', 'scripts/e2e.py', 'scripts/record-demo-video.py',
  'video-production/README.md', 'video-production/requirements.txt',
  'video-production/capture-timeline.json', 'video-production/render-config.json',
  'video-production/script-and-storyboard.md',
  'video-production/generate-ambient-bed.py', 'video-production/generate-narration.py',
  'video-production/master-narration.py', 'video-production/render-final-video.py',
  'video-production/validate-final-video.py',
  'docs/architecture.md', 'docs/threat-model.md', 'docs/testing.md',
  'docs/challenge-requirements.md', 'docs/competition/product-definition.md',
  'docs/competition/native-webmcp-contract.md', 'docs/e2e-validation.json',
  'docs/diagrams/toolbraid-how-it-works.svg',
  'docs/diagrams/toolbraid-cross-origin-architecture.svg',
  'docs/diagrams/toolbraid-human-authority.svg',
  'docs/screenshots/toolbraid-recovery-completed.png',
  'tests/v2/mission-controller.test.mjs', 'tests/v2/multi-origin-server.test.mjs',
  'tests/v2/vercel-multi-origin-deployment.test.mjs',
  '.github/workflows/ci.yml', '.nojekyll',
];

const forbiddenLegacy = [
  'styles.css', 'js', 'release', 'deploy',
  'providers/rail.html', 'providers/rail.js', 'providers/stay.html', 'providers/stay.js',
  'providers/geo.html', 'providers/geo.js', 'providers/rogue.html', 'providers/rogue.js',
  'tests/adapters.test.mjs', 'tests/approval.test.mjs', 'tests/executor.test.mjs',
  'tests/intent.test.mjs', 'tests/normalizer.test.mjs', 'tests/planner.test.mjs',
  'scripts/build-deploy-bootstrap.mjs', 'scripts/e2e-standalone.py', 'scripts/package.mjs',
  'docs/demo-script.md', 'docs/publication-runbook.md', 'docs/video-script.md',
  'docs/final-submission-checklist.md', 'docs/final-validation-report.md',
];

const failures = [];
for (const relative of required) {
  try {
    const info = await stat(path.join(root, relative));
    if (!info.isFile() || info.size === 0) failures.push(`${relative}: missing or empty`);
  } catch {
    failures.push(`${relative}: missing`);
  }
}
for (const relative of forbiddenLegacy) {
  try {
    await stat(path.join(root, relative));
    failures.push(`${relative}: rejected legacy demo artifact still present`);
  } catch {}
}

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory() && [
      '.git', 'node_modules', '.private', '.tmp', '.playwright', 'coverage', 'dist', '__pycache__',
    ].includes(entry.name)) continue;
    if (entry.isDirectory()
      && path.dirname(full) === path.join(root, 'video-production')
      && ['models', 'work', 'output'].includes(entry.name)) continue;
    if (entry.isDirectory()) files.push(...await walk(full));
    else files.push(full);
  }
  return files;
}

const files = await walk(root);
const codeFiles = files.filter((file) => /\.(?:js|mjs)$/.test(file));
const pythonFiles = files.filter((file) => file.endsWith('.py'));

for (const relative of [
  'package.json', 'manifest.webmanifest', 'vercel.json',
  'docs/e2e-validation.json', 'video-production/capture-timeline.json',
  'video-production/render-config.json',
]) {
  try {
    JSON.parse(await readFile(path.join(root, relative), 'utf8'));
  } catch (error) {
    failures.push(`${relative}: invalid JSON (${error.message})`);
  }
}

for (const file of files.filter((item) => item.endsWith('.md'))) {
  const text = await readFile(file, 'utf8');
  for (const match of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    const raw = match[1].trim().replace(/^<|>$/g, '');
    if (!raw || /^(?:https?:|mailto:|#)/i.test(raw)) continue;
    const relative = decodeURI(raw.split('#')[0].split('?')[0]);
    if (!relative) continue;
    const target = path.resolve(path.dirname(file), relative);
    try {
      await stat(target);
    } catch {
      failures.push(`${path.relative(root, file)}: broken local Markdown link ${raw}`);
    }
  }
}
for (const file of codeFiles) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) failures.push(`${path.relative(root, file)}: syntax error\n${result.stderr.trim()}`);
}
if (pythonFiles.length) {
  const python = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
  const compileOnly = [
    '-c',
    "import pathlib,sys; [compile(pathlib.Path(p).read_text(encoding='utf-8'), p, 'exec') for p in sys.argv[1:]]",
    ...pythonFiles,
  ];
  const result = spawnSync(python, compileOnly, { encoding: 'utf8' });
  if (result.status !== 0) {
    failures.push(`Python source syntax check failed\n${(result.stderr || result.error?.message || '').trim()}`);
  }
}

for (const file of files.filter((item) => /\.(?:js|mjs|html|css)$/.test(item) && path.basename(item) !== 'check-project.mjs')) {
  const text = await readFile(file, 'utf8');
  if (/\b(?:TODO|FIXME|HACK)\b/.test(text)) failures.push(`${path.relative(root, file)}: unresolved marker`);
}

for (const providerId of ['signals', 'pulse', 'source', 'deploy', 'status', 'mirage']) {
  const providerSource = await readFile(path.join(root, `providers/recovery/${providerId}.js`), 'utf8');
  if (!providerSource.includes('document.modelContext.registerTool')) {
    failures.push(`providers/recovery/${providerId}.js: literal native registerTool call missing`);
  }
  if (!providerSource.includes('exposedTo: [orchestratorOrigin]')) {
    failures.push(`providers/recovery/${providerId}.js: explicit orchestrator exposure missing`);
  }
}
const appSource = await readFile(path.join(root, 'src/app/main.js'), 'utf8');
for (const signal of ['createMissionController', 'missionController.discoverAndPlan', 'missionController.runSafe', 'missionController.executeApproved']) {
  if (!appSource.includes(signal)) failures.push(`src/app/main.js: real controller integration missing ${signal}`);
}
const publicSurfaceStart = appSource.indexOf('window.__TOOLBRAID_V2__ = Object.freeze');
const publicSurfaceEnd = appSource.indexOf('const unsubscribeMissionController', publicSurfaceStart);
const publicSurface = appSource.slice(publicSurfaceStart, publicSurfaceEnd);
if (/approveApply|approvePublish|approveScope/.test(publicSurface)) {
  failures.push('src/app/main.js: human approval creator leaked into public automation surface');
}

const html = await readFile(path.join(root, 'index.html'), 'utf8');
for (const match of html.matchAll(/(?:src|href)="(\.\/[^"?#]+)"/g)) {
  const target = path.resolve(root, match[1]);
  try { await stat(target); } catch { failures.push(`index.html: broken local reference ${match[1]}`); }
}

if (failures.length) {
  console.error(`Project check failed (${failures.length}):`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log(`Project check passed: ${required.length} required artifacts, ${codeFiles.length} JavaScript modules, ${pythonFiles.length} Python sources, no rejected demo surface, no unresolved implementation markers.`);
