import { Registry, Gauge, Counter, Histogram, collectDefaultMetrics } from "prom-client";

export const registry = new Registry();
collectDefaultMetrics({ register: registry });

// --- Stale label-series pruning -------------------------------------------
//
// prom-client (like every Prometheus client lib) never expires a label
// combination on its own — once `repo="foo",job="test (ubuntu, 3.11)"` is
// observed, that time series lives in memory for the life of the process.
// For long-lived pods that's a slow cardinality leak: renamed/archived repos,
// retired matrix combinations, etc. all leave permanent stale series.
//
// `LabelTracker` records a last-seen timestamp per label combination for a
// given metric, and `pruneStaleMetrics()` (called once per poll cycle from
// poller.js) removes any combination not touched within METRIC_TTL_DAYS.
const trackers = [];

class LabelTracker {
  constructor(metric) {
    this.metric = metric;
    // key -> { labels, lastSeen }
    this.seen = new Map();
    trackers.push(this);
  }

  static keyFor(labels) {
    // Stable key regardless of property insertion order.
    return Object.keys(labels)
      .sort()
      .map((k) => `${k}=${labels[k]}`)
      .join(",");
  }

  touch(labels) {
    this.seen.set(LabelTracker.keyFor(labels), { labels, lastSeen: Date.now() });
  }

  pruneStale(ttlMs) {
    const cutoff = Date.now() - ttlMs;
    let removed = 0;
    for (const [key, entry] of this.seen) {
      if (entry.lastSeen < cutoff) {
        this.metric.remove(entry.labels);
        this.seen.delete(key);
        removed++;
      }
    }
    return removed;
  }
}

/**
 * Call once per poll cycle. Returns the number of stale series removed,
 * for logging.
 */
export function pruneStaleMetrics(ttlDays) {
  const ttlMs = ttlDays * 24 * 60 * 60 * 1000;
  return trackers.reduce((total, tracker) => total + tracker.pruneStale(ttlMs), 0);
}

// Counters/histograms (not raw per-run_id gauges) are used deliberately: a
// gauge labeled with run_id would grow without bound as new workflow runs are
// created, which is the classic high-cardinality trap with GitHub Actions
// metrics. Instead we count/observe each completed run exactly once (see
// poller.js's seen-run dedup) and keep labels bounded to repo/workflow/event.

export const workflowRunsTotal = new Counter({
  name: "github_actions_workflow_runs_total",
  help: "Total number of completed GitHub Actions workflow runs observed, by outcome.",
  labelNames: ["repo", "workflow", "event", "conclusion"],
  registers: [registry],
});
const workflowRunsTotalTracker = new LabelTracker(workflowRunsTotal);

export const workflowRunDurationSeconds = new Histogram({
  name: "github_actions_workflow_run_duration_seconds",
  help: "Wall-clock duration of completed workflow runs, from run start to completion.",
  labelNames: ["repo", "workflow", "event", "conclusion"],
  buckets: [60, 300, 900],
  registers: [registry],
});
const workflowRunDurationSecondsTracker = new LabelTracker(workflowRunDurationSeconds);

export const workflowQueueDurationSeconds = new Histogram({
  name: "github_actions_workflow_queue_duration_seconds",
  help: "Time a workflow run spent queued before a runner (ARC) picked it up.",
  labelNames: ["repo", "workflow", "event"],
  buckets: [60, 300, 900],
  registers: [registry],
});
const workflowQueueDurationSecondsTracker = new LabelTracker(workflowQueueDurationSeconds);

export const workflowRunsInProgress = new Gauge({
  name: "github_actions_workflow_runs_in_progress",
  help: "Number of workflow runs currently queued or in_progress.",
  labelNames: ["repo", "workflow", "event", "status"],
  registers: [registry],
});

export const jobRunsTotal = new Counter({
  name: "github_actions_job_runs_total",
  help: "Total number of completed GitHub Actions jobs observed, by outcome.",
  labelNames: ["repo", "workflow", "job", "conclusion"],
  registers: [registry],
});
const jobRunsTotalTracker = new LabelTracker(jobRunsTotal);

export const jobRunDurationSeconds = new Histogram({
  name: "github_actions_job_run_duration_seconds",
  help: "Wall-clock duration of completed jobs, from job start to completion.",
  labelNames: ["repo", "workflow", "job", "conclusion"],
  buckets: [60, 300, 900],
  registers: [registry],
});
const jobRunDurationSecondsTracker = new LabelTracker(jobRunDurationSeconds);

export const stepRunsTotal = new Counter({
  name: "github_actions_step_runs_total",
  help: "Total number of completed GitHub Actions steps observed, by outcome.",
  labelNames: [
    "repo",
    "workflow",
    "job",
    "step",
    "step_number",
    "conclusion",
  ],
  registers: [registry],
});
const stepRunsTotalTracker = new LabelTracker(stepRunsTotal);

export const stepRunDurationSeconds = new Histogram({
  name: "github_actions_step_run_duration_seconds",
  help: "Wall-clock duration of completed GitHub Actions steps.",
  labelNames: [
    "repo",
    "workflow",
    "job",
    "step",
    "step_number",
    "conclusion",
  ],
  buckets: [60, 300, 900],
  registers: [registry],
});
const stepRunDurationSecondsTracker = new LabelTracker(stepRunDurationSeconds);

// Gated behind COLLECT_RUNNER_STATUS because ARC ephemeral runners get a new
// name per job, which would otherwise cause unbounded label cardinality.
export const runnerStatus = new Gauge({
  name: "github_actions_runner_status",
  help: "Self-hosted runner status (1=online, 0=offline). High-cardinality with ephemeral (ARC) runners — opt-in only.",
  labelNames: ["repo", "name", "os", "busy"],
  registers: [registry],
});
const runnerStatusTracker = new LabelTracker(runnerStatus);

export const scrapeDurationSeconds = new Gauge({
  name: "github_actions_exporter_scrape_duration_seconds",
  help: "Duration of the last full poll cycle across all installations/repos.",
  registers: [registry],
});

export const scrapeErrorsTotal = new Counter({
  name: "github_actions_exporter_scrape_errors_total",
  help: "Number of errors encountered while polling the GitHub API.",
  labelNames: ["stage"],
  registers: [registry],
});

export const rateLimitRemaining = new Gauge({
  name: "github_actions_exporter_rate_limit_remaining",
  help: "Remaining GitHub API rate limit for the polling installation, by resource.",
  labelNames: ["installation_id", "resource"],
  registers: [registry],
});

export const trackedMetrics = {
  workflowRunsTotal: workflowRunsTotalTracker,
  workflowRunDurationSeconds: workflowRunDurationSecondsTracker,
  workflowQueueDurationSeconds: workflowQueueDurationSecondsTracker,
  jobRunsTotal: jobRunsTotalTracker,
  jobRunDurationSeconds: jobRunDurationSecondsTracker,
  stepRunsTotal: stepRunsTotalTracker,
  stepRunDurationSeconds: stepRunDurationSecondsTracker,
  runnerStatus: runnerStatusTracker,
};
