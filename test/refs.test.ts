import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveDeploymentRef, type RefResolver } from "../src/core/refs.js";
import { DeployctlError } from "../src/shared.js";

const fullSha = "0123456789abcdef0123456789abcdef01234567";

test("resolveDeploymentRef allows moving branch refs when the environment policy allows them", async () => {
  const resolver = fakeResolver({ kind: "branch", commitSha: fullSha });

  const result = await resolveDeploymentRef({
    environment: "staging",
    requestedRef: "feature/foo",
    applicationRepositoryUrl: "ssh://git@example.com/app.git",
    refPolicies: {
      staging: { allowMovingBranches: true },
    },
    resolver,
  });

  assert.deepEqual(result, {
    requestedRef: "feature/foo",
    resolvedCommit: fullSha,
    refKind: "branch",
  });
});

test("resolveDeploymentRef rejects moving branch refs when the environment policy forbids them", async () => {
  const resolver = fakeResolver({ kind: "branch", commitSha: fullSha });

  await assert.rejects(
    () =>
      resolveDeploymentRef({
        environment: "production",
        requestedRef: "main",
        applicationRepositoryUrl: "ssh://git@example.com/app.git",
        refPolicies: {
          production: { allowMovingBranches: false },
        },
        resolver,
      }),
    (error) => error instanceof DeployctlError && /production does not allow moving branch refs/.test(error.message),
  );
});

test("resolveDeploymentRef allows immutable refs when branch refs are forbidden", async () => {
  const resolver = fakeResolver({ kind: "tag", commitSha: fullSha });

  const result = await resolveDeploymentRef({
    environment: "production",
    requestedRef: "v1.2.3",
    applicationRepositoryUrl: "ssh://git@example.com/app.git",
    refPolicies: {
      production: { allowMovingBranches: false },
    },
    resolver,
  });

  assert.equal(result.resolvedCommit, fullSha);
  assert.equal(result.refKind, "tag");
});

test("resolveDeploymentRef requires a full immutable commit SHA from the resolver", async () => {
  const resolver = fakeResolver({ kind: "commit", commitSha: "abc123" });

  await assert.rejects(
    () =>
      resolveDeploymentRef({
        environment: "staging",
        requestedRef: "abc123",
        applicationRepositoryUrl: "ssh://git@example.com/app.git",
        refPolicies: {
          staging: { allowMovingBranches: true },
        },
        resolver,
      }),
    (error) => error instanceof DeployctlError && /resolved to an invalid commit SHA/.test(error.message),
  );
});

function fakeResolver(resolved: Awaited<ReturnType<RefResolver["resolve"]>>): RefResolver {
  return {
    async resolve() {
      return resolved;
    },
  };
}
