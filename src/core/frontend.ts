import { createHash } from "node:crypto";
import { DeployctlError, formatError } from "../shared.js";
import type { DeployctlConfig } from "./config.js";
import {
  applySuccessfulEventToCurrentState,
  type DeployEvent,
  type DeployEventStatus,
  type DeployHistoryRepository,
  type DeployTarget,
} from "./history.js";
import { clearDeploymentGuardrail, startDeploymentGuardrail } from "./guardrail.js";
import { resolveDeploymentRef, type RefResolver } from "./refs.js";
import { getTenantConfig, type TenantRegistry } from "./tenants.js";

/**
 * Identity of a built frontend artifact. In v1, tenant/environment variables are
 * baked into the static bundle at build time, so an artifact is identified by the
 * resolved commit AND a fingerprint over the exact build variable values — never
 * the commit alone. This prevents one tenant's build from being reused for another.
 */
export type FrontendArtifactKey = {
  env: string;
  tenant: string;
  resolvedCommit: string;
  fingerprint: string;
};

export function frontendArtifactKey(input: {
  env: string;
  tenant: string;
  resolvedCommit: string;
  buildVariables: Record<string, string>;
}): FrontendArtifactKey {
  const canonical = Object.keys(input.buildVariables)
    .sort()
    .map((name) => `${name}=${input.buildVariables[name]}`)
    .join("\n");

  const fingerprint = createHash("sha256")
    .update(`${input.resolvedCommit}\n${input.env}\n${input.tenant}\n${canonical}`)
    .digest("hex")
    .slice(0, 16);

  return { env: input.env, tenant: input.tenant, resolvedCommit: input.resolvedCommit, fingerprint };
}

export function frontendArtifactStorageKey(prefix: string, key: FrontendArtifactKey): string {
  return `${prefix}/${key.resolvedCommit}/${key.env}/${key.tenant}-${key.fingerprint}.tar.gz`;
}

export type FrontendArtifact = { storageKey: string; byteSize: number };

export type FrontendBuildRequest = {
  key: FrontendArtifactKey;
  buildVariables: Record<string, string>;
  build: DeployctlConfig["build"]["frontend"];
  applicationRepositoryUrl: string;
};

/** Seam over the artifact store (S3). Tests pass an in-memory fake. */
export type FrontendArtifactStore = {
  exists(storageKey: string): Promise<boolean>;
  put(storageKey: string, artifact: FrontendArtifact): Promise<void>;
};

/** Seam over the build step. The real builder runs the configured build command. */
export type FrontendBuilder = {
  build(request: FrontendBuildRequest): Promise<FrontendArtifact>;
};

/** Seam over S3 sync to the tenant frontend bucket (with cache headers in the adapter). */
export type FrontendSync = {
  sync(request: { bucket: string; storageKey: string }): Promise<void>;
};

/** Seam over the post-deploy smoke check of the tenant frontend URL. */
export type FrontendSmokeCheck = {
  check(url: string): Promise<boolean>;
};

export type DeployFrontendInput = {
  env: string;
  tenant: string;
  requestedRef: string;
  actor: string;
  buildVariables: Record<string, string>;
  config: DeployctlConfig;
  registry: TenantRegistry;
  refResolver: RefResolver;
  history: DeployHistoryRepository;
  artifacts: FrontendArtifactStore;
  builder: FrontendBuilder;
  sync: FrontendSync;
  smokeCheck: FrontendSmokeCheck;
  clock?: () => Date;
  generateEventId?: (startedAt: Date) => string;
};

export type DeployFrontendResult = {
  status: DeployEventStatus;
  reused: boolean;
  event: DeployEvent;
};

/**
 * Orchestrate one frontend deploy for `<env>/<tenant>/frontend`: resolve the ref,
 * compute the build-variable-aware artifact identity, reuse or build the artifact,
 * sync it to the tenant bucket, smoke check, and record history. The guardrail is
 * always cleared, so a failed smoke check or build leaves no in-progress state.
 */
export async function deployFrontend(input: DeployFrontendInput): Promise<DeployFrontendResult> {
  const clock = input.clock ?? (() => new Date());
  const target: DeployTarget = { env: input.env, tenant: input.tenant, app: "frontend" };

  const tenant = getTenantConfig(input.registry, input.env, input.tenant);

  const resolved = await resolveDeploymentRef({
    environment: input.env,
    requestedRef: input.requestedRef,
    applicationRepositoryUrl: input.config.applicationRepository.url,
    refPolicies: input.config.refPolicies,
    resolver: input.refResolver,
  });

  const key = frontendArtifactKey({
    env: input.env,
    tenant: input.tenant,
    resolvedCommit: resolved.resolvedCommit,
    buildVariables: input.buildVariables,
  });
  const storageKey = frontendArtifactStorageKey(input.config.frontendArtifacts.prefix, key);

  const startedAt = clock();
  const eventId = (input.generateEventId ?? defaultEventId)(startedAt);

  await startDeploymentGuardrail(input.history, target, { eventId, since: startedAt.toISOString(), actor: input.actor });

  let reused = false;

  try {
    try {
      reused = await input.artifacts.exists(storageKey);

      if (!reused) {
        const artifact = await input.builder.build({
          key,
          buildVariables: input.buildVariables,
          build: input.config.build.frontend,
          applicationRepositoryUrl: input.config.applicationRepository.url,
        });
        await input.artifacts.put(storageKey, artifact);
      }

      await input.sync.sync({ bucket: tenant.frontendBucket, storageKey });
    } catch (error) {
      const event = buildEvent(target, resolved.requestedRef, resolved.resolvedCommit, input.actor, eventId, startedAt, clock(), "failure", formatError(error));
      await input.history.appendEvent(event);
      throw error instanceof DeployctlError
        ? error
        : new DeployctlError(`Frontend deploy failed for ${target.env}/${target.tenant}: ${formatError(error)}`);
    }

    const healthy = await input.smokeCheck.check(tenant.frontendUrl);
    const status: DeployEventStatus = healthy ? "success" : "failure";
    const event = buildEvent(
      target,
      resolved.requestedRef,
      resolved.resolvedCommit,
      input.actor,
      eventId,
      startedAt,
      clock(),
      status,
      healthy ? undefined : `frontend smoke check failed: ${tenant.frontendUrl}`,
    );

    await input.history.appendEvent(event);

    if (status === "success") {
      await input.history.updateCurrentState(applySuccessfulEventToCurrentState(event));
    }

    return { status, reused, event };
  } finally {
    await clearDeploymentGuardrail(input.history, target, eventId);
  }
}

function buildEvent(
  target: DeployTarget,
  requestedRef: string,
  resolvedCommit: string,
  actor: string,
  eventId: string,
  startedAt: Date,
  finishedAt: Date,
  status: DeployEventStatus,
  errorMessage?: string,
): DeployEvent {
  const event: DeployEvent = {
    ...target,
    eventId,
    type: "deploy",
    requestedRef,
    resolvedCommit,
    status,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    actor,
  };

  if (errorMessage !== undefined) {
    event.errorMessage = errorMessage;
  }

  return event;
}

function defaultEventId(startedAt: Date): string {
  const iso = startedAt.toISOString();
  return `dep_${iso.slice(0, 10).replace(/-/g, "")}_${iso.slice(11, 19).replace(/:/g, "")}`;
}
