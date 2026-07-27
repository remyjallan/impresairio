import { Inject, Injectable } from '@nestjs/common';
import { EventLogService } from './event-log.service';
import { FileStateStore, RunStateError } from './file-state.store';
import { RunLockService } from './run-lock.service';

@Injectable()
export class RunAbandonService {
  constructor(
    @Inject(FileStateStore) private readonly stateStore: FileStateStore,
    @Inject(EventLogService) private readonly events: EventLogService,
    @Inject(RunLockService) private readonly locks: RunLockService,
  ) {}

  abandon(runId: string, reason: string, externalReference?: string): void {
    const release = this.locks.acquire(runId, 'abandon');
    try {
      const state = this.stateStore.findState(runId);
      if (!state) throw new RunStateError(`Run not found: ${runId}`);
      if (state.abandonment) throw new RunStateError(`Run ${runId} is already abandoned`);
      if (isCompletedRun(state.steps)) {
        throw new RunStateError(`Run ${runId} is already complete and cannot be abandoned`);
      }
      if (state.steps.some((step) => step.status === 'in_progress')) {
        throw new RunStateError(`Run ${runId} has an in-progress step and cannot be abandoned`);
      }
      const normalizedReason = reason.trim();
      if (!normalizedReason) throw new RunStateError('Abandon reason must not be empty');
      if (normalizedReason.length > 1_000) throw new RunStateError('Abandon reason must be at most 1000 characters');
      const normalizedReference = externalReference?.trim();
      if (normalizedReference && normalizedReference.length > 2_000) {
        throw new RunStateError('External reference must be at most 2000 characters');
      }
      const at = new Date().toISOString();
      const lastStepId = state.currentStepId ?? state.steps.findLast((step) => step.status !== 'pending')?.id;
      this.stateStore.save({
        ...state,
        abandonment: {
          at,
          reason: normalizedReason,
          ...(normalizedReference ? { externalReference: normalizedReference } : {}),
          ...(lastStepId ? { lastStepId } : {}),
        },
        currentStepId: undefined,
        updatedAt: at,
      });
      this.events.append(runId, {
        type: 'run.abandoned', at, reason: normalizedReason,
        ...(normalizedReference ? { externalReference: normalizedReference } : {}),
        ...(lastStepId ? { lastStepId } : {}),
      });
    } finally {
      release();
    }
  }
}

function isCompletedRun(steps: readonly { readonly status: string }[]): boolean {
  return steps.length > 0 && steps.every((step) => step.status === 'complete' || step.status === 'skipped');
}
