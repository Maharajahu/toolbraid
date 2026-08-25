import { readdir, readFile, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const required = [
  'index.html', 'styles.css', 'js/app.js', 'js/core/webmcp-runtime.js',
  'providers/rail.html', 'providers/stay.html', 'providers/geo.html', 'providers/rogue.html',
  'README.md', 'LICENSE', 'docs/architecture.md', 'docs/product-spec.md',
  'docs/research/prior-art.md', 'docs/threat-model.md', 'docs/demo-script.md',
  'docs/video-script.md', 'docs/submission-description.md', 'docs/challenge-requirements.md',
  'docs/testing.md', 'docs/final-validation-report.md', 'docs/e2e-validation.json',
  'docs/screenshots/toolbraid-approval.png', 'docs/screenshots/toolbraid-completed.png',
  'docs/screenshots/toolbraid-mobile-approval.png', 'docs/screenshots/toolbraid-video-thumbnail.png',
  'docs/video-production-report.md', 'docs/video-validation.json', 'docs/publication-runbook.md',
  'release/ToolBraid-WebMCP-Challenge-Demo.mp4', 'release/ToolBraid-WebMCP-Challenge-Demo.srt',
  '.github/workflows/pages.yml', '.nojekyll',
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

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (['.git', 'node_modules'].includes(entry.name)) continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(full));
    else files.push(full);
  }
  return files;
}

const files = await walk(root);
const codeFiles = files.filter((file) => /\.(?:js|mjs)$/.test(file));

for (const relative of ['package.json', 'manifest.webmanifest', 'docs/e2e-validation.json']) {
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

for (const file of files.filter((item) => /\.(?:js|mjs|html|css)$/.test(item) && path.basename(item) !== 'check-project.mjs')) {
  const text = await readFile(file, 'utf8');
  if (/\b(?:TODO|FIXME|HACK)\b/.test(text)) failures.push(`${path.relative(root, file)}: unresolved marker`);
}

const runtimeSource = await readFile(path.join(root, 'js/core/webmcp-runtime.js'), 'utf8');
if (!runtimeSource.includes('document.modelContext.registerTool')) {
  failures.push('js/core/webmcp-runtime.js: explicit document.modelContext.registerTool call missing');
}
const appSource = await readFile(path.join(root, 'js/app.js'), 'utf8');
for (const name of ['toolbraid.plan_mission', 'toolbraid.execute_safe_steps', 'toolbraid.execute_approved_actions', 'toolbraid.inspect_state']) {
  if (!appSource.includes(name)) failures.push(`js/app.js: orchestration tool ${name} missing`);
}
const publicSurfaceStart = appSource.indexOf('window.ToolBraidApp = Object.freeze');
const publicSurfaceEnd = appSource.indexOf('window.__toolbraidReady', publicSurfaceStart);
const publicSurface = appSource.slice(publicSurfaceStart, publicSurfaceEnd);
if (publicSurface.includes('approveSelectedActions')) {
  failures.push('js/app.js: human approval creator leaked into agent/test public surface');
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
console.log(`Project check passed: ${required.length} required artifacts, ${codeFiles.length} JavaScript modules, no unresolved implementation markers.`);
