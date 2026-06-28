import { DeployctlError } from "../shared.js";
import type { CurrentState, DeployHistoryRepository, DeployTarget, InProgressState } from "./history.js";

export async function startDeploymentGuardrail(
  repository: DeployHistoryRepository,
  target: DeployTarget,
  inProgress: InProgressState,
): Promise<void> {
  const current = await repository.readCurrentState(target);

  if (current?.inProgress !== undefined) {
    throw new DeployctlError(
      `deploy already in progress for ${target.env}/${target.tenant}/${target.app}: ${current.inProgress.eventId} since ${current.inProgress.since}`,
    );
  }

  await repository.updateCurrentState({
    ...(current ?? initialCurrentState(target, inProgress.since)),
    inProgress,
  });
}

export async function clearDeploymentGuardrail(repository: DeployHistoryRepository, target: DeployTarget, eventId: string): Promise<void> {
  const current = await repository.readCurrentState(target);

  if (current?.inProgress === undefined || current.inProgress.eventId !== eventId) {
    return;
  }

  const next: CurrentState = { ...current };
  delete next.inProgress;
  await repository.updateCurrentState(next);
}

function initialCurrentState(target: DeployTarget, timestamp: string): CurrentState {
  return {
    ...target,
    currentVersion: null,
    lastSuccessfulEventId: null,
    updatedAt: timestamp,
  };
}
