import type {
  DeployableApp,
  DeployHistoryRepository,
  InProgressState,
} from "./history.js";

/** Deployable apps reported by default, in display order. */
export const STATUS_APPS: readonly DeployableApp[] = ["backend", "frontend"];

/** Current deployment state for one `<env>/<tenant>/<app>`. */
export type AppStatus = {
  app: DeployableApp;
  /** Whether a current-state record exists yet (false before the first deploy or guardrail write). */
  exists: boolean;
  currentVersion: string | null;
  lastSuccessfulEventId: string | null;
  updatedAt: string | null;
  inProgress?: InProgressState;
};

export type TenantStatus = {
  env: string;
  tenant: string;
  apps: AppStatus[];
};

/**
 * Read current deployment state for one tenant across its apps through the history
 * repository seam. Pure query — no AWS knowledge beyond the repository, so the CLI
 * and the future dashboard share it and tests use an in-memory repository.
 */
export async function getTenantStatus(
  repository: DeployHistoryRepository,
  input: { env: string; tenant: string; apps?: readonly DeployableApp[] },
): Promise<TenantStatus> {
  const apps = input.apps ?? STATUS_APPS;
  const statuses = await Promise.all(
    apps.map(async (app): Promise<AppStatus> => {
      const state = await repository.readCurrentState({ env: input.env, tenant: input.tenant, app });

      if (state === undefined) {
        return { app, exists: false, currentVersion: null, lastSuccessfulEventId: null, updatedAt: null };
      }

      const status: AppStatus = {
        app,
        exists: true,
        currentVersion: state.currentVersion,
        lastSuccessfulEventId: state.lastSuccessfulEventId,
        updatedAt: state.updatedAt,
      };

      if (state.inProgress !== undefined) {
        status.inProgress = state.inProgress;
      }

      return status;
    }),
  );

  return { env: input.env, tenant: input.tenant, apps: statuses };
}

/** Human-readable one-line-per-app rendering of a tenant status, one target per line. */
export function formatTenantStatus(status: TenantStatus): string {
  return status.apps.map((app) => formatAppStatus(status, app)).join("\n") + "\n";
}

function formatAppStatus(status: TenantStatus, app: AppStatus): string {
  const target = `${status.env}/${status.tenant}/${app.app}`;

  if (!app.exists || app.currentVersion === null) {
    return `${target}: not deployed${app.inProgress ? ` ${inProgressSuffix(app.inProgress)}` : ""}`;
  }

  const details = [`updated ${app.updatedAt}`];
  if (app.lastSuccessfulEventId !== null) {
    details.push(`last successful ${app.lastSuccessfulEventId}`);
  }

  const line = `${target}: ${app.currentVersion} (${details.join(", ")})`;
  return app.inProgress ? `${line} ${inProgressSuffix(app.inProgress)}` : line;
}

function inProgressSuffix(inProgress: InProgressState): string {
  return `[deploy in progress: ${inProgress.eventId} since ${inProgress.since}]`;
}
