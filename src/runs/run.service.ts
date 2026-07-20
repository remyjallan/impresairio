import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { EventLogService } from './event-log.service';
import { FileStateStore, RunStateError } from './file-state.store';
import { RunLockService } from './run-lock.service';
import { createRunState, type RunState } from './run-state.schema';

export interface StartRunRequest {
  readonly id?: string;
  readonly workflowId: string;
  readonly roles: Readonly<Record<string, string>>;
  readonly documentationRoot: string;
}

export const RUN_CLOCK = Symbol('RUN_CLOCK');

@Injectable()
export class RunService {
  constructor(
    @Inject(FileStateStore)
    private readonly stateStore: FileStateStore,
    @Inject(EventLogService)
    private readonly eventLog: EventLogService,
    @Inject(RunLockService)
    private readonly locks: RunLockService,
    @Inject(RUN_CLOCK)
    private readonly now: () => Date = () => new Date(),
  ) {}

  start(request: StartRunRequest): RunState {
    const id = request.id ?? `run-${randomUUID()}`;
    const timestamp = this.now().toISOString();
    const state = createRunState({ ...request, id, now: timestamp });
    const release = this.locks.acquire(id, 'start');
    try {
      this.stateStore.create(state);
      this.eventLog.append(id, {
        type: 'run.started',
        at: timestamp,
        workflowId: state.workflow.id,
        roles: state.roles,
      });
    } finally {
      release();
    }
    return state;
  }

  status(runId: string): RunState {
    const state = this.stateStore.findState(runId);
    if (!state) {
      throw new RunStateError(`Run not found: ${runId}`);
    }
    return state;
  }
}
