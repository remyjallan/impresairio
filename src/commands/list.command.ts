import { Inject, Injectable } from '@nestjs/common';
import { Command, CommandRunner } from 'nest-commander';
import { FileStateStore } from '../runs/file-state.store';

export const LIST_WRITER = Symbol('LIST_WRITER');

@Injectable()
@Command({
  name: 'list',
  description: 'List workflow runs, newest first.',
})
export class ListCommand extends CommandRunner {
  constructor(
    @Inject(FileStateStore) private readonly stateStore: FileStateStore,
    @Inject(LIST_WRITER) private readonly write: (line: string) => void = (line) => process.stdout.write(line),
  ) { super(); }

  async run(): Promise<void> {
    const runs = this.stateStore.listStates();
    if (runs.length === 0) {
      this.write('No runs found.\n');
      return;
    }
    this.write([
      'RUN ID\tWORKFLOW\tCURRENT STEP\tUPDATED',
      ...runs.map((run) => `${run.id}\t${run.workflow.id}\t${run.currentStepId ?? 'not-started'}\t${run.updatedAt}`),
      '',
    ].join('\n'));
  }
}
