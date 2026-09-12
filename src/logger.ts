/**
 * Minimal stderr logger. We never write to stdout: stdout is reserved so this
 * process stays quiet and composable, and all diagnostics go to stderr.
 */

type Level = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<Level, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

let threshold = LEVEL_ORDER.info;

export function setLogLevel(level: Level): void {
  threshold = LEVEL_ORDER[level];
}

function emit(level: Level, msg: string, fields?: Record<string, unknown>): void {
  if (LEVEL_ORDER[level] < threshold) return;
  const ts = new Date().toISOString();
  let line = `${ts} ${level.toUpperCase().padEnd(5)} ${msg}`;
  if (fields && Object.keys(fields).length > 0) {
    const parts = Object.entries(fields).map(([k, v]) => `${k}=${format(v)}`);
    line += " " + parts.join(" ");
  }
  process.stderr.write(line + "\n");
}

function format(v: unknown): string {
  if (v instanceof Error) return JSON.stringify(v.message);
  if (typeof v === "string") return /\s/.test(v) ? JSON.stringify(v) : v;
  return JSON.stringify(v);
}

export const log = {
  debug: (msg: string, fields?: Record<string, unknown>) => emit("debug", msg, fields),
  info: (msg: string, fields?: Record<string, unknown>) => emit("info", msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => emit("warn", msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => emit("error", msg, fields),
};
