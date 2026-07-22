import { Injectable } from '@nestjs/common';
import { Command, CommandRunner } from 'nest-commander';
import { GateService } from '../workflows/gate.service';

@Injectable()
@Command({
  name: 'retry',
  arguments: '<run-id> <step-id>',
  description: 'Return a stale or failed agent or host handoff step to pending while keeping its attempt history.',
})
export class RetryCommand extends CommandRunner {
  constructor(private readonly gates: GateService) { super(); }

  async run([runId, stepId]: string[]): Promise<void> {
    this.gates.retry(runId, stepId);
  }
}
