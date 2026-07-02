import { DeployctlError, formatError } from "../shared.js";
import type { DeployctlConfig } from "./config.js";
import type { SsmDeployExecutor } from "./deploy.js";
import type { FrontendSmokeCheck, FrontendSync } from "./frontend.js";
import {
  eventVersion,
  formatRollbackEventId,
  newRollbackEvent,
  type DeployHistoryEvent,
  type DeployHistoryRepository,
  type DeployInstanceResult,
  type DeployTarget,
  type RollbackEvent,
  type RollbackEventStatus,
} from "./history.js";
import { runDeployLifecycle } from "./lifecycle.js";
import { getTenantConfig, type TenantRegistry } from "./tenants.js";

const fullCommitShaPattern = /^[0-9a-f]{40}$/i;

/**
 * The successful version a rollback will restore, plus the version it rolls away
 * from. Both are immutable commit SHAs drawn from recorded history, so a rollback
 * never resolves a git ref.
 */
export type RollbackSelection = {
  targetVersion: string;
  targetEvent: DeployHistoryEvent;
  previousVersion: string;
};

/**
 * Choose which recorded version a rollback should restore for `<env>/<tenant>/<app>`.
 * With `toVersion` it restores that exact previously-successful version; without it
 * it restores the version immediately before the current one. Throws when there is
 * nothing deployed to roll back, or no matching earlier successful version.
 */
export async function selectRollbackTarget(
  repository: DeployHistoryRepository,
  target: DeployTarget,
  toVersion?: string,
): Promise<RollbackSelection> {
  const current = await repository.readCurrentState(target);

  if (current === undefined || current.currentVersion === null) {
    throw new DeployctlError(`No current version to roll back for ${targetLabel(target)}`);
  }

  const previousVersion = current.currentVersion;
  const events = await repository.listEvents(target);
  const successful = events.filter((event) => event.status === "success");

  if (toVersion !== undefined) {
    const requested = normalizeVersion(toVersion);

    if (requested === previousVersion) {
      throw new DeployctlError(`${targetLabel(target)} is already at version ${requested}`);
    }

    const targetEvent = [...successful].reverse().find((event) => eventVersion(event) === requested);

    if (targetEvent === undefined) {
      throw new DeployctlError(`No successful deploy of ${requested} to roll back to for ${targetLabel(target)}`);
    }

    return { targetVersion: requested, targetEvent, previousVersion };
  }

  const targetEvent = [...successful].reverse().find((event) => event.eventId !== current.lastSuccessfulEventId);

  if (targetEvent === undefined) {
    throw new DeployctlError(`No previous successful version to roll back to for ${targetLabel(target)}`);
  }

  return { targetVersion: eventVersion(targetEvent), targetEvent, previousVersion };
}

export type RollbackBackendInput = {
  env: string;
  tenant: string;
  actor: string;
  toVersion?: string;
  config: DeployctlConfig;
  registry: TenantRegistry;
  history: DeployHistoryRepository;
  executor: SsmDeployExecutor;
  clock?: () => Date;
  generateEventId?: (startedAt: Date) => string;
};

export type RollbackResult = {
  status: RollbackEventStatus;
  event: RollbackEvent;
};

/**
 * Orchestrate one backend rollback for `<env>/<tenant>/backend`: select the target
 * version from history, take the `inProgress` guardrail, redeploy that commit through
 * the SSM executor seam, then record an append-only rollback event and update current
 * state. Deploy and rollback issue the same SSM call — the server script prepares the
 * release from a commit either way; only the recorded event type differs. The
 * guardrail is always cleared, so a failure leaves no in-progress state behind.
 */
export async function rollbackBackend(input: RollbackBackendInput): Promise<RollbackResult> {
  const clock = input.clock ?? (() => new Date());
  const target: DeployTarget = { env: input.env, tenant: input.tenant, app: "backend" };

  const tenant = getTenantConfig(input.registry, input.env, input.tenant);
  const ssmTarget = input.config.ssmTargets[input.env];

  if (ssmTarget === undefined) {
    throw new DeployctlError(`No SSM target selector configured for environment: ${input.env}`);
  }

  const selection = await selectRollbackTarget(input.history, target, input.toVersion);

  let recordedEvent: RollbackEvent | undefined;

  const lifecycle = await runDeployLifecycle({
    target,
    actor: input.actor,
    history: input.history,
    clock,
    generateEventId: input.generateEventId ?? formatRollbackEventId,
    work: async () => {
      const outcome = await input.executor.runBackendDeploy({
        target,
        resolvedCommit: selection.targetVersion,
        tenant,
        ssmTarget,
        build: input.config.build.backend,
        applicationRepositoryUrl: input.config.applicationRepository.url,
      });
      return { outcome, status: overallStatus(outcome.instances) };
    },
    record: {
      updateCurrentStateOnSuccess: true,
      success: ({ outcome, status }, context) => {
        recordedEvent = newRollbackEvent({
          target,
          eventId: context.eventId,
          targetVersion: selection.targetVersion,
          previousVersion: selection.previousVersion,
          actor: input.actor,
          status,
          startedAt: context.startedAt,
          finishedAt: context.finishedAt,
          ssmCommandId: outcome.ssmCommandId,
          instances: outcome.instances,
        });
        return recordedEvent;
      },
      failure: (error, context) =>
        rollbackFailureEvent({
          target,
          eventId: context.eventId,
          selection,
          actor: input.actor,
          startedAt: context.startedAt,
          finishedAt: context.finishedAt,
          errorMessage: formatError(error),
        }),
    },
    errorMessage: (error) => `Backend rollback failed for ${targetLabel(target)}: ${formatError(error)}`,
  });

  if (recordedEvent === undefined) {
    throw new DeployctlError(`Backend rollback failed for ${targetLabel(target)}: missing history event`);
  }

  return { status: lifecycle.result.status, event: recordedEvent };
}

