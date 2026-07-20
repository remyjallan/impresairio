import { Injectable } from '@nestjs/common';
import { Command, CommandRunner, Option } from 'nest-commander';
import { GateService } from '../workflows/gate.service';

interface ApprovalOptions { readonly comment?: string; }

@Injectable()
@Command({
  name: 'approve',
  arguments: '<run-id> <gate-id>',
  description: 'Approve a waiting human gate after verifying its artifact.',
})
export class ApproveCommand extends CommandRunner {
  constructor(private readonly gates: GateService) { super(); }

  async run([runId, gateId]: string[], options: ApprovalOptions): Promise<void> {
    this.gates.approve(runId, gateId, options.comment);
  }

  @Option({ flags: '--comment <text>', description: 'Optional approval comment.' })
  parseComment(value: string): string { return value; }
}
