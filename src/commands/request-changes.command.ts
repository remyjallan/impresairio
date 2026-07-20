import { Injectable } from '@nestjs/common';
import { Command, CommandRunner, Option } from 'nest-commander';
import { GateService } from '../workflows/gate.service';

interface RequestChangesOptions { readonly comment?: string; }

@Injectable()
@Command({
  name: 'request-changes',
  arguments: '<run-id> <gate-id>',
  description: 'Return a gate artifact to its producer and stale completed downstream work.',
})
export class RequestChangesCommand extends CommandRunner {
  constructor(private readonly gates: GateService) { super(); }

  async run([runId, gateId]: string[], options: RequestChangesOptions): Promise<void> {
    if (!options.comment?.trim()) {
      throw new Error('request-changes requires --comment');
    }
    this.gates.requestChanges(runId, gateId, options.comment);
  }

  @Option({ flags: '--comment <text>', description: 'Required feedback preserved on the gate.' })
  parseComment(value: string): string { return value; }
}
