import { Injectable } from '@nestjs/common';
import { Command, CommandRunner, Option } from 'nest-commander';
import { RunAbandonService } from '../runs/run-abandon.service';

interface AbandonOptions { readonly reason?: string; readonly externalReference?: string; }

@Injectable()
@Command({
  name: 'abandon',
  arguments: '<run-id>',
  description: 'Close an unfinished run deliberately while preserving its audit trail.',
})
export class AbandonCommand extends CommandRunner {
  constructor(private readonly runs: RunAbandonService) { super(); }

  async run([runId]: string[], options: AbandonOptions): Promise<void> {
    if (!options.reason?.trim()) throw new Error('abandon requires --reason');
    this.runs.abandon(runId, options.reason, options.externalReference);
  }

  @Option({ flags: '--reason <text>', description: 'Required human reason recorded in the run event log.' })
  parseReason(value: string): string { return value; }

  @Option({ flags: '--external-reference <reference>', description: 'Optional commit SHA or external delivery reference.' })
  parseExternalReference(value: string): string { return value; }
}
