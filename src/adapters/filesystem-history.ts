import { access, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type CurrentState,
  type DeployHistoryEvent,
  type DeployHistoryRepository,
  type DeployTarget,
  type InProgressState,
  validateCurrentState,
  validateHistoryEvent,
} from "../core/history.js";
import { DeployctlError } from "../shared.js";

const DEFAULT_ROOT_DIR = ".deployctl-sim";

/**
 * Filesystem-backed `DeployHistoryRepository` for the Sim Phase 1 simulation lane
 * (docs/phase-0-simulation-plan.md). Mirrors the S3 layout under
 * `<rootDir>/history/deploys/<env>/<tenant>/<app>/{events/<event-id>.json,current.json}`
 * so the on-disk shape matches the real contract this adapter stands in for.
 */
export class FileSystemDeployHistoryRepository implements DeployHistoryRepository {
  constructor(private readonly rootDir: string = DEFAULT_ROOT_DIR) {}

  async appendEvent(event: DeployHistoryEvent): Promise<void> {
    const validated = validateHistoryEvent(event);
    const eventsDir = this.eventsDir(validated);
    const eventPath = join(eventsDir, `${validated.eventId}.json`);

    await mkdir(eventsDir, { recursive: true });

    if (await pathExists(eventPath)) {
      throw new DeployctlError(`History event already exists for ${targetKey(validated)}: ${validated.eventId}`);
    }

    await writeJsonFile(eventPath, validated);
  }

  async listEvents(target: DeployTarget): Promise<DeployHistoryEvent[]> {
    const eventsDir = this.eventsDir(target);
    let fileNames: string[];

    try {
      fileNames = await readdir(eventsDir);
    } catch (error) {
      if (isNotFound(error)) {
        return [];
      }
      throw error;
    }

    return Promise.all(
      fileNames
        .filter((name) => name.endsWith(".json"))
        .sort()
        .map(async (name) => validateHistoryEvent(await readJsonFile(join(eventsDir, name)))),
    );
  }

  async tryStartDeployment(target: DeployTarget, inProgress: InProgressState): Promise<CurrentState> {
    const current = await this.readCurrentState(target);

    if (current?.inProgress !== undefined) {
      throw new DeployctlError(
        `deploy already in progress for ${target.env}/${target.tenant}/${target.app}: ${current.inProgress.eventId} since ${current.inProgress.since}`,
      );
    }

    const next = validateCurrentState({
      ...(current ?? initialCurrentState(target, inProgress.since)),
      inProgress,
    });

    await this.writeCurrentState(next);
    return next;
  }

  async readCurrentState(target: DeployTarget): Promise<CurrentState | undefined> {
    try {
      return validateCurrentState(await readJsonFile(this.currentStatePath(target)));
    } catch (error) {
      if (isNotFound(error)) {
        return undefined;
      }
      throw error;
    }
  }

  async updateCurrentState(state: CurrentState): Promise<void> {
    await this.writeCurrentState(validateCurrentState(state));
  }

  private async writeCurrentState(state: CurrentState): Promise<void> {
    await mkdir(this.targetDir(state), { recursive: true });
    await writeJsonFile(this.currentStatePath(state), state);
  }

  private targetDir(target: DeployTarget): string {
    return join(this.rootDir, "history", "deploys", target.env, target.tenant, target.app);
  }

  private eventsDir(target: DeployTarget): string {
    return join(this.targetDir(target), "events");
  }

  private currentStatePath(target: DeployTarget): string {
    return join(this.targetDir(target), "current.json");
  }
}

function initialCurrentState(target: DeployTarget, timestamp: string): CurrentState {
  return {
    ...target,
    currentVersion: null,
    lastSuccessfulEventId: null,
    updatedAt: timestamp,
  };
}

function targetKey(target: DeployTarget): string {
  return `${target.env}/${target.tenant}/${target.app}`;
}

async function readJsonFile(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8"));
}

async function writeJsonFile(path: string, value: unknown): Promise<void> {
  const tmpPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmpPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(tmpPath, path);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (isNotFound(error)) {
      return false;
    }
    throw error;
  }
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}
