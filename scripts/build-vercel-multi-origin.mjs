import { cp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const defaultOutput = path.join(projectRoot, 'dist', 'vercel-multi-origin');
const output = path.resolve(process.argv[2] ?? defaultOutput);
const providerIds = Object.freeze(['signals', 'pulse', 'source', 'deploy', 'status', 'mirage']);

function isWithin(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function assertSafeOutput(target) {
  const allowedRoots = [path.join(projectRoot, 'dist'), os.tmpdir()];
  if (!allowedRoots.some((allowedRoot) => isWithin(allowedRoot, target))) {
    throw new Error(`Vercel build output must stay inside ${path.join(projectRoot, 'dist')} or the system temporary directory.`);
  }
}

async function copyIntoOrigin(originId, sourceRelative, destinationRelative = sourceRelative) {
  const source = path.join(projectRoot, sourceRelative);
  const destination = path.join(output, '_toolbraid_origins', originId, destinationRelative);
  await mkdir(path.dirname(destination), { recursive: true });
  await cp(source, destination, { recursive: true, force: true });
}

assertSafeOutput(output);
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });

for (const relative of [
  'index.html',
  'manifest.webmanifest',
  'robots.txt',
  'llms.txt',
  'assets/favicon.svg',
  'src/app',
  'src/engine',
  'src/packs/recovery',
  'src/providers/recovery/catalog.js',
]) {
  await copyIntoOrigin('app', relative);
}

for (const providerId of providerIds) {
  await copyIntoOrigin(providerId, `providers/recovery/${providerId}.html`, 'index.html');
  await copyIntoOrigin(providerId, `providers/recovery/${providerId}.js`, 'provider.js');
  await copyIntoOrigin(providerId, 'providers/recovery/provider.css', 'provider.css');
  await copyIntoOrigin(providerId, 'providers/recovery/runtime.js', 'runtime.js');
  await copyIntoOrigin(providerId, 'src/providers/recovery/catalog.js');
}

console.log(`Vercel multi-origin static build written to ${output} (7 isolated HTTPS origin roots).`);
