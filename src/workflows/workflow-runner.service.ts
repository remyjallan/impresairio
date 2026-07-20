import { Inject, Injectable } from '@nestjs/common';
import { EventLogService } from '../runs/event-log.service';
import { FileStateStore, RunStateError } from '../runs/file-state.store';
import { RunLockService } from '../runs/run-lock.service';
import type { RunState } from '../runs/run-state.schema';
import { ArtifactService } from '../documentation/artifact.service';

export type NextStepResult =
  | { readonly kind: 'agent'; readonly stepId: string }
  | { readonly kind: 'gate'; readonly stepId: string }
  | { readonly kind: 'complete' };

export const WORKFLOW_CLOCK = Symbol('WORKFLOW_CLOCK');

@Injectable()
export class WorkflowRunnerService {
  constructor(
    @Inject(FileStateStore) private readonly stateStore: FileStateStore,
    @Inject(EventLogService) private readonly eventLog: EventLogService,
    @Inject(RunLockService) private readonly locks: RunLockService,
    @Inject(ArtifactService) private readonly artifacts: ArtifactService,
    @Inject(WORKFLOW_CLOCK) private readonly now: () => Date = () => new Date(),
  ) {}

  next(runId: string): NextStepResult {
    const release = this.locks.acquire(runId, 'next');
    try {
      const state = this.requiredState(runId);
      const step = state.steps.find((candidate) => candidate.status !== 'complete');
      if (!step) {
        return { kind: 'complete' };
      }
      if (step.status === 'stale') {
        throw new RunStateError(`Step ${step.id} is stale and must be retried before continuing`);
      }
      if (step.kind === 'gate') {
        return { kind: 'gate', stepId: step.id };
      }
      if (step.status === 'in_progress') {
        return { kind: 'agent', stepId: step.id };
      }

      const timestamp = this.now().toISOString();
      const expectedOutput = this.artifacts.prepareOutput({
        target: state.documentation.target,
        featurePath: state.documentation.featurePath,
        bindings: state.documentation.bindings,
        output: step.declaredOutput,
      });
      const steps = state.steps.map((candidate) => candidate.id === step.id
        ? {
            ...candidate,
            status: 'in_progress' as const,
            expectedOutput,
          }
        : candidate);
      this.stateStore.save({ ...state, currentStepId: step.id, steps, updatedAt: timestamp });
      this.eventLog.append(runId, {
        type: 'step.started',
        at: timestamp,
        stepId: step.id,
      });
      return { kind: 'agent', stepId: step.id };
    } finally {
      release();
    }
  }

  private requiredState(runId: string): RunState {
    const state = this.stateStore.findState(runId);
    if (!state) {
      throw new RunStateError(`Run not found: ${runId}`);
    }
    return state;
  }
}
