import { Injectable } from '@nestjs/common';
import { Command, CommandRunner, Option } from 'nest-commander';
import { HostHandoffAmendmentService } from '../runs/host-handoff-amendment.service';

interface AmendHostHandoffOptions { readonly reason?: string; }

@Injectable()
@Command({
  name: 'amend-host-handoff',
  arguments: '<run-id> <step-id>',
  description: 'Reopen a completed host handoff before dependent work executes, preserving its prior revision.',
})
export class AmendHostHandoffCommand extends CommandRunner {
  constructor(private readonly amendments: HostHandoffAmendmentService) { super(); }

  async run([runId, stepId]: string[], options: AmendHostHandoffOptions): Promise<void> {
    const reason = options.reason?.trim() ?? '';
    if (!reason) throw new Error('amend-host-handoff requires --reason');
    if (reason.length > 1_000) throw new Error('amend-host-handoff --reason must not exceed 1000 characters');
    this.amendments.amend(runId, stepId, reason);
  }

  @Option({ flags: '--reason <text>', description: 'Required reason recorded with the preserved host artifact revision.' })
  parseReason(value: string): string { return value; }
}
