import { Inject, Injectable, Optional } from '@nestjs/common';
import { EventLogService } from '../runs/event-log.service';
import { FileStateStore, RunStateError } from '../runs/file-state.store';
import { RunLockService } from '../runs/run-lock.service';
import { assertRunActive, type RunState } from '../runs/run-state.schema';
import { ArtifactService } from '../documentation/artifact.service';
import { StaleInvalidationService } from './stale-invalidation.service';
import { isVerdictHalted, verdictWarnings } from './verdict-completion.policy';
import { ConditionEvaluatorService } from './condition-evaluator.service';

export type NextStepResult =
  | { readonly kind: 'agent'; readonly stepId: string }
  | { readonly kind: 'external-agent-output'; readonly stepId: string }
  | { readonly kind: 'host-handoff'; readonly stepId: string }
  | { readonly kind: 'gate'; readonly stepId: string; readonly warnings?: readonly string[] }
  | { readonly kind: 'blocked'; readonly stepId: string; readonly warnings: readonly string[] }
  | { readonly kind: 'complete' };

export const WORKFLOW_CLOCK = Symbol('WORKFLOW_CLOCK');

@Injectable()
export class WorkflowRunnerService {
  constructor(
    @Inject(FileStateStore) private readonly stateStore: FileStateStore,
    @Inject(EventLogService) private readonly eventLog: EventLogService,
    @Inject(RunLockService) private readonly locks: RunLockService,
    @Inject(ArtifactService) private readonly artifacts: ArtifactService,
    @Inject(StaleInvalidationService) private readonly staleInvalidation: StaleInvalidationService,
    @Inject(WORKFLOW_CLOCK) private readonly now: () => Date = () => new Date(),
    @Optional() @Inject(ConditionEvaluatorService)
    private readonly conditions: ConditionEvaluatorService = new ConditionEvaluatorService(),
  ) {}

  next(runId: string): NextStepResult {
    const release = this.locks.acquire(runId, 'next');
    try {
      const activeState = this.requiredState(runId);
      assertRunActive(activeState);
      let state = this.staleInvalidation.preflightApprovedArtifacts(runId, activeState);
      const halted = state.steps.find(isVerdictHalted);
      if (halted) {
        return { kind: 'blocked', stepId: halted.id, warnings: verdictWarnings(state) };
      }
      let step = state.steps.find((candidate) => candidate.status !== 'complete' && candidate.status !== 'skipped');
      while (step?.kind === 'agent' && step.status === 'pending' && step.when
        && !this.conditions.evaluate(step.when, state, step.effectiveParameters)) {
        const timestamp = this.now().toISOString();
        const steps = state.steps.map((candidate) => candidate.id === step?.id && candidate.kind === 'agent'
          ? {
              ...candidate,
              status: 'skipped' as const,
              conditionDecision: { condition: candidate.when!, evaluatedAt: timestamp, result: false as const },
            }
          : candidate);
        state = { ...state, steps, updatedAt: timestamp };
        this.stateStore.save(state);
        this.eventLog.append(runId, { type: 'step.skipped', at: timestamp, stepId: step.id, reason: 'condition-false' });
        step = state.steps.find((candidate) => candidate.status !== 'complete' && candidate.status !== 'skipped');
      }
      if (!step) return { kind: 'complete' };
      if (step.status === 'stale') {
        if (step.kind === 'gate') {
          const reopened = this.staleInvalidation.reopenGateIfReady(runId, state, step.id);
          if (reopened) {
            this.recordGateReached(runId, reopened, step.id);
            return { kind: 'gate', stepId: step.id };
          }
        }
        throw new RunStateError(`Step ${step.id} is stale and must be retried before continuing`);
      }
      if (step.status === 'failed') {
        throw new RunStateError(`Step ${step.id} failed and must be retried before continuing`);
      }
      if (step.kind === 'gate') {
        const warnings = verdictWarnings(state, step.id);
        this.recordGateReached(runId, state, step.id);
        return { kind: 'gate', stepId: step.id, ...(warnings.length > 0 ? { warnings } : {}) };
      }
      if (step.status === 'in_progress') {
        if (step.kind === 'agent' && step.externalRecovery) {
          return { kind: 'external-agent-output', stepId: step.id };
        }
        return { kind: step.kind, stepId: step.id };
      }

      const timestamp = this.now().toISOString();
      const expectedOutput = step.declaredOutput.storage === 'internal'
        ? this.artifacts.prepareInternalOutput(this.stateStore.runDirectory(runId), step.declaredOutput)
        : this.artifacts.prepareOutput({
            target: state.documentation.target,
            featurePath: state.documentation.featurePath,
            bindings: state.documentation.bindings,
            output: step.declaredOutput,
          });
      const inputArtifactHashes = this.inputArtifactHashes(state, step.id, step.kind === 'host-handoff'
        ? new Set(step.inputArtifactIds)
        : undefined);
      const steps = state.steps.map((candidate) => candidate.id === step.id
        && (candidate.kind === 'agent' || candidate.kind === 'host-handoff')
        ? {
            ...candidate,
            status: 'in_progress' as const,
            expectedOutput,
            inputArtifactHashes,
            attempts: [
              ...candidate.attempts,
              {
                number: candidate.attempts.length + 1,
                startedAt: timestamp,
                inputArtifactHashes,
              },
            ],
          }
        : candidate);
      this.stateStore.save({ ...state, currentStepId: step.id, steps, updatedAt: timestamp });
      this.eventLog.append(runId, {
        type: 'step.started',
        at: timestamp,
        stepId: step.id,
      });
      return { kind: step.kind, stepId: step.id };
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

  private inputArtifactHashes(
    state: RunState,
    stepId: string,
    selectedArtifactIds?: ReadonlySet<string>,
  ): Record<string, string> {
    const stepIndex = state.steps.findIndex((step) => step.id === stepId);
    const hashes = new Map<string, string>();
    for (const step of state.steps.slice(0, stepIndex)) {
        if ((step.kind !== 'agent' && step.kind !== 'host-handoff') || step.status !== 'complete' || !step.output) {
          continue;
        }
        if (selectedArtifactIds && !selectedArtifactIds.has(step.declaredOutput.id)) continue;
        hashes.set(
          step.declaredOutput.id,
          this.artifacts.currentHash(step.output, step.expectedOutput?.targetRoot ?? state.documentation.target.root),
        );
    }
    return Object.fromEntries(hashes);
  }

  private recordGateReached(runId: string, state: RunState, gateId: string): void {
    const gate = state.steps.find((step) => step.id === gateId);
    if (!gate || gate.kind !== 'gate' || gate.reachedAt) return;
    const timestamp = this.now().toISOString();
    this.stateStore.save({
      ...state,
      steps: state.steps.map((step) => step.id === gateId && step.kind === 'gate'
        ? { ...step, reachedAt: timestamp }
        : step),
      updatedAt: timestamp,
    });
    this.eventLog.append(runId, { type: 'gate.reached', at: timestamp, gateId });
  }
}