export type RollbackFrontendInput = {
  env: string;
  tenant: string;
  actor: string;
  toVersion?: string;
  registry: TenantRegistry;
  history: DeployHistoryRepository;
  sync: FrontendSync;
  smokeCheck: FrontendSmokeCheck;
  clock?: () => Date;
  generateEventId?: (startedAt: Date) => string;
};

/**
 * Orchestrate one frontend rollback for `<env>/<tenant>/frontend`: select the target
 * version from history and redeploy its exact recorded artifact (no rebuild) by
 * re-syncing that artifact's S3 key to the tenant bucket, then smoke check and record
 * an append-only rollback event. The artifact key comes from the target version's
 * successful event, so identity-sensitive builds cannot be confused. The guardrail is
 * always cleared, so a failed sync or smoke check leaves no in-progress state.
 */
export async function rollbackFrontend(input: RollbackFrontendInput): Promise<RollbackResult> {
  const clock = input.clock ?? (() => new Date());
  const target: DeployTarget = { env: input.env, tenant: input.tenant, app: "frontend" };

  const tenant = getTenantConfig(input.registry, input.env, input.tenant);
  const selection = await selectRollbackTarget(input.history, target, input.toVersion);
  const artifactStorageKey = selection.targetEvent.artifactStorageKey;

  if (artifactStorageKey === undefined) {
    throw new DeployctlError(`No recorded frontend artifact for version ${selection.targetVersion} of ${targetLabel(target)}`);
  }

  let recordedEvent: RollbackEvent | undefined;
  let failureMessage = (error: unknown) => `Frontend rollback failed for ${targetLabel(target)}: ${formatError(error)}`;

  const lifecycle = await runDeployLifecycle({
    target,
    actor: input.actor,
    history: input.history,
    clock,
    generateEventId: input.generateEventId ?? formatRollbackEventId,
    work: async () => {
      await input.sync.sync({ bucket: tenant.frontendBucket, storageKey: artifactStorageKey });

      failureMessage = (error: unknown) =>
        `Frontend rollback smoke check failed for ${targetLabel(target)}: ${formatError(error)}`;
      const healthy = await input.smokeCheck.check(tenant.frontendUrl);

      return {
        status: healthy ? ("success" as const) : ("failure" as const),
        errorMessage: healthy ? undefined : `frontend smoke check failed: ${tenant.frontendUrl}`,
      };
    },
    record: {
      updateCurrentStateOnSuccess: true,
      success: (result, context) => {
        recordedEvent = newRollbackEvent({
          target,
          eventId: context.eventId,
          targetVersion: selection.targetVersion,
          previousVersion: selection.previousVersion,
          actor: input.actor,
          status: result.status,
          startedAt: context.startedAt,
          finishedAt: context.finishedAt,
          errorMessage: result.errorMessage,
          artifactStorageKey,
        });
        return recordedEvent;
      },
      failure: (error, context) =>
        rollbackFailureEvent({
          target,
          eventId: context.eventId,
          selection,
          actor: input.actor,
          startedAt: context.startedAt,
          finishedAt: context.finishedAt,
          errorMessage: formatError(error),
          artifactStorageKey,
        }),
    },
    errorMessage: failureMessage,
  });

  if (recordedEvent === undefined) {
    throw new DeployctlError(`Frontend rollback failed for ${targetLabel(target)}: missing history event`);
  }

  return { status: lifecycle.result.status, event: recordedEvent };
}

function rollbackFailureEvent(input: {
  target: DeployTarget;
  eventId: string;
  selection: RollbackSelection;
  actor: string;
  startedAt: Date;
  finishedAt: Date;
  errorMessage: string;
  artifactStorageKey?: string;
}): RollbackEvent {
  return newRollbackEvent({
    target: input.target,
    eventId: input.eventId,
    targetVersion: input.selection.targetVersion,
    previousVersion: input.selection.previousVersion,
    actor: input.actor,
    status: "failure",
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    errorMessage: input.errorMessage,
    artifactStorageKey: input.artifactStorageKey,
  });
}

function overallStatus(instances: DeployInstanceResult[]): RollbackEventStatus {
  if (instances.length === 0 || instances.every((instance) => instance.status === "failure")) {
    return "failure";
  }

  if (instances.every((instance) => instance.status === "success")) {
    return "success";
  }

  return "partial_failure";
}

function normalizeVersion(version: string): string {
  if (!fullCommitShaPattern.test(version)) {
    throw new DeployctlError(`Rollback target version must be a full commit SHA: ${version}`);
  }

  return version.toLowerCase();
}

function targetLabel(target: DeployTarget): string {
  return `${target.env}/${target.tenant}/${target.app}`;
}
