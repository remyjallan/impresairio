import { Inject, Injectable } from '@nestjs/common';
import { FileStateStore, RunStateError } from '../runs/file-state.store';
import { RunLockService } from '../runs/run-lock.service';
import { StaleInvalidationService } from './stale-invalidation.service';
import { assertRunActive } from '../runs/run-state.schema';

@Injectable()
export class GateService {
  constructor(
    @Inject(FileStateStore) private readonly stateStore: FileStateStore,
    @Inject(RunLockService) private readonly locks: RunLockService,
    @Inject(StaleInvalidationService) private readonly staleInvalidation: StaleInvalidationService,
  ) {}

  approve(runId: string, gateId: string, comment?: string): void {
    this.mutate(runId, 'approve', (state) => {
      const checked = this.staleInvalidation.preflightApprovedArtifacts(runId, state);
      this.staleInvalidation.approve(runId, checked, gateId, comment);
    });
  }

  requestChanges(runId: string, gateId: string, comment: string): void {
    this.mutate(runId, 'request-changes', (state) => {
      this.staleInvalidation.requestChanges(runId, state, gateId, comment);
    });
  }

  acknowledge(runId: string, stepId: string, comment: string): void {
    this.mutate(runId, 'acknowledge', (state) => {
      this.staleInvalidation.acknowledge(runId, state, stepId, comment);
    });
  }

  retry(runId: string, stepId: string): void {
    this.mutate(runId, 'retry', (state) => {
      this.staleInvalidation.retry(runId, state, stepId);
    });
  }

  private mutate(
    runId: string,
    command: string,
    operation: (state: NonNullable<ReturnType<FileStateStore['findState']>>) => void,
  ): void {
    const release = this.locks.acquire(runId, command);
    try {
      const state = this.stateStore.findState(runId);
      if (!state) {
        throw new RunStateError(`Run not found: ${runId}`);
      }
      assertRunActive(state);
      operation(state);
    } finally {
      release();
    }
  }
}
