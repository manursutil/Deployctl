import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { LogEntry, LogQuery, LogService } from "../core/logs.js";
import { DeployctlError } from "../shared.js";

const DEFAULT_ROOT_DIR = ".deployctl-sim";

/**
 * Filesystem-backed `LogQuery` for the Sim Phase 4 simulation lane
 * (docs/phase-0-simulation-plan.md, section D). Reads newline-delimited JSON log
 * entries from `<rootDir>/logs/<env>/<tenant>/<service>.log` and returns those at or
 * after the `since` cutoff. Env/tenant/service selection is the file path (mirroring a
 * CloudWatch log group/stream); time filtering mirrors the CloudWatch `startTime`.
 */
export class FileSystemLogQuery implements LogQuery {
  private readonly logsDir: string;

  constructor(rootDir: string = DEFAULT_ROOT_DIR) {
    this.logsDir = join(rootDir, "logs");
  }

  async query(filter: { env: string; tenant: string; service: LogService; since: Date }): Promise<LogEntry[]> {
    const path = join(this.logsDir, filter.env, filter.tenant, `${filter.service}.log`);

    let source: string;
    try {
      source = await readFile(path, "utf8");
    } catch (error) {
      if (isNotFound(error)) {
        return [];
      }
      throw error;
    }

    const sinceMs = filter.since.getTime();

    return source
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => parseLogLine(line, path))
      .filter((entry) => Date.parse(entry.timestamp) >= sinceMs);
  }
}

function parseLogLine(line: string, path: string): LogEntry {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new DeployctlError(`Malformed log line in ${path}: ${line}`);
  }

  if (typeof parsed !== "object" || parsed === null) {
    throw new DeployctlError(`Malformed log line in ${path}: ${line}`);
  }

  const entry = parsed as Record<string, unknown>;
  for (const field of ["timestamp", "env", "tenant", "service", "message"] as const) {
    if (typeof entry[field] !== "string") {
      throw new DeployctlError(`Log line missing "${field}" in ${path}: ${line}`);
    }
  }

  return parsed as LogEntry;
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}
