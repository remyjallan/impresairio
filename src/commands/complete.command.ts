import { Inject, Injectable } from '@nestjs/common';
import { Command, CommandRunner } from 'nest-commander';
import { CompletionService } from '../runs/completion.service';

export const COMPLETE_WRITER = Symbol('COMPLETE_WRITER');

@Injectable()
@Command({
  name: 'complete',
  arguments: '<run-id> <step-id>',
  description: 'Record the verified output for the current agent step.',
})
export class CompleteCommand extends CommandRunner {
  constructor(
    private readonly completionService: CompletionService,
    @Inject(COMPLETE_WRITER) private readonly write: (line: string) => void = (line) => process.stdout.write(line),
  ) {
    super();
  }

  async run([runId, stepId]: string[]): Promise<void> {
    this.completionService.complete(runId, stepId);
    this.write(`completed: ${runId} ${stepId}\n`);
  }
}
