import { Injectable } from '@nestjs/common';
import { Command, CommandRunner, Option } from 'nest-commander';
import { ExternalAgentRecoveryService } from '../runs/external-agent-recovery.service';

interface PrepareExternalAgentOutputOptions { readonly reason?: string; }

@Injectable()
@Command({
  name: 'prepare-external-agent-output',
  arguments: '<run-id> <step-id>',
  description: 'Prepare a failed patch step for a host-authored, runner-applied patch recovery.',
})
export class PrepareExternalAgentOutputCommand extends CommandRunner {
  constructor(
    private readonly recovery: ExternalAgentRecoveryService,
  ) { super(); }

  async run([runId, stepId]: string[], options: PrepareExternalAgentOutputOptions): Promise<void> {
    if (!options.reason?.trim()) throw new Error('prepare-external-agent-output requires --reason');
    process.stdout.write(`${JSON.stringify(this.recovery.prepare(runId, stepId, options.reason))}\n`);
  }

  @Option({ flags: '--reason <text>', description: 'Required reason for taking over a failed agent patch step.' })
  parseReason(value: string): string { return value; }
}
