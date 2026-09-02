import { mkdir, readFile, rm, writeFile, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.resolve(process.argv[2] ?? path.join(root, 'dist'));
const importPattern = /import\s*\{([\s\S]*?)\}\s*from\s*["']([^"']+)["']\s*;/g;
const moduleId = (filename) => path.relative(root, filename).split(path.sep).join('/');
function resolveImport(owner, specifier) {
  if (!specifier.startsWith('.')) throw new Error(`Standalone build only supports relative imports: ${specifier}`);
  return path.resolve(path.dirname(owner), specifier);
}
function destructuring(specifiers) {
  return specifiers.split(',').map((item) => item.trim()).filter(Boolean).map((item) => item.replace(/\s+as\s+/, ': ')).join(', ');
}
async function bundle(entryRelative) {
  const modules = new Map();
  const visiting = new Set();
  async function visit(filename) {
    const id = moduleId(filename);
    if (modules.has(id)) return;
    if (visiting.has(id)) throw new Error(`Circular module dependency: ${id}`);
    visiting.add(id);
    let source = await readFile(filename, 'utf8');
    const imports = [];
    for (const match of source.matchAll(importPattern)) {
      const dependency = resolveImport(filename, match[2]);
      imports.push({ names: destructuring(match[1]), id: moduleId(dependency) });
      await visit(dependency);
    }
    source = source.replace(importPattern, '');
    const exports = new Map();
    const addExport = (localName, exportedName = localName) => exports.set(exportedName, localName);
    source = source.replace(/export\s+async\s+function\s+([A-Za-z_$][\w$]*)/g, (_, name) => { addExport(name); return `async function ${name}`; });
    source = source.replace(/export\s+function\s+([A-Za-z_$][\w$]*)/g, (_, name) => { addExport(name); return `function ${name}`; });
    source = source.replace(/export\s+class\s+([A-Za-z_$][\w$]*)/g, (_, name) => { addExport(name); return `class ${name}`; });
    source = source.replace(/export\s+const\s+([A-Za-z_$][\w$]*)/g, (_, name) => { addExport(name); return `const ${name}`; });
    source = source.replace(/export\s*\{([\s\S]*?)\}\s*;/g, (_, specifiers) => {
      for (const specifier of specifiers.split(',').map((item) => item.trim()).filter(Boolean)) {
        const match = specifier.match(/^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/);
        if (!match) throw new Error(`Unsupported export specifier in ${id}: ${specifier}`);
        addExport(match[1], match[2] ?? match[1]);
      }
      return '';
    });
    if (/\bexport\b/.test(source)) throw new Error(`Unsupported export syntax remains in ${id}`);
    const importLines = imports.map((item) => `const { ${item.names} } = __modules[${JSON.stringify(item.id)}];`).join('\n');
    const returnLine = exports.size
      ? `return { ${[...exports].map(([exported, local]) => exported === local ? local : `${exported}: ${local}`).join(', ')} };`
      : 'return Object.freeze({});';
    modules.set(id, `\n__modules[${JSON.stringify(id)}] = (() => {\n${importLines}\n${source}\n${returnLine}\n})();\n`);
    visiting.delete(id);
  }
  const entry = path.resolve(root, entryRelative);
  await visit(entry);
  return `(() => {\n'use strict';\nconst __modules = Object.create(null);\n${[...modules.values()].join('\n')}\n})();`;
}
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await mkdir(path.join(output, 'assets'), { recursive: true });
let html = await readFile(path.join(root, 'live.html'), 'utf8');
const css = await readFile(path.join(root, 'src/app/mission-control.css'), 'utf8');
const favicon = await readFile(path.join(root, 'assets/favicon.svg'), 'utf8');
const mainBundle = await bundle('src/app/main.js');
html = html
  .replace(/<link\s+rel=["']manifest["'][^>]*>\s*/i, '')
  .replace(/<link\s+rel=["']icon["'][^>]*>/i, `<link rel="icon" href="data:image/svg+xml,${encodeURIComponent(favicon)}">`)
  .replace(/<link\s+rel=["']stylesheet["'][^>]*>/i, `<style>${css}</style>`)
  .replace(/<script\s+type=["']module["'][^>]*><\/script>/i, `<script>${mainBundle.replaceAll('</script>', '<\\/script>')}</script>`);
if (/<iframe\b/i.test(html)) throw new Error('V4 standalone must not contain provider iframes');
if (/src=["']\.\/src\/app\/main\.js["']/i.test(html)) throw new Error('V4 application bundle was not inlined');
await writeFile(path.join(output, 'index.html'), html);
await copyFile(path.join(root, 'assets', 'favicon.svg'), path.join(output, 'assets', 'favicon.svg'));
for (const filename of ['vercel.json', 'robots.txt', 'llms.txt', '.nojekyll']) await copyFile(path.join(root, filename), path.join(output, filename));
console.log(`Standalone ToolBraid build written to ${output} (${Buffer.byteLength(html).toLocaleString()} HTML bytes).`);
