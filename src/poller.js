import { config } from "./config.js";
import { log } from "./logger.js";
import {
  eachInstallationOctokit,
  listActiveRepos,
  listRecentWorkflowRuns,
  listSelfHostedRunners,
} from "./github.js";
import {
  workflowRunsTotal,
  workflowRunDurationSeconds,
  workflowQueueDurationSeconds,
  workflowRunsInProgress,
  jobRunsTotal,
  jobRunDurationSeconds,
  stepRunsTotal,
  stepRunDurationSeconds,
  runnerStatus,
  scrapeDurationSeconds,
  scrapeErrorsTotal,
  rateLimitRemaining,
  trackedMetrics,
  pruneStaleMetrics,
} from "./metrics.js";

// Dedup state so a completed run/job observed on poll N isn't double-counted
// on poll N+1 (we always re-fetch the last `runsPerRepo` runs). This is
// in-memory only: a pod restart will re-count runs still within the
// runsPerRepo/activeSinceDays window once. That's an acceptable tradeoff for
// a polling-based (as opposed to webhook-based) exporter.
const seenCompletedRunIds = new Set();
const seenQueueTimeRunIds = new Set();
const seenCompletedJobIds = new Set();

const MAX_DEDUP_ENTRIES = 50_000;

function pruneIfNeeded(set) {
  if (set.size <= MAX_DEDUP_ENTRIES) return;
  // Cheap unbounded-growth guard: drop the oldest half (Set preserves
  // insertion order) rather than pulling in an LRU dependency.
  const toDrop = set.size - MAX_DEDUP_ENTRIES / 2;
  const it = set.values();
  for (let i = 0; i < toDrop; i++) set.delete(it.next().value);
}

function baseLabels(repoFullName, run) {
  const labels = {
    repo: repoFullName,
    workflow: run.name || String(run.workflow_id),
    event: run.event,
  };
  if (config.includeRunNumberLabel && run.run_number !== undefined) {
    labels.run_number = String(run.run_number);
  }
  return labels;
}

async function pollRun(octokit, repoFullName, run) {
  const labels = baseLabels(repoFullName, run);

  if (run.status !== "completed") {
    workflowRunsInProgress.inc({ ...labels, status: run.status });
  }

  // Queue time: how long the run waited before a runner picked it up. Record
  // once per run as soon as run_started_at is available.
  if (run.run_started_at && !seenQueueTimeRunIds.has(run.id)) {
    const queueSeconds = (new Date(run.run_started_at) - new Date(run.created_at)) / 1000;
    if (queueSeconds >= 0 && workflowQueueDurationSeconds) {
      workflowQueueDurationSeconds.observe(labels, queueSeconds);
      trackedMetrics.workflowQueueDurationSeconds.touch(labels);
    }
    seenQueueTimeRunIds.add(run.id);
  }

  if (run.status !== "completed" || seenCompletedRunIds.has(run.id)) {
    return;
  }
  seenCompletedRunIds.add(run.id);

  const conclusionLabels = { ...labels, conclusion: run.conclusion || "unknown" };
  workflowRunsTotal.inc(conclusionLabels);
  trackedMetrics.workflowRunsTotal.touch(conclusionLabels);

  const start = run.run_started_at || run.created_at;
  const durationSeconds = (new Date(run.updated_at) - new Date(start)) / 1000;
  if (durationSeconds >= 0 && workflowRunDurationSeconds) {
    workflowRunDurationSeconds.observe(conclusionLabels, durationSeconds);
    trackedMetrics.workflowRunDurationSeconds.touch(conclusionLabels);
  }

  await pollJobsForRun(octokit, repoFullName, run);
}

