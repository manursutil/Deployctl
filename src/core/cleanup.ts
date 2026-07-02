import type { DeployctlConfig } from "./config.js";
import {
  eventVersion,
  type CurrentState,
  type DeployHistoryEvent,
  type DeployHistoryRepository,
  type DeployTarget,
} from "./history.js";

export type RetentionPolicy = DeployctlConfig["retention"];

/**
 * One prunable deployment resource for a target: a backend release (keyed by commit)
 * or a frontend artifact (keyed by its S3 storage key). `lastSuccessfulAt` is the most
 * recent successful deploy of this version to the target.
 */
export type RetentionCandidate = {
  version: string;
  lastSuccessfulAt: string;
  isCurrent: boolean;
};

export type RetentionDecision = RetentionCandidate & {
  keep: boolean;
  reasons: string[];
};

export type RetentionPlan = {
  keep: RetentionDecision[];
  delete: RetentionDecision[];
};

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Decide which deployment versions to keep or delete under the retention policy.
 * A version is kept if it is current, among the newest `successfulVersionsPerTarget`
 * by last successful deploy, or deployed within `keepDays`. Everything else is deletable.
 * Pure — no repository or AWS knowledge — so it is fully unit-testable.
 */
export function planRetention(candidates: RetentionCandidate[], policy: RetentionPolicy, now: Date = new Date()): RetentionPlan {
  const cutoff = now.getTime() - policy.keepDays * MS_PER_DAY;
  const sorted = [...candidates].sort((a, b) => Date.parse(b.lastSuccessfulAt) - Date.parse(a.lastSuccessfulAt));

  const decisions = sorted.map((candidate, index): RetentionDecision => {
    const reasons: string[] = [];

    if (candidate.isCurrent) {
      reasons.push("current");
    }
    if (index < policy.successfulVersionsPerTarget) {
      reasons.push(`within last ${policy.successfulVersionsPerTarget} successful versions`);
    }
    if (Date.parse(candidate.lastSuccessfulAt) >= cutoff) {
      reasons.push(`deployed within ${policy.keepDays} days`);
    }

    return { ...candidate, keep: reasons.length > 0, reasons };
  });

  return {
    keep: decisions.filter((decision) => decision.keep),
    delete: decisions.filter((decision) => !decision.keep),
  };
}

/**
 * Derive retention candidates for one target from its deploy history. Backend releases
 * are keyed by commit; frontend artifacts by their recorded S3 storage key (falling back
 * to the commit for events recorded before artifact keys were stored). The current
 * version is protected via `current`.
 */
export function deploymentRetentionCandidates(
  target: DeployTarget,
  events: DeployHistoryEvent[],
  current: CurrentState | undefined,
): RetentionCandidate[] {
  const identityOf = (event: DeployHistoryEvent): string =>
    target.app === "frontend" ? event.artifactStorageKey ?? eventVersion(event) : eventVersion(event);

  const currentIdentity = currentVersionIdentity(target, events, current);

  const latestByVersion = new Map<string, string>();
  for (const event of events) {
    if (event.status !== "success") {
      continue;
    }

    const version = identityOf(event);
    const existing = latestByVersion.get(version);
    if (existing === undefined || Date.parse(event.finishedAt) > Date.parse(existing)) {
      latestByVersion.set(version, event.finishedAt);
    }
  }

  return [...latestByVersion].map(([version, lastSuccessfulAt]) => ({
    version,
    lastSuccessfulAt,
    isCurrent: version === currentIdentity,
  }));
}

/**
 * Plan retention for one `<env>/<tenant>/<app>` by reading its history and current state
 * through the repository seam, then applying the policy. Produces the plan only — the
 * dry-run view; deleting the resources is a separate adapter concern.
 */
export async function planTargetRetention(
  repository: DeployHistoryRepository,
  target: DeployTarget,
  policy: RetentionPolicy,
  now: Date = new Date(),
): Promise<RetentionPlan> {
  const [events, current] = await Promise.all([repository.listEvents(target), repository.readCurrentState(target)]);
  return planRetention(deploymentRetentionCandidates(target, events, current), policy, now);
}

function currentVersionIdentity(
  target: DeployTarget,
  events: DeployHistoryEvent[],
  current: CurrentState | undefined,
): string | null {
  if (current?.currentVersion === null || current === undefined) {
    return null;
  }

  if (target.app !== "frontend") {
    return current.currentVersion;
  }

  const currentEvent = events.find((event) => event.eventId === current.lastSuccessfulEventId);
  return currentEvent?.artifactStorageKey ?? current.currentVersion;
}
