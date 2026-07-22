import { Injectable } from '@nestjs/common';
import { Command, CommandRunner } from 'nest-commander';
import { HostHandoffSubmissionService } from '../runs/host-handoff-submission.service';

@Injectable()
@Command({
  name: 'submit-host-output',
  arguments: '<run-id> <step-id> <markdown-file>',
  description: 'Publish and record Markdown returned by a paused read-only host handoff.',
})
export class SubmitHostOutputCommand extends CommandRunner {
  constructor(private readonly submission: HostHandoffSubmissionService) { super(); }

  async run([runId, stepId, markdownFile]: string[]): Promise<void> {
    this.submission.submit(runId, stepId, markdownFile);
  }
}
