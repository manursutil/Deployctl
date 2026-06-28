export class DeployctlError extends Error {
  constructor(message: string, readonly exitCode = 1) {
    super(message);
    this.name = "DeployctlError";
  }
}

export type Io = {
  stdout: Pick<NodeJS.WriteStream, "write">;
  stderr: Pick<NodeJS.WriteStream, "write">;
};

export function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
