import { access, copyFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { FrontendArtifact, FrontendArtifactStore, FrontendSync } from "../core/frontend.js";

const DEFAULT_ROOT_DIR = ".deployctl-sim";

/**
 * Filesystem-backed FrontendArtifactStore for the Sim Phase 3 simulation lane
 * (docs/phase-0-simulation-plan.md, section B). Stores artifacts under
 * `<rootDir>/artifacts/<storageKey>`, where storageKey already comes from
 * frontendArtifactStorageKey() (commit + env + tenant + build-config fingerprint),
 * so "store by resolved commit plus fingerprint" falls out of the existing key shape.
 */
export class FileSystemFrontendArtifactStore implements FrontendArtifactStore {
  private readonly artifactsDir: string;

  constructor(rootDir: string = DEFAULT_ROOT_DIR) {
    this.artifactsDir = join(rootDir, "artifacts");
  }

  async exists(storageKey: string): Promise<boolean> {
    return pathExists(join(this.artifactsDir, storageKey));
  }

  async put(storageKey: string, artifact: FrontendArtifact): Promise<void> {
    const destination = join(this.artifactsDir, storageKey);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(artifact.storageKey, destination);
  }
}

/**
 * Filesystem-backed FrontendSync for the Sim Phase 3 simulation lane. Copies the
 * stored artifact into `<rootDir>/frontend-buckets/<bucket>/index.html`. Deviates
 * from the plan's suggested `frontend-buckets/<env>/<tenant>` path: the FrontendSync
 * seam only receives the tenant's bucket name, not env/tenant separately, so this
 * uses `tenant.frontendBucket` as the directory name to avoid changing the seam.
 */
export class FileSystemFrontendSync implements FrontendSync {
  private readonly artifactsDir: string;
  private readonly bucketsDir: string;

  constructor(rootDir: string = DEFAULT_ROOT_DIR) {
    this.artifactsDir = join(rootDir, "artifacts");
    this.bucketsDir = join(rootDir, "frontend-buckets");
  }

  async sync(request: { bucket: string; storageKey: string }): Promise<void> {
    const source = join(this.artifactsDir, request.storageKey);
    const destinationDir = join(this.bucketsDir, request.bucket);

    await mkdir(destinationDir, { recursive: true });
    await copyFile(source, join(destinationDir, "index.html"));
  }
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
