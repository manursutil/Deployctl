import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { DeployctlError } from "../shared.js";
import type { RefKind, RefResolver, ResolvedGitRef } from "../core/refs.js";

const execFileAsync = promisify(execFile);
const fullCommitShaPattern = /^[0-9a-f]{40}$/i;

/**
 * Internal seam over the `git` CLI: given argument vector, resolve to stdout.
 * The default runs the real binary; adapter tests inject a fake so they never
 * touch the network or local Git state. Not part of the `RefResolver` interface.
 */
export type GitCommandRunner = (args: string[]) => Promise<string>;

const defaultRunGit: GitCommandRunner = async (args) => {
  const { stdout } = await execFileAsync("git", args, { encoding: "utf8" });
  return stdout;
};

export class GitCliRefResolver implements RefResolver {
  constructor(private readonly runGit: GitCommandRunner = defaultRunGit) {}

  async resolve(input: { repositoryUrl: string; ref: string }): Promise<ResolvedGitRef> {
    if (fullCommitShaPattern.test(input.ref)) {
      return this.resolveFullSha(input.repositoryUrl, input.ref);
    }

    const refs = await this.lsRemote(input.repositoryUrl, [input.ref, `refs/heads/${input.ref}`, `refs/tags/${input.ref}`, `refs/tags/${input.ref}^{}`]);
    const match = selectRef(input.ref, refs);

    if (match === undefined) {
      throw new DeployctlError(`Could not resolve git ref ${input.ref} in ${input.repositoryUrl}`);
    }

    return match;
  }

  /**
   * A full SHA is only accepted if the configured repository advertises it. This
   * proves the commit exists in the right repository before any deploy work, rather
   * than letting a typo or foreign SHA fail later and less clearly. Note that
   * `git ls-remote` only sees advertised refs, so a valid commit not reachable from
   * any branch/tag is rejected.
   */
  private async resolveFullSha(repositoryUrl: string, ref: string): Promise<ResolvedGitRef> {
    const commitSha = ref.toLowerCase();
    const refs = await this.lsRemote(repositoryUrl, []);

    if (!refs.some((candidate) => candidate.commitSha === commitSha)) {
      throw new DeployctlError(`Could not resolve git ref ${ref} in ${repositoryUrl}`);
    }

    return { kind: "commit", commitSha };
  }

  private async lsRemote(repositoryUrl: string, refFilters: string[]): Promise<ResolvedGitRef[]> {
    let stdout: string;

    try {
      stdout = await this.runGit(["ls-remote", repositoryUrl, ...refFilters]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new DeployctlError(`Could not query git refs from ${repositoryUrl}: ${message}`);
    }

    return stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map(parseLsRemoteLine);
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
