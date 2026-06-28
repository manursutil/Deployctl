import { DeployctlError } from "../shared.js";

export type RefKind = "branch" | "tag" | "commit";

export type ResolvedGitRef = {
  kind: RefKind;
  commitSha: string;
};

export type RefResolver = {
  resolve(input: { repositoryUrl: string; ref: string }): Promise<ResolvedGitRef>;
};

export type ResolvedDeploymentRef = {
  requestedRef: string;
  resolvedCommit: string;
  refKind: RefKind;
};

export type ResolveDeploymentRefInput = {
  environment: string;
  requestedRef: string;
  applicationRepositoryUrl: string;
  refPolicies: Record<string, { allowMovingBranches: boolean }>;
  resolver: RefResolver;
};

const fullCommitShaPattern = /^[0-9a-f]{40}$/i;

export async function resolveDeploymentRef(input: ResolveDeploymentRefInput): Promise<ResolvedDeploymentRef> {
  const policy = input.refPolicies[input.environment];

  if (policy === undefined) {
    throw new DeployctlError(`Ref policy not found for environment: ${input.environment}`);
  }

  const resolved = await input.resolver.resolve({
    repositoryUrl: input.applicationRepositoryUrl,
    ref: input.requestedRef,
  });

  if (!fullCommitShaPattern.test(resolved.commitSha)) {
    throw new DeployctlError(`${input.requestedRef} resolved to an invalid commit SHA: ${resolved.commitSha}`);
  }

  if (resolved.kind === "branch" && !policy.allowMovingBranches) {
    throw new DeployctlError(`${input.environment} does not allow moving branch refs: ${input.requestedRef}`);
  }

  return {
    requestedRef: input.requestedRef,
    resolvedCommit: resolved.commitSha.toLowerCase(),
    refKind: resolved.kind,
  };
}
