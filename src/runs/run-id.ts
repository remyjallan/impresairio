const validRunId = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export class RunIdError extends Error {
  constructor(runId: string) {
    super(`Invalid run ID: ${runId}`);
    this.name = 'RunIdError';
  }
}

export function assertValidRunId(runId: string): void {
  if (!validRunId.test(runId)) {
    throw new RunIdError(runId);
  }
}
