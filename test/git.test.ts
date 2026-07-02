import assert from "node:assert/strict";
import { test } from "node:test";
import { GitCliRefResolver } from "../src/adapters/git.js";
import { DeployctlError } from "../src/shared.js";

const fullSha = "0123456789abcdef0123456789abcdef01234567";
const repositoryUrl = "ssh://git@example.com/app.git";

test("rejects a full commit SHA the repository does not advertise", async () => {
  const resolver = new GitCliRefResolver(async () => `ffffffffffffffffffffffffffffffffffffffff\trefs/heads/main\n`);

  await assert.rejects(
    () => resolver.resolve({ repositoryUrl, ref: fullSha }),
    (error) => error instanceof DeployctlError && /could not resolve git ref/i.test(error.message),
  );
});

test("resolves a full commit SHA the repository advertises, lowercasing the result", async () => {
  const resolver = new GitCliRefResolver(async () => `${fullSha}\trefs/heads/main\n`);

  const resolved = await resolver.resolve({ repositoryUrl, ref: fullSha.toUpperCase() });

  assert.deepEqual(resolved, { kind: "commit", commitSha: fullSha });
});

test("prefers a tag over a branch when a ref resolves to both", async () => {
  const branchSha = "1111111111111111111111111111111111111111";
  const tagSha = "2222222222222222222222222222222222222222";
  const resolver = new GitCliRefResolver(async () => `${branchSha}\trefs/heads/release\n${tagSha}\trefs/tags/release\n`);

  const resolved = await resolver.resolve({ repositoryUrl, ref: "release" });

  assert.deepEqual(resolved, { kind: "tag", commitSha: tagSha });
});

test("rejects malformed ls-remote output", async () => {
  const resolver = new GitCliRefResolver(async () => `not-a-sha\trefs/heads/main\n`);

  await assert.rejects(
    () => resolver.resolve({ repositoryUrl, ref: "main" }),
    (error) => error instanceof DeployctlError && /unexpected git ls-remote output/i.test(error.message),
  );
});

test("queries a branch/tag ref with the repository URL and heads/tags filters", async () => {
  let received: string[] = [];
  const resolver = new GitCliRefResolver(async (args) => {
    received = args;
    return `1111111111111111111111111111111111111111\trefs/heads/main\n`;
  });

  await resolver.resolve({ repositoryUrl, ref: "main" });

  assert.deepEqual(received, ["ls-remote", repositoryUrl, "main", "refs/heads/main", "refs/tags/main", "refs/tags/main^{}"]);
});

test("returns a branch when only a branch ref is advertised", async () => {
  const branchSha = "3333333333333333333333333333333333333333";
  const resolver = new GitCliRefResolver(async () => `${branchSha}\trefs/heads/feature\n`);

  const resolved = await resolver.resolve({ repositoryUrl, ref: "feature" });

  assert.deepEqual(resolved, { kind: "branch", commitSha: branchSha });
});

test("rejects a ref the repository does not advertise", async () => {
  const resolver = new GitCliRefResolver(async () => "");

  await assert.rejects(
    () => resolver.resolve({ repositoryUrl, ref: "missing" }),
    (error) => error instanceof DeployctlError && /could not resolve git ref missing/i.test(error.message),
  );
});

test("wraps a git command failure as a DeployctlError naming the repository", async () => {
  const resolver = new GitCliRefResolver(async () => {
    throw new Error("boom");
  });

  await assert.rejects(
    () => resolver.resolve({ repositoryUrl, ref: "main" }),
    (error) =>
      error instanceof DeployctlError && error.message.includes("Could not query git refs from") && error.message.includes(repositoryUrl),
  );
});
