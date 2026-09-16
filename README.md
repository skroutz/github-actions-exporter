# github-actions-exporter

A small, self-maintained Prometheus exporter for GitHub Actions workflow/job
metrics, purpose-built for a self-hosted-runner setup (e.g. Actions Runner
Controller on EKS). Written in Node.js, authenticated as a **GitHub App**
(org-wide installation discovery, no PAT rotation, ~15k req/hr rate limit),
and **poll-only** — no public webhook endpoint required.

This replaces evaluating third-party exporters (Labbs/github-actions-exporter
is unmaintained since 2024; cpanato/github_actions_exporter requires an
inbound webhook and doesn't do org-wide repo discovery on its own) with a
small codebase you fully control.

## How it works

Every `POLL_INTERVAL_SECONDS` (default 60s), the exporter:

1. Authenticates as your GitHub App and enumerates every installation
   (or just one, if `GITHUB_APP_INSTALLATION_ID` is set).
2. Lists every repo the installation can see, filtered to ones pushed to in
   the last `ACTIVE_SINCE_DAYS` (default 14) to save API quota on dormant repos.
3. Fetches the last `RUNS_PER_REPO` (default 30) workflow runs per repo, and
   for newly-completed runs, their jobs.
4. Updates Prometheus counters/histograms — see [Metrics](#metrics) below.

Completed runs/jobs are counted **exactly once** via an in-memory dedup set
(keyed by run/job id), so re-polling the same runs on the next cycle doesn't
inflate counters. This state resets on pod restart, so keep `replicas: 1`
(see note in `k8s/deployment.yaml`) — running multiple replicas would
double-count.

## Metric lifecycle / cleanup

Prometheus client libraries never expire a label combination on their own —
once a series like `repo="foo",job="test (ubuntu, 3.11)"` is created it stays
in memory for the life of the process. That's a slow cardinality leak for
long-lived pods: renamed/archived repos, retired workflow names, and
matrix-job combinations that stop being used all leave permanent stale
series otherwise.

To handle this, every `repo`/`workflow`/`job`/`step`/`runner` label combination
is tracked with a last-seen timestamp. Once per poll cycle, any combination
not observed again within `METRIC_TTL_DAYS` (default 30) is removed from the
registry via `pruneStaleMetrics()` — check the exporter logs for `Pruned N
stale metric series` to see it working. `github_actions_workflow_runs_in_progress`
is exempt from this since it's a plain snapshot gauge that's fully reset and
repopulated every poll cycle already.

## Metrics

| Metric | Type | Labels | Notes |
|---|---|---|---|
| `github_actions_workflow_runs_total` | Counter | repo, workflow, event, conclusion | Incremented once per completed run |
| `github_actions_workflow_run_duration_seconds` | Histogram | repo, workflow, event, conclusion | run_started_at → updated_at |
| `github_actions_workflow_queue_duration_seconds` | Histogram | repo, workflow, event | created_at → run_started_at (ARC pickup latency) |
| `github_actions_workflow_runs_in_progress` | Gauge | repo, workflow, event, status | Snapshot at each poll |
| `github_actions_job_runs_total` | Counter | repo, workflow, job, conclusion | |
| `github_actions_job_run_duration_seconds` | Histogram | repo, workflow, job, conclusion | |
| `github_actions_step_runs_total` | Counter | repo, workflow, job, step, step_number, conclusion | Incremented once per completed step; includes skipped steps |
| `github_actions_step_run_duration_seconds` | Histogram | repo, workflow, job, step, step_number, conclusion | Duration of completed steps with timestamps |
| `github_actions_runner_status` | Gauge | repo, name, os, busy | **Opt-in** via `COLLECT_RUNNER_STATUS=true` — high cardinality with ARC ephemeral runners |
| `github_actions_exporter_scrape_duration_seconds` | Gauge | | Full poll cycle wall time |
| `github_actions_exporter_scrape_errors_total` | Counter | stage | |
| `github_actions_exporter_rate_limit_remaining` | Gauge | installation_id, resource | Watch this to tune `POLL_INTERVAL_SECONDS`/`RUNS_PER_REPO` |

Deliberately **not** included: a gauge labeled by `run_id`. GitHub Actions
run IDs are unbounded and ever-increasing — labeling a gauge with them is the
classic cardinality trap that kills Prometheus/Thanos over time.

## Setup

### 1. Create the GitHub App

GitHub org → **Settings → Developer settings → GitHub Apps → New GitHub App**.

- Webhook: **uncheck "Active"** — this exporter doesn't use webhooks.
- Permissions:
  - Repository → **Actions**: Read-only
  - Repository → **Metadata**: Read-only
  - Repository → **Administration**: Read-only (only if you plan to enable `COLLECT_RUNNER_STATUS`)
- After creating it, generate a **private key** (downloads a `.pem`).
- **Install the App** on your org, selecting "All repositories" (or the
  specific repos you want) — this is what drives auto-discovery.
- Note the **App ID** (App settings page) and, if you want to pin to one
  installation, the **Installation ID** (visible in the install URL).

### 2. Local run

```bash
cp .env.example .env
# edit .env: set GITHUB_APP_ID, point GITHUB_APP_PRIVATE_KEY_PATH at your .pem
npm install
npm start
curl localhost:9101/metrics
```

### 3. Build & push the image

```bash
docker build -t <your-registry>/github-actions-exporter:latest .
docker push <your-registry>/github-actions-exporter:latest
```

### 4. Deploy to EKS

```bash
kubectl apply -f k8s/namespace.yaml

# Create the real secret (do not commit it) — see k8s/secret.example.yaml
kubectl create secret generic github-actions-exporter \
  --namespace github-actions-exporter \
  --from-literal=github-app-id=<APP_ID> \
  --from-file=private-key.pem=./your-app-private-key.pem

# Set the image in k8s/deployment.yaml, then:
kubectl apply -f k8s/deployment.yaml
kubectl apply -f k8s/service.yaml
kubectl apply -f k8s/servicemonitor.yaml   # if using kube-prometheus-stack
```

### Helm installation

The Helm chart is under `helm/github-actions-exporter`. It uses an existing
Kubernetes Secret by default, so create the GitHub App Secret first:

```bash
kubectl create namespace github-actions-exporter
kubectl create secret generic github-actions-exporter \
  --namespace github-actions-exporter \
  --from-literal=github-app-id=<APP_ID> \
  --from-file=private-key.pem=./your-app-private-key.pem
```

Install or upgrade the exporter:

```bash
helm upgrade --install github-actions-exporter \
  ./helm/github-actions-exporter \
  --namespace github-actions-exporter \
  --set image.repository=<your-registry>/github-actions-exporter \
  --set image.tag=<tag> \
  --set serviceMonitor.enabled=true
```

Set `serviceMonitor.enabled=false` when using plain Prometheus instead of the
Prometheus Operator. The chart keeps one replica by default because the
exporter's run deduplication state is in memory. For development only, the
Secret can be chart-managed with `secret.create=true`, `secret.appId`, and
`secret.privateKey`; prefer External Secrets Operator or a pre-created Secret
for production.

The repository includes separate GitHub Actions workflows for publishing the
Docker image and Helm chart. Pushing a tag such as `v0.1.0` publishes:

```text
ghcr.io/<owner>/<repo>:v0.1.0
oci://ghcr.io/<owner>/charts/github-actions-exporter:0.1.0
```

The Docker image is built for `linux/amd64` and `linux/arm64`. The chart version
comes from `helm/github-actions-exporter/Chart.yaml`, so bump that version when
publishing a new chart release.

Prefer syncing the secret from AWS Secrets Manager via
[External Secrets Operator](https://external-secrets.io/) instead of
`kubectl create secret` by hand, to avoid the private key ever touching a
shell history or CI log.

### 5. Verify

```bash
kubectl -n github-actions-exporter port-forward svc/github-actions-exporter 9101:9101
curl localhost:9101/metrics | grep github_actions_workflow_runs_total
```

## Tuning / operational notes

- **Rate limits**: watch `github_actions_exporter_rate_limit_remaining`. A
  GitHub App installation gets ~15,000 req/hr for an org. Each poll cycle
  costs roughly `1 (list repos) + N repos (list runs) + M completed runs
  (list jobs)` requests — increase `POLL_INTERVAL_SECONDS` or lower
  `RUNS_PER_REPO`/`ACTIVE_SINCE_DAYS` if you're burning through quota.
- **Runner status cardinality**: with ARC, ephemeral runners get a new name
  per job. Leave `COLLECT_RUNNER_STATUS=false` unless you specifically need
  it, and if you do, consider that ARC itself already exposes
  runner/queue-depth metrics natively (`gha-runner-scale-set-controller`
  `--set controller.metrics.enabled=true`) — that's usually a better source
  for "how many runners are online/busy" than polling the Actions API.
- **`METRIC_TTL_DAYS`**: lower it if you rename/archive repos frequently or
  have volatile matrix-job names and want stale series gone faster; raise it
  if you have long gaps between workflow runs (e.g. monthly release
  pipelines) and don't want those series pruned between runs.
- **Single replica only**: the in-memory dedup set isn't shared across pods.
  If you need HA, the fix is to move dedup state to Redis/DynamoDB rather
  than running >1 replica — not implemented here to keep this simple.
- **GHES support**: set `GITHUB_API_URL` to your GitHub Enterprise Server API
  base URL if applicable.
