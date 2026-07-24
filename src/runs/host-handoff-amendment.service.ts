import { Inject, Injectable } from '@nestjs/common';
import { ArtifactService } from '../documentation/artifact.service';
import { EventLogService } from './event-log.service';
import { FileStateStore, RunStateError } from './file-state.store';
import { RunLockService } from './run-lock.service';
import { assertRunActive, type RunState } from './run-state.schema';

export const HOST_HANDOFF_AMENDMENT_CLOCK = Symbol('HOST_HANDOFF_AMENDMENT_CLOCK');

/** Safely reopens a completed host artifact before any dependent work executes. */
@Injectable()
export class HostHandoffAmendmentService {
  constructor(
    @Inject(FileStateStore) private readonly stateStore: FileStateStore,
    @Inject(ArtifactService) private readonly artifacts: ArtifactService,
    @Inject(EventLogService) private readonly events: EventLogService,
    @Inject(RunLockService) private readonly locks: RunLockService,
    @Inject(HOST_HANDOFF_AMENDMENT_CLOCK) private readonly now: () => Date = () => new Date(),
  ) {}

  amend(runId: string, stepId: string, reason: string): void {
    // RunLockService creates an exclusive, run-local filesystem lock. It is held
    // before state is read, so a second Impresairio CLI process cannot overwrite
    // this amendment with a stale copy of the run state. RunLockService permits
    // a nested amendment within its owning composite command, while rejecting a
    // separately invoked CLI process until that command releases the lock.
    const release = this.locks.acquireReentrant(runId, 'amend-host-handoff');
    try {
      const state = this.stateStore.findState(runId);
      if (!state) throw new RunStateError(`Run not found: ${runId}`);
      assertRunActive(state);
      const step = state.steps.find((candidate) => candidate.id === stepId);
      if (!step || step.kind !== 'host-handoff') {
        throw new RunStateError(`Step ${stepId} is not a host handoff`);
      }
      const output = step.output;
      if (step.status !== 'complete' || !output || !output.path || !output.sha256 || !output.completedAt || !step.expectedOutput) {
        throw new RunStateError(`Host handoff ${stepId} must be complete before it can be amended`);
      }
      const normalizedReason = reason.trim();
      if (!normalizedReason) throw new RunStateError('amend-host-handoff requires --reason');
      if ((step.amendments?.length ?? 0) >= 20) {
        throw new RunStateError(`Host handoff ${stepId} reached the maximum of 20 amendments`);
      }

      const dependentIds = successorsOf(state, stepId);
      this.assertDependenciesNotExecuted(state, dependentIds);
      const revision = (step.amendments?.length ?? 0) + 1;
      const priorOutput = this.stateStore.preserveHostHandoffRevision(runId, stepId, revision, output);
      const timestamp = this.now().toISOString();
      this.artifacts.discardOutput(step.expectedOutput);

      const steps = state.steps.map((candidate) => {
        if (candidate.id === stepId && candidate.kind === 'host-handoff') {
          return {
            ...candidate,
            status: 'pending' as const,
            expectedOutput: undefined,
            output: undefined,
            inputArtifactHashes: undefined,
            handoffPreparedAt: undefined,
            amendments: [...(candidate.amendments ?? []), {
              revision,
              amendedAt: timestamp,
              reason: normalizedReason,
              priorOutput,
            }],
          };
        }
        if (!dependentIds.has(candidate.id)) return candidate;
        if (candidate.kind === 'gate') {
          return { ...candidate, status: 'pending' as const, approval: undefined, reachedAt: undefined };
        }
        if (candidate.kind === 'agent') {
          return {
            ...candidate,
            status: 'pending' as const,
            expectedOutput: undefined,
            output: undefined,
            inputArtifactHashes: undefined,
            dispatchPreparedAt: undefined,
            reviewOutcome: undefined,
            result: undefined,
            conditionDecision: undefined,
            externalRecovery: undefined,
            approval: undefined,
          };
        }
        return {
          ...candidate,
          status: 'pending' as const,
          expectedOutput: undefined,
          output: undefined,
          inputArtifactHashes: undefined,
          handoffPreparedAt: undefined,
        };
      });
      this.stateStore.save({ ...state, currentStepId: undefined, steps, updatedAt: timestamp });
      this.events.append(runId, {
        type: 'host.handoff.amended', at: timestamp, stepId, revision,
        reason: normalizedReason, priorArtifactSha256: priorOutput.sha256,
        priorArtifactPath: priorOutput.archivedPath,
        invalidatedStepIds: [...dependentIds],
      });
    } finally {
      release();
    }
  }

  private assertDependenciesNotExecuted(state: RunState, dependentIds: ReadonlySet<string>): void {
    // An in-progress host handoff only means its prompt was prepared for the
    // host. It has no provider execution state and remains safely invalidatable
    // until the runner records its completed output. Applied patches exist only
    // on agent steps in the persisted run schema.
    const executionStarted = new Set(
      this.events.read(state.id)
        .filter((event) => event.type === 'agent.execution.started' && typeof event.stepId === 'string')
        .map((event) => event.stepId as string),
    );
    for (const step of state.steps) {
      if (!dependentIds.has(step.id)) continue;
      if (step.kind !== 'gate' && step.output) {
        throw new RunStateError(`Cannot amend: dependent step ${step.id} already published an artifact`);
      }
      if (step.status === 'complete') {
        throw new RunStateError(`Cannot amend: dependent step ${step.id} already completed`);
      }
      if (step.kind === 'agent' && executionStarted.has(step.id)) {
        throw new RunStateError(`Cannot amend: dependent agent step ${step.id} already began provider execution`);
      }
      if (step.kind === 'agent' && step.appliedPatch) {
        throw new RunStateError(`Cannot amend: dependent agent step ${step.id} already applied a patch`);
      }
    }
  }
}

function successorsOf(state: RunState, sourceStepId: string): Set<string> {
  const successors = new Set<string>();
  // This frozen graph is produced from the fully expanded V0 linear workflow
  // plan at run start. It is the authority for invalidation boundaries.
  if (!Object.hasOwn(state.workflow.successors, sourceStepId)) {
    throw new RunStateError(`Cannot amend: workflow successor graph is missing source step ${sourceStepId}`);
  }
  for (const step of state.steps) {
    if (!Object.hasOwn(state.workflow.successors, step.id)) {
      throw new RunStateError(`Cannot amend: workflow successor graph is missing step ${step.id}`);
    }
  }
  const visit = (stepId: string): void => {
    for (const successor of state.workflow.successors[stepId] ?? []) {
      if (successors.has(successor)) continue;
      successors.add(successor);
      visit(successor);
    }
  };
  visit(sourceStepId);
  return successors;
}
