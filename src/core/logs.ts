import { DeployctlError } from "../shared.js";

/** Application log services deployctl can query, matching a tenant's api/worker processes. */
export type LogService = "api" | "worker";

/** One application log line. Mirrors the JSON shape the real CloudWatch adapter will return. */
export type LogEntry = {
  timestamp: string;
  env: string;
  tenant: string;
  service: LogService;
  message: string;
};

/**
 * Seam over the log source. The real adapter queries CloudWatch Logs (server-side
 * filtered by log group/stream and start time); the simulation reads local files.
 * The `since` cutoff is an absolute time so the seam mirrors CloudWatch's `startTime`.
 */
export type LogQuery = {
  query(filter: { env: string; tenant: string; service: LogService; since: Date }): Promise<LogEntry[]>;
};

const durationPattern = /^(\d+)([smhd])$/;
const unitMs: Record<string, number> = {
  s: 1000,
  m: 60 * 1000,
  h: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
};

/** Parse a `--since` duration like `1h`, `30m`, `2d`, `45s` into an absolute cutoff before `now`. */
export function parseSinceDuration(input: string, now: Date): Date {
  const match = durationPattern.exec(input);

  if (match === null) {
    throw new DeployctlError(`Invalid --since duration: ${input} (expected e.g. 30s, 15m, 1h, 2d)`);
  }

  const amount = Number(match[1]);
  const cutoff = now.getTime() - amount * unitMs[match[2]];
  return new Date(cutoff);
}

/** Validate a `--service` value into a known log service. */
export function parseLogService(value: string): LogService {
  if (value !== "api" && value !== "worker") {
    throw new DeployctlError(`--service must be "api" or "worker": ${value}`);
  }

  return value;
}

/**
 * Query one tenant/service's application logs within a time window. Pure orchestration
 * over the `LogQuery` seam: parse the `--since` duration into an absolute cutoff, query,
 * and return entries oldest-first. The CLI and the future dashboard share it; tests pass
 * a fake seam.
 */
export async function getTenantLogs(
  logs: LogQuery,
  input: { env: string; tenant: string; service: LogService; since: string; now?: Date },
): Promise<LogEntry[]> {
  const now = input.now ?? new Date();
  const since = parseSinceDuration(input.since, now);

  const entries = await logs.query({ env: input.env, tenant: input.tenant, service: input.service, since });

  return [...entries].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
}

/** Human-readable one-line-per-entry rendering for the CLI. */
export function formatLogEntries(entries: LogEntry[]): string {
  if (entries.length === 0) {
    return "no matching log entries\n";
  }

  return entries.map((entry) => `${entry.timestamp} [${entry.env}/${entry.tenant}/${entry.service}] ${entry.message}`).join("\n") + "\n";
}
