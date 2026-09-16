import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { pollJobsForRun } from "../src/poller.js";
import { registry } from "../src/metrics.js";

function metricValue(metrics, name, labels, metricName) {
  const metric = metrics.find((item) => item.name === name);
  assert.ok(metric, `metric ${name} was not found`);

  const value = metric.values.find((item) =>
    (!metricName || item.metricName === metricName) &&
    Object.entries(labels).every(([label, expected]) => item.labels[label] === expected)
  );
  assert.ok(value, `labels for ${name} were not found`);
  return value.value;
}

describe("pollJobsForRun", () => {
  it("records failed jobs, failed steps, skipped steps, and durations once", async () => {
    const jobs = [
      {
        id: "job-1",
        name: "test (node 22)",
        status: "completed",
        conclusion: "failure",
        started_at: "2026-09-16T05:00:00Z",
        completed_at: "2026-09-16T05:01:00Z",
        steps: [
          {
            number: 1,
            name: "Run tests",
            status: "completed",
            conclusion: "failure",
            started_at: "2026-09-16T05:00:10Z",
            completed_at: "2026-09-16T05:00:40Z",
          },
          {
            number: 2,
            name: "Upload artifacts",
            status: "completed",
            conclusion: "skipped",
            started_at: null,
            completed_at: null,
          },
        ],
      },
    ];
    const octokit = {
      rest: { actions: { listJobsForWorkflowRun: {} } },
      paginate: async () => jobs,
    };
    const run = { id: 42, name: "CI", workflow_id: 7 };

    await pollJobsForRun(octokit, "acme/widgets", run);
    await pollJobsForRun(octokit, "acme/widgets", run);

    const metrics = await registry.getMetricsAsJSON();
    const commonLabels = {
      repo: "acme/widgets",
      workflow: "CI",
      job: "test (node 22)",
    };

    assert.equal(
      metricValue(metrics, "github_actions_job_runs_total", {
        ...commonLabels,
        conclusion: "failure",
      }),
      1
    );
    assert.equal(
      metricValue(metrics, "github_actions_step_runs_total", {
        ...commonLabels,
        step: "Run tests",
        step_number: "1",
        conclusion: "failure",
      }),
      1
    );
    assert.equal(
      metricValue(metrics, "github_actions_step_runs_total", {
        ...commonLabels,
        step: "Upload artifacts",
        step_number: "2",
        conclusion: "skipped",
      }),
      1
    );
    assert.equal(
      metricValue(
        metrics,
        "github_actions_step_run_duration_seconds",
        {
          ...commonLabels,
          step: "Run tests",
          step_number: "1",
          conclusion: "failure",
        },
        "github_actions_step_run_duration_seconds_sum"
      ),
      30
    );
  });
});
