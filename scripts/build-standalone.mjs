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
    const exports = new Set();
    source = source.replace(/export\s+async\s+function\s+([A-Za-z_$][\w$]*)/g, (_, name) => { exports.add(name); return `async function ${name}`; });
    source = source.replace(/export\s+function\s+([A-Za-z_$][\w$]*)/g, (_, name) => { exports.add(name); return `function ${name}`; });
    source = source.replace(/export\s+class\s+([A-Za-z_$][\w$]*)/g, (_, name) => { exports.add(name); return `class ${name}`; });
    source = source.replace(/export\s+const\s+([A-Za-z_$][\w$]*)/g, (_, name) => { exports.add(name); return `const ${name}`; });
    if (/\bexport\b/.test(source)) throw new Error(`Unsupported export syntax remains in ${id}`);
    const importLines = imports.map((item) => `const { ${item.names} } = __modules[${JSON.stringify(item.id)}];`).join('\n');
    const returnLine = exports.size ? `return { ${[...exports].join(', ')} };` : 'return Object.freeze({});';
    modules.set(id, `\n__modules[${JSON.stringify(id)}] = (() => {\n${importLines}\n${source}\n${returnLine}\n})();\n`);
    visiting.delete(id);
  }
  const entry = path.resolve(root, entryRelative);
  await visit(entry);
  return `(() => {\n'use strict';\nconst __modules = Object.create(null);\n${[...modules.values()].join('\n')}\n})();`;
}
function inlineProviderHtml(html, css, javascript) {
  let result = html.replace(/<link\s+rel=["']stylesheet["'][^>]*>/i, '').replace(/<script\s+type=["']module["'][^>]*><\/script>/i, '');
  result = result.replace('</head>', `<style>${css}</style></head>`);
  result = result.replace('</body>', `<script>${javascript.replaceAll('</script>', '<\\/script>')}</script></body>`);
  return result;
}
const escapeAttribute = (value) => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;');
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
let html = await readFile(path.join(root, 'index.html'), 'utf8');
const css = await readFile(path.join(root, 'styles.css'), 'utf8');
const providerCss = await readFile(path.join(root, 'providers/provider-shell.css'), 'utf8');
const favicon = await readFile(path.join(root, 'assets/favicon.svg'), 'utf8');
const mainBundle = await bundle('js/app.js');
html = html
  .replace(/<link\s+rel=["']manifest["'][^>]*>\s*/i, '')
  .replace(/<link\s+rel=["']icon["'][^>]*>/i, `<link rel="icon" href="data:image/svg+xml,${encodeURIComponent(favicon)}">`)
  .replace(/<link\s+rel=["']stylesheet["'][^>]*>/i, `<style>${css}</style>`)
  .replace(/<script\s+type=["']module["'][^>]*><\/script>/i, `<script>${mainBundle.replaceAll('</script>', '<\\/script>')}</script>`);
for (const provider of ['rail', 'stay', 'geo', 'rogue']) {
  const providerHtml = await readFile(path.join(root, `providers/${provider}.html`), 'utf8');
  const providerBundle = await bundle(`providers/${provider}.js`);
  const srcdoc = escapeAttribute(inlineProviderHtml(providerHtml, providerCss, providerBundle));
  const pattern = new RegExp(`src=["']\\./providers/${provider}\\.html["']`);
  if (!pattern.test(html)) throw new Error(`Provider iframe not found: ${provider}`);
  html = html.replace(pattern, `srcdoc="${srcdoc}"`);
}
await writeFile(path.join(output, 'index.html'), html);
for (const filename of ['vercel.json', 'robots.txt', 'llms.txt', '.nojekyll']) await copyFile(path.join(root, filename), path.join(output, filename));
console.log(`Standalone ToolBraid build written to ${output} (${Buffer.byteLength(html).toLocaleString()} HTML bytes).`);
