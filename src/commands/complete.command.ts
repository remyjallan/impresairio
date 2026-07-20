import { Injectable } from '@nestjs/common';
import { Command, CommandRunner } from 'nest-commander';
import { CompletionService } from '../runs/completion.service';

@Injectable()
@Command({
  name: 'complete',
  arguments: '<run-id> <step-id>',
  description: 'Record the verified output for the current agent step.',
})
export class CompleteCommand extends CommandRunner {
  constructor(private readonly completionService: CompletionService) {
    super();
  }

  async run([runId, stepId]: string[]): Promise<void> {
    this.completionService.complete(runId, stepId);
  }
}
