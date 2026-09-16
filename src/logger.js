import { config } from "./config.js";

const LEVELS = ["error", "warn", "info", "debug"];
const currentLevel = LEVELS.includes(config.logLevel) ? config.logLevel : "info";
const currentLevelIndex = LEVELS.indexOf(currentLevel);

function line(level, message) {
  const idx = LEVELS.indexOf(level);
  if (idx > currentLevelIndex) return;
  const ts = new Date().toISOString();
  const fn = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
  fn(`${ts} level=${level} msg="${message}"`);
}

export const log = {
  error: (msg) => line("error", msg),
  warn: (msg) => line("warn", msg),
  info: (msg) => line("info", msg),
  debug: (msg) => line("debug", msg),
};
