import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { DeployctlError } from "../shared.js";
import type { RefKind, RefResolver, ResolvedGitRef } from "../core/refs.js";

const execFileAsync = promisify(execFile);
const fullCommitShaPattern = /^[0-9a-f]{40}$/i;

export class GitCliRefResolver implements RefResolver {
  async resolve(input: { repositoryUrl: string; ref: string }): Promise<ResolvedGitRef> {
    if (fullCommitShaPattern.test(input.ref)) {
      return { kind: "commit", commitSha: input.ref.toLowerCase() };
    }

    const refs = await lsRemote(input.repositoryUrl, input.ref);
    const match = selectRef(input.ref, refs);

    if (match === undefined) {
      throw new DeployctlError(`Could not resolve git ref ${input.ref} in ${input.repositoryUrl}`);
    }

    return match;
  }
}

async function lsRemote(repositoryUrl: string, ref: string): Promise<ResolvedGitRef[]> {
  try {
    const { stdout } = await execFileAsync("git", ["ls-remote", repositoryUrl, ref, `refs/heads/${ref}`, `refs/tags/${ref}`, `refs/tags/${ref}^{}`], {
      encoding: "utf8",
    });

    return stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map(parseLsRemoteLine);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new DeployctlError(`Could not query git refs from ${repositoryUrl}: ${message}`);
  }
}

function parseLsRemoteLine(line: string): ResolvedGitRef {
  const [commitSha, refName] = line.split(/\s+/, 2);

  if (commitSha === undefined || refName === undefined || !fullCommitShaPattern.test(commitSha)) {
    throw new DeployctlError(`Unexpected git ls-remote output: ${line}`);
  }

  return {
    kind: refKind(refName),
    commitSha: commitSha.toLowerCase(),
  };
}

function refKind(refName: string): RefKind {
  if (refName.startsWith("refs/heads/")) {
    return "branch";
  }

  if (refName.startsWith("refs/tags/")) {
    return "tag";
  }

  return "commit";
}

function selectRef(ref: string, refs: ResolvedGitRef[]): ResolvedGitRef | undefined {
  const tag = refs.find((candidate) => candidate.kind === "tag");
  if (tag !== undefined) {
    return tag;
  }

  const branch = refs.find((candidate) => candidate.kind === "branch");
  if (branch !== undefined) {
    return branch;
  }

  return refs.find((candidate) => candidate.commitSha.startsWith(ref));
}
