import { Injectable } from '@nestjs/common';
import { Command, CommandRunner, Option } from 'nest-commander';
import { GateService } from '../workflows/gate.service';

interface AcknowledgeOptions { readonly comment?: string; }

@Injectable()
@Command({
  name: 'acknowledge',
  arguments: '<run-id> <step-id>',
  description: 'Record an audited human acknowledgment for a halted verdict so the run can continue.',
})
export class AcknowledgeCommand extends CommandRunner {
  constructor(private readonly gates: GateService) { super(); }

  async run([runId, stepId]: string[], options: AcknowledgeOptions): Promise<void> {
    if (!options.comment?.trim()) {
      throw new Error('acknowledge requires --comment');
    }
    this.gates.acknowledge(runId, stepId, options.comment);
  }

  @Option({ flags: '--comment <text>', description: 'Required justification preserved on the step and in the event log.' })
  parseComment(value: string): string { return value; }
}
