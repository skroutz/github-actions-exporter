import express from "express";
import { config, validateConfig } from "./config.js";
import { log } from "./logger.js";
import { registry } from "./metrics.js";
import { startPolling } from "./poller.js";

validateConfig();

const app = express();

app.get("/healthz", (_req, res) => res.status(200).send("ok"));

app.get(config.metricsPath, async (_req, res) => {
  try {
    res.set("Content-Type", registry.contentType);
    res.end(await registry.metrics());
  } catch (err) {
    log.error(`Failed to render metrics: ${err.message}`);
    res.status(500).end(err.message);
  }
});

app.listen(config.port, () => {
  log.info(`github-actions-exporter listening on :${config.port}${config.metricsPath}`);
  log.info(
    `Polling every ${config.pollIntervalSeconds}s, runner status metrics: ${config.collectRunnerStatus}`
  );
  startPolling();
});
