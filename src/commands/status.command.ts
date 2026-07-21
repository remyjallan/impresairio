import { Inject, Injectable } from '@nestjs/common';
import { Command, CommandRunner } from 'nest-commander';
import { FileStateStore } from '../runs/file-state.store';
import { cycleReviewWarnings } from '../workflows/review-cycle-completion.policy';

export const STATUS_WRITER = Symbol('STATUS_WRITER');

export class RunNotFoundError extends Error {
  constructor(runId: string) {
    super(`Run not found: ${runId}`);
    this.name = 'RunNotFoundError';
  }
}

@Injectable()
@Command({
  name: 'status',
  arguments: '<run-id>',
  description: 'Show the status of an Impresairio run.',
})
export class StatusCommand extends CommandRunner {
  constructor(
    @Inject(FileStateStore)
    private readonly stateStore: FileStateStore,
    @Inject(STATUS_WRITER)
    private readonly write: (line: string) => void = (line) => process.stdout.write(line),
  ) {
    super();
  }

  async run([runId]: string[]): Promise<void> {
    const run = this.stateStore.findState(runId);

    if (!run) {
      throw new RunNotFoundError(runId);
    }

    this.write([
      `run: ${run.id}`,
      `workflow: ${run.workflow.id}`,
      `current-step: ${run.currentStepId ?? 'not-started'}`,
      `steps: ${run.steps.length}`,
      ...run.steps.map((step) => `${step.id}: ${step.status}`),
      ...cycleReviewWarnings(run).map((warning) => `warning: ${warning}`),
      '',
    ].join('\n'));
  }
}
