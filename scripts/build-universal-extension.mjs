import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, '..');
const DEFAULT_OUTPUT = path.join(PROJECT_ROOT, 'dist', 'toolbraid-universal-extension');

function assertBuildTarget(outputDir) {
  const distRoot = path.resolve(PROJECT_ROOT, 'dist');
  const resolved = path.resolve(outputDir);
  if (resolved === distRoot || !resolved.startsWith(`${distRoot}${path.sep}`)) {
    throw new Error(`Extension output must stay inside ${distRoot}`);
  }
  return resolved;
}

function rewriteExtensionModule(source) {
  // Source modules live under extension/, while the unpacked build flattens
  // them beside manifest.json. Keep the source tree easy to test and rewrite
  // only imports that cross into src/.
  return source
    .replaceAll("from '../src/", "from './src/")
    .replaceAll('from "../src/', 'from "./src/')
    .replaceAll("import('../src/", "import('./src/")
    .replaceAll('import("../src/', 'import("./src/');
}

async function rewriteExtensionModules(sourceDir, targetDir) {
  const entries = await readdir(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);
    if (entry.isDirectory()) {
      await rewriteExtensionModules(sourcePath, targetPath);
      continue;
    }
    if (!entry.isFile() || path.extname(entry.name) !== '.js') continue;
    const source = await readFile(targetPath, 'utf8');
    const rewritten = rewriteExtensionModule(source);
    if (rewritten !== source) await writeFile(targetPath, rewritten, 'utf8');
  }
}

export async function buildUniversalExtension({ outputDir = DEFAULT_OUTPUT } = {}) {
  const target = assertBuildTarget(outputDir);
  const extensionSource = path.join(PROJECT_ROOT, 'extension');
  const srcSource = path.join(PROJECT_ROOT, 'src');

  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true });
  await cp(extensionSource, target, { recursive: true });
  await cp(srcSource, path.join(target, 'src'), { recursive: true });

  await rewriteExtensionModules(extensionSource, target);

  const manifest = JSON.parse(await readFile(path.join(target, 'manifest.json'), 'utf8'));
  if (manifest.manifest_version !== 3 || manifest.background?.type !== 'module') {
    throw new Error('Universal extension build requires a Manifest V3 module service worker.');
  }

  const buildMetadata = {
    product: manifest.name,
    version: manifest.version,
    manifestVersion: manifest.manifest_version,
    generatedAt: new Date().toISOString(),
    loadUnpackedDirectory: target,
  };
  await writeFile(
    path.join(target, 'build-metadata.json'),
    `${JSON.stringify(buildMetadata, null, 2)}\n`,
    'utf8',
  );
  return Object.freeze(buildMetadata);
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  const metadata = await buildUniversalExtension();
  process.stdout.write(`${JSON.stringify(metadata, null, 2)}\n`);
}
