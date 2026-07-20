import { Inject, Injectable } from '@nestjs/common';
import { Command, CommandRunner } from 'nest-commander';
import { RunLookupService } from '../runs/run-lookup.service';

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
    @Inject(RunLookupService)
    private readonly runLookupService: RunLookupService,
  ) {
    super();
  }

  async run([runId]: string[]): Promise<void> {
    const run = this.runLookupService.findById(runId);

    if (!run) {
      throw new RunNotFoundError(runId);
    }

    process.stdout.write(`${run.id}\n`);
  }
}
