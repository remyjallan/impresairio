import { Inject, Injectable } from '@nestjs/common';
import { EventLogService } from './event-log.service';
import { FileStateStore, RunStateError } from './file-state.store';
import { RunLockService } from './run-lock.service';
import type { NextStepResult } from '../workflows/workflow-runner.service';

export interface ExternalAgentRecoveryHandoff {
  readonly kind: 'external-agent-output';
  readonly protocolVersion: 1;
  readonly runId: string;
  readonly stepId: string;
  readonly repositoryDirectory: string;
  readonly reason: string;
  readonly expectedOutput: { readonly id: string; readonly format: 'markdown'; readonly maxBytes: number };
  readonly instruction: string;
}

@Injectable()
export class ExternalAgentRecoveryService {
  constructor(
    @Inject(FileStateStore) private readonly stateStore: FileStateStore,
    @Inject(EventLogService) private readonly events: EventLogService,
    @Inject(RunLockService) private readonly locks: RunLockService,
  ) {}

  prepare(runId: string, stepId: string, reason: string): ExternalAgentRecoveryHandoff {
    const release = this.locks.acquire(runId, 'prepare-external-agent-output');
    try {
      const state = this.requiredState(runId);
      const step = state.steps.find((candidate) => candidate.id === stepId);
      if (!step || step.kind !== 'agent' || step.patch !== 'apply-unified-diff') {
        throw new RunStateError(`Step ${stepId} is not a patch-producing agent step`);
      }
      if (step.status !== 'failed' || !step.expectedOutput) {
        throw new RunStateError(`Step ${stepId} must be a failed prepared agent step`);
      }
      const normalizedReason = reason.trim();
      if (!normalizedReason) throw new RunStateError('External recovery reason must not be empty');
      const preparedAt = new Date().toISOString();
      const attempts = [
        ...step.attempts,
        { number: step.attempts.length + 1, startedAt: preparedAt, inputArtifactHashes: step.inputArtifactHashes ?? {} },
      ];
      const next = {
        ...state,
        currentStepId: stepId,
        steps: state.steps.map((candidate) => candidate.id === stepId && candidate.kind === 'agent'
          ? {
              ...candidate,
              status: 'in_progress' as const,
              dispatchPreparedAt: undefined,
              attempts,
              externalRecovery: { preparedAt, reason: normalizedReason },
            }
          : candidate),
        updatedAt: preparedAt,
      };
      this.stateStore.save(next);
      this.events.append(runId, {
        type: 'agent.external_recovery.prepared', at: preparedAt, stepId, reason: normalizedReason,
      });
      return this.handoffFor(next, stepId);
    } finally {
      release();
    }
  }

  handoff(runId: string, result: NextStepResult): ExternalAgentRecoveryHandoff | undefined {
    if (result.kind !== 'external-agent-output') return undefined;
    const release = this.locks.acquire(runId, 'external-agent-output');
    try {
      return this.handoffFor(this.requiredState(runId), result.stepId);
    } finally {
      release();
    }
  }

  private handoffFor(state: NonNullable<ReturnType<FileStateStore['findState']>>, stepId: string): ExternalAgentRecoveryHandoff {
    const step = state.steps.find((candidate) => candidate.id === stepId);
    if (!step || step.kind !== 'agent' || step.status !== 'in_progress' || !step.expectedOutput || !step.externalRecovery) {
      throw new RunStateError(`External recovery for ${stepId} has not been prepared`);
    }
    return {
      kind: 'external-agent-output',
      protocolVersion: 1,
      runId: state.id,
      stepId,
      repositoryDirectory: state.repositoryDirectory ?? process.cwd(),
      reason: step.externalRecovery.reason,
      expectedOutput: { id: step.expectedOutput.id, format: 'markdown', maxBytes: 1_048_576 },
      instruction: 'Inspect the repository and return Markdown containing exactly one impresairio-patch fenced block. Do not write to the Impresairio-managed output path. Save the response to a separate file, then run submit-agent-output so Impresairio validates, applies, and records the patch.',
    };
  }

  private requiredState(runId: string): NonNullable<ReturnType<FileStateStore['findState']>> {
    const state = this.stateStore.findState(runId);
    if (!state) throw new RunStateError(`Run not found: ${runId}`);
    return state;
  }
}