export async function pollJobsForRun(octokit, repoFullName, run) {
  try {
    const jobs = await octokit.paginate(octokit.rest.actions.listJobsForWorkflowRun, {
      owner: repoFullName.split("/")[0],
      repo: repoFullName.split("/")[1],
      run_id: run.id,
      per_page: 100,
    });

    for (const job of jobs) {
      if (job.status !== "completed" || seenCompletedJobIds.has(job.id)) continue;
      seenCompletedJobIds.add(job.id);

      const jobLabels = {
        repo: repoFullName,
        workflow: run.name || String(run.workflow_id),
        job: job.name,
        conclusion: job.conclusion || "unknown",
        ...(config.includeRunNumberLabel && run.run_number !== undefined
          ? { run_number: String(run.run_number) }
          : {}),
      };
      jobRunsTotal.inc(jobLabels);
      trackedMetrics.jobRunsTotal.touch(jobLabels);

      if (job.started_at && job.completed_at) {
        const seconds = (new Date(job.completed_at) - new Date(job.started_at)) / 1000;
        if (seconds >= 0 && jobRunDurationSeconds) {
          jobRunDurationSeconds.observe(jobLabels, seconds);
          trackedMetrics.jobRunDurationSeconds.touch(jobLabels);
        }
      }

      for (const step of job.steps || []) {
        if (step.status !== "completed") continue;

        const stepLabels = {
          ...jobLabels,
          step: step.name,
          step_number: String(step.number),
          conclusion: step.conclusion || "unknown",
          ...(config.includeRunNumberLabel && run.run_number !== undefined
            ? { run_number: String(run.run_number) }
            : {}),
        };
        stepRunsTotal.inc(stepLabels);
        trackedMetrics.stepRunsTotal.touch(stepLabels);

        if (step.started_at && step.completed_at) {
          const seconds = (new Date(step.completed_at) - new Date(step.started_at)) / 1000;
          if (seconds >= 0 && stepRunDurationSeconds) {
            stepRunDurationSeconds.observe(stepLabels, seconds);
            trackedMetrics.stepRunDurationSeconds.touch(stepLabels);
          }
        }
      }
    }
  } catch (err) {
    scrapeErrorsTotal.inc({ stage: "list_jobs" });
    log.warn(`Failed to list jobs for ${repoFullName}#${run.id}: ${err.message}`);
  }
}

async function pollRunnerStatus(octokit, owner, repo) {
  try {
    const runners = await listSelfHostedRunners(octokit, owner, repo);
    for (const runner of runners) {
      const labels = {
        repo: `${owner}/${repo}`,
        name: runner.name,
        os: runner.os,
        busy: String(runner.busy),
      };
      runnerStatus.set(labels, runner.status === "online" ? 1 : 0);
      trackedMetrics.runnerStatus.touch(labels);
    }
  } catch (err) {
    scrapeErrorsTotal.inc({ stage: "list_runners" });
    log.warn(`Failed to list runners for ${owner}/${repo}: ${err.message}`);
  }
}

async function pollRepo(octokit, repo) {
  try {
    const runs = await listRecentWorkflowRuns(octokit, repo.owner.login, repo.name);
    for (const run of runs) {
      await pollRun(octokit, repo.full_name, run);
    }
  } catch (err) {
    scrapeErrorsTotal.inc({ stage: "list_runs" });
    log.warn(`Failed to list workflow runs for ${repo.full_name}: ${err.message}`);
    return;
  }

  if (config.collectRunnerStatus) {
    await pollRunnerStatus(octokit, repo.owner.login, repo.name);
  }
}

async function recordRateLimit(octokit, installationId) {
  try {
    const { data } = await octokit.rest.rateLimit.get();
    for (const [resource, info] of Object.entries(data.resources)) {
      if (typeof info?.remaining === "number") {
        rateLimitRemaining.set(
          { installation_id: String(installationId), resource },
          info.remaining
        );
      }
    }
  } catch (err) {
    // Non-fatal: some GitHub Enterprise Server versions don't expose this endpoint.
    log.debug(`Failed to read rate limit: ${err.message}`);
  }
}

export async function pollOnce() {
  const startedAt = Date.now();
  workflowRunsInProgress.reset();

  for await (const { installationId, octokit, account } of eachInstallationOctokit()) {
    log.debug(`Polling installation ${installationId} (${account?.login ?? "unknown"})`);

    let repos = [];
    try {
      repos = await listActiveRepos(octokit);
    } catch (err) {
      scrapeErrorsTotal.inc({ stage: "list_repos" });
      log.warn(`Failed to list repos for installation ${installationId}: ${err.message}`);
      continue;
    }

    log.info(`Installation ${installationId}: polling ${repos.length} active repo(s)`);

    for (const repo of repos) {
      await pollRepo(octokit, repo);
    }

    await recordRateLimit(octokit, installationId);
  }

  pruneIfNeeded(seenCompletedRunIds);
  pruneIfNeeded(seenQueueTimeRunIds);
  pruneIfNeeded(seenCompletedJobIds);

  const prunedSeries = pruneStaleMetrics(config.metricTtlDays);
  if (prunedSeries > 0) {
    log.info(`Pruned ${prunedSeries} stale metric series (TTL ${config.metricTtlDays}d)`);
  }

  scrapeDurationSeconds.set((Date.now() - startedAt) / 1000);
}

export function startPolling() {
  const intervalMs = config.pollIntervalSeconds * 1000;

  const run = () => {
    pollOnce().catch((err) => {
      scrapeErrorsTotal.inc({ stage: "poll_cycle" });
      log.error(`Poll cycle failed: ${err.stack || err.message}`);
    });
  };

  run(); // kick off immediately instead of waiting a full interval on startup
  return setInterval(run, intervalMs);
}
