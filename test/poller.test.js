import assert from "node:assert/strict";
import { describe, it } from "node:test";

async function loadConfig(env = {}) {
  const saved = { ...process.env };
  try {
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }

    const { config } = await import(`../src/config.js?ts=${Date.now()}-${Math.random()}`);
    return config;
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in saved)) delete process.env[key];
    }
    for (const [key, value] of Object.entries(saved)) {
      process.env[key] = value;
    }
  }
}

describe("config", () => {
  it("enables histograms by default and keeps the default bucket widths for opt-out use", async () => {
    const config = await loadConfig();
    assert.equal(config.collectHistograms, true);
    assert.deepEqual(config.histogramBuckets, [60, 300, 900]);
  });

  it("allows histogram metrics to be disabled explicitly", async () => {
    const config = await loadConfig({ COLLECT_HISTOGRAMS: "false" });
    assert.equal(config.collectHistograms, false);
    assert.deepEqual(config.histogramBuckets, [60, 300, 900]);
  });

  it("allows workflow/job/step metrics to include a run_number label", async () => {
    const config = await loadConfig({ INCLUDE_RUN_NUMBER_LABEL: "true" });
    assert.equal(config.includeRunNumberLabel, true);
  });
});
