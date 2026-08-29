export {
  SiteAdapterError,
  createSiteAdapterRegistry,
} from './registry.js';

export {
  X_POST_HOSTS,
  createXPostAdapter,
  extractXPost,
} from './x.js';

export {
  GITHUB_ADAPTER_VERSION,
  GITHUB_HOSTS,
  createGitHubAdapter,
  createGithubAdapter,
  createGitHubPageAdapter,
  extractGitHubCommit,
  extractGitHubIssue,
  extractGitHubPage,
  extractGitHubPullRequest,
  extractGitHubRepository,
  parseGitHubRoute,
} from './github.js';

export {
  VERCEL_ADAPTER_VERSION,
  VERCEL_HOSTS,
  createVercelAdapter,
  createVercelPageAdapter,
  extractVercelDeployment,
  extractVercelPage,
  extractVercelProject,
  parseVercelRoute,
} from './vercel.js';
