import {
  createCapabilityPackCatalog,
  publicCapabilityPackManifest,
} from './catalog.js';
import { createGitHubAdapter } from '../../site-adapters/github.js';
import { createVercelAdapter } from '../../site-adapters/vercel.js';
import { createXPostAdapter } from '../../site-adapters/x.js';

// ServiceWorkerGlobalScope forbids import(), so the trusted creators are
// statically bundled while adapter instances are still created only after an
// exact catalog selector matches the active page.
const rawBuiltins = [
  {
    id: 'site.x',
    version: '1',
    priority: 100,
    maxTools: 8,
    hints: {
      hosts: ['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com'],
      pathPrefixes: ['/'],
      objectiveTokens: ['x', 'post', 'tweet', 'reply', 'like', 'repost', 'social'],
    },
    load: () => createXPostAdapter(),
  },
  {
    id: 'site.github',
    version: '1',
    priority: 90,
    maxTools: 4,
    hints: {
      hosts: ['github.com', 'www.github.com'],
      pathPrefixes: ['/'],
      objectiveTokens: ['github', 'repository', 'repo', 'commit', 'issue', 'pull', 'request', 'code'],
    },
    load: () => createGitHubAdapter(),
  },
  {
    id: 'site.vercel',
    version: '1',
    priority: 90,
    maxTools: 4,
    hints: {
      hosts: ['vercel.com', 'www.vercel.com'],
      pathPrefixes: ['/'],
      objectiveTokens: ['vercel', 'deployment', 'deploy', 'project', 'preview', 'production', 'rollback'],
    },
    load: () => createVercelAdapter(),
  },
];

const trustedBuiltinCatalog = createCapabilityPackCatalog(rawBuiltins);

// Public built-in projections intentionally contain no executable loader.  A
// caller that needs to construct the trusted registry uses the explicitly
// internal factory below, never a page/provider payload.
export const UNIVERSAL_BUILTIN_CAPABILITY_PACKS = Object.freeze(
  trustedBuiltinCatalog.map(publicCapabilityPackManifest),
);

export const UNIVERSAL_X_CAPABILITY_PACK = UNIVERSAL_BUILTIN_CAPABILITY_PACKS.find((pack) => pack.id === 'site.x');
export const UNIVERSAL_GITHUB_CAPABILITY_PACK = UNIVERSAL_BUILTIN_CAPABILITY_PACKS.find((pack) => pack.id === 'site.github');
export const UNIVERSAL_VERCEL_CAPABILITY_PACK = UNIVERSAL_BUILTIN_CAPABILITY_PACKS.find((pack) => pack.id === 'site.vercel');

export function createUniversalBuiltinCapabilityPackCatalog() {
  return UNIVERSAL_BUILTIN_CAPABILITY_PACKS;
}

/**
 * Internal bridge for trusted application wiring.  It is deliberately not
 * re-exported from the public universal pack index.
 */
export function createInternalUniversalBuiltinCapabilityPackCatalog() {
  return createCapabilityPackCatalog(trustedBuiltinCatalog);
}
