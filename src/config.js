// Central place for tunables so behavior can be changed via env vars
// without touching code — needed for K8s ConfigMap/Secret driven config.
export const config = {
  appId: process.env.GITHUB_APP_ID,
  privateKey: (process.env.GITHUB_APP_PRIVATE_KEY || "").replace(/\\n/g, "\n"),
  // Some deployments mount the PEM as a file instead of an env var (nicer for K8s secrets).
  privateKeyPath: process.env.GITHUB_APP_PRIVATE_KEY_PATH,
  webhookSecret: process.env.GITHUB_APP_WEBHOOK_SECRET, // unused, kept for App() constructor compatibility
  // If set, only poll this installation. Otherwise poll every installation the App has.
  installationId: process.env.GITHUB_APP_INSTALLATION_ID
    ? Number(process.env.GITHUB_APP_INSTALLATION_ID)
    : undefined,

  githubApiUrl: process.env.GITHUB_API_URL || "https://api.github.com",

  port: Number(process.env.PORT || 9101),
  metricsPath: process.env.METRICS_PATH || "/metrics",

  pollIntervalSeconds: Number(process.env.POLL_INTERVAL_SECONDS || 60),
  // How many most-recent workflow runs to inspect per repo on each poll.
  runsPerRepo: Number(process.env.RUNS_PER_REPO || 30),
  // Only consider repos pushed to in the last N days, to avoid wasting API
  // quota scanning stale/archived repos in large orgs.
  activeSinceDays: Number(process.env.ACTIVE_SINCE_DAYS || 14),

  // Self-hosted runner status metrics can have high cardinality with ARC
  // ephemeral runners (a new runner name per job). Off by default.
  collectRunnerStatus: /^true$/i.test(process.env.COLLECT_RUNNER_STATUS || "false"),

  // Counters/histograms never expire label combinations on their own (see
  // metrics.js). Any repo/workflow/job label combo not observed again within
  // this many days gets pruned from the registry on the next poll cycle.
  metricTtlDays: Number(process.env.METRIC_TTL_DAYS || 30),

  logLevel: process.env.LOG_LEVEL || "info",
};

export function validateConfig() {
  const errors = [];
  if (!config.appId) errors.push("GITHUB_APP_ID is required");
  if (!config.privateKey && !config.privateKeyPath) {
    errors.push("GITHUB_APP_PRIVATE_KEY or GITHUB_APP_PRIVATE_KEY_PATH is required");
  }
  if (errors.length) {
    throw new Error(`Invalid configuration:\n  - ${errors.join("\n  - ")}`);
  }
}
