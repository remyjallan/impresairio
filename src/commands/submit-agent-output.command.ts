import { Injectable } from '@nestjs/common';
import { Command, CommandRunner } from 'nest-commander';
import { AgentRecoverySubmissionService } from '../runs/agent-recovery-submission.service';

@Injectable()
@Command({
  name: 'submit-agent-output',
  arguments: '<run-id> <step-id> <markdown-file>',
  description: 'Validate, apply, and record a host-authored patch for a prepared failed agent step.',
})
export class SubmitAgentOutputCommand extends CommandRunner {
  constructor(private readonly submission: AgentRecoverySubmissionService) { super(); }

  async run([runId, stepId, markdownFile]: string[]): Promise<void> {
    this.submission.submit(runId, stepId, markdownFile);
  }
}
