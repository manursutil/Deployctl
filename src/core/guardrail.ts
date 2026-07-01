import type { CurrentState, DeployHistoryRepository, DeployTarget, InProgressState } from "./history.js";

export async function startDeploymentGuardrail(
  repository: DeployHistoryRepository,
  target: DeployTarget,
  inProgress: InProgressState,
): Promise<void> {
  await repository.tryStartDeployment(target, inProgress);
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
