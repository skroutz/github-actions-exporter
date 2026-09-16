import fs from "node:fs";
import { App, Octokit } from "octokit";
import { config } from "./config.js";
import { log } from "./logger.js";

// Note: the "octokit" package already bundles @octokit/plugin-throttling and
// @octokit/plugin-retry by default, so rate-limit backoff works out of the box
// via the `throttle` option below — no separate plugin composition needed.

function loadPrivateKey() {
  if (config.privateKeyPath) {
    return fs.readFileSync(config.privateKeyPath, "utf8");
  }
  return config.privateKey;
}

let appInstance;

/**
 * Lazily construct the GitHub App client. Using a GitHub App instead of a PAT
 * gives us org-wide installation discovery and a much higher rate limit
 * (~15k req/hr per installation vs 5k/hr for a user PAT).
 */
export function getApp() {
  if (appInstance) return appInstance;

  appInstance = new App({
    appId: config.appId,
    privateKey: loadPrivateKey(),
    Octokit,
    octokitOptions: {
      baseUrl: config.githubApiUrl,
      throttle: {
        onRateLimit: (retryAfter, options, octokit, retryCount) => {
          log.warn(`Rate limit hit for ${options.method} ${options.url}, retry #${retryCount}`);
          // Retry a bounded number of times so a misbehaving poll doesn't hang forever.
          return retryCount < 2;
        },
        onSecondaryRateLimit: (retryAfter, options) => {
          log.warn(`Secondary rate limit hit for ${options.method} ${options.url}`);
          return true;
        },
      },
    },
  });

  return appInstance;
}

/**
 * Returns an authenticated Octokit instance per installation, plus metadata
 * about the installation (account/org login) needed for labeling metrics.
 * If GITHUB_APP_INSTALLATION_ID is set, only that installation is returned —
 * otherwise every installation the App has is polled (true org/enterprise-wide
 * discovery, replacing the static repo lists used by older exporters).
 */
export async function* eachInstallationOctokit() {
  const app = getApp();

  if (config.installationId) {
    const octokit = await app.getInstallationOctokit(config.installationId);
    yield { installationId: config.installationId, octokit };
    return;
  }

  for await (const { octokit, installation } of app.eachInstallation.iterator()) {
    yield { installationId: installation.id, octokit, account: installation.account };
  }
}

/**
 * All repos an installation can see, filtered to ones pushed to recently so we
 * don't burn API quota re-scanning dormant repos every poll cycle.
 */
export async function listActiveRepos(octokit) {
  const cutoff = Date.now() - config.activeSinceDays * 24 * 60 * 60 * 1000;
  const repos = await octokit.paginate(octokit.rest.apps.listReposAccessibleToInstallation, {
    per_page: 100,
  });

  return repos.filter((repo) => new Date(repo.pushed_at).getTime() >= cutoff);
}

export async function listRecentWorkflowRuns(octokit, owner, repo) {
  const { data } = await octokit.rest.actions.listWorkflowRunsForRepo({
    owner,
    repo,
    per_page: config.runsPerRepo,
  });
  return data.workflow_runs;
}

export async function listSelfHostedRunners(octokit, owner, repo) {
  return octokit.paginate(octokit.rest.actions.listSelfHostedRunnersForRepo, {
    owner,
    repo,
    per_page: 100,
  });
}
