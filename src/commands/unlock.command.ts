import { Inject, Injectable } from '@nestjs/common';
import { Command, CommandRunner, Option } from 'nest-commander';
import { RunLockService } from '../runs/run-lock.service';

interface UnlockOptions {
  readonly force?: boolean;
}

export const UNLOCK_WRITER = Symbol('UNLOCK_WRITER');

@Injectable()
@Command({
  name: 'unlock',
  arguments: '<run-id>',
  description: 'Remove a stale run lock after PID verification.',
})
export class UnlockCommand extends CommandRunner {
  constructor(
    @Inject(RunLockService) private readonly locks: RunLockService,
    @Inject(UNLOCK_WRITER) private readonly write: (line: string) => void = (line) => process.stdout.write(line),
  ) {
    super();
  }

  async run([runId]: string[], options: UnlockOptions): Promise<void> {
    this.locks.unlock(runId, options.force === true);
    this.write(`unlocked: ${runId}\n`);
  }

  @Option({ flags: '--force', description: 'Force removal of an active or remote lock.' })
  parseForce(): boolean {
    return true;
  }
}
