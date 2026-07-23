import { Inject, Injectable, Optional } from '@nestjs/common';
import type { CompletedDocumentationOutput } from '../documentation/documentation-target';
import type { PreparedDocumentationOutput } from '../documentation/documentation-target';
import { readFileSync } from 'node:fs';
import type { WorkflowPatch, WorkflowPrimitiveValue, WorkflowResult } from '../workflows/workflow.schema';
import { parseStructuredResult, StructuredResultError } from '../workflows/structured-result';
import { assertRunActive } from './run-state.schema';

export type CompletionStepStatus =
  | 'pending'
  | 'in_progress'
  | 'complete'
  | 'skipped'
  | 'stale'
  | 'failed';

export interface CompletionStep {
  readonly id: string;
  readonly kind: 'agent' | 'host-handoff' | 'gate';
  readonly status: CompletionStepStatus;
  readonly output?: PreparedDocumentationOutput;
  readonly storage?: 'documentation' | 'internal';
  readonly declaredResult?: WorkflowResult;
  readonly patch?: WorkflowPatch;
  readonly cycle?: { readonly id: string; readonly role: 'review' | 'consolidate'; readonly iteration: number };
}

export interface CompletionRun {
  readonly id: string;
  readonly abandonment?: { readonly at: string; readonly reason: string; readonly externalReference?: string };
  readonly repositoryDirectory?: string;
  readonly repositoryPatch?: RepositoryPatchState;
  readonly currentStepId: string | undefined;
  readonly steps: readonly CompletionStep[];
  readonly successors?: Readonly<Record<string, readonly string[]>>;
}

export interface CompletionRecord {
  readonly stepId: string;
  readonly output: CompletedDocumentationOutput;
  readonly skipStepIds?: readonly string[];
  readonly reviewOutcome?: {
    readonly verdict: 'APPROVED' | 'CHANGES_REQUESTED' | 'BLOCKED';
    readonly exhausted: boolean;
  };
  readonly result?: {
    readonly value: Readonly<Record<string, WorkflowPrimitiveValue>>;
    readonly outputSha256: string;
    readonly recordedAt: string;
  };
  readonly appliedPatch?: AppliedPatch;
  readonly repositoryPatch?: RepositoryPatchState;
}

export interface AppliedPatch {
  readonly sha256: string;
  readonly paths: string[];
  readonly appliedAt: string;
}

export interface RepositoryPatchState {
  readonly baselineSha256: string;
  readonly currentSha256: string;
}

export interface PatchApplication {
  readonly patch: AppliedPatch;
  readonly repositoryPatch: RepositoryPatchState;
}

export interface PatchApplier {
  apply(run: CompletionRun, step: CompletionStep, markdown: string, appliedAt: string): PatchApplication;
}

export type CompletionTransition =
  | { readonly kind: 'continue' }
  | { readonly kind: 'halt' }
  | { readonly kind: 'retry-from'; readonly targetStepId: string };

export interface CompletionPolicyResult {
  readonly skipStepIds: readonly string[];
  readonly reviewOutcome?: CompletionRecord['reviewOutcome'];
  readonly source?: 'cycle' | 'policy';
  readonly transition?: CompletionTransition;
}

export interface CompletionPolicy {
  evaluate(runId: string, stepId: string, output: CompletedDocumentationOutput): CompletionPolicyResult;
}

/** A durable copy of a verdict artifact retained as context for a bounded retry. */
export interface RetryFeedback {
  readonly sourceStepId: string;
  readonly artifactPath: string;
  readonly artifactSha256: string;
}

export type CompletionEvent =
  | { readonly type: 'step.completed'; readonly stepId: string; readonly at: string; readonly outputSha256: string }
  | { readonly type: 'step.result.recorded'; readonly stepId: string; readonly fields: readonly string[]; readonly outputSha256: string; readonly at: string }
  | { readonly type: 'step.patch.applied'; readonly stepId: string; readonly sha256: string; readonly paths: readonly string[]; readonly at: string }
  | { readonly type: 'cycle.exhausted'; readonly stepId: string; readonly cycleId: string; readonly iteration: number; readonly verdict: 'CHANGES_REQUESTED'; readonly at: string }
  | { readonly type: 'cycle.blocked'; readonly stepId: string; readonly cycleId: string; readonly iteration: number; readonly verdict: 'BLOCKED'; readonly at: string }
  | { readonly type: 'verdict.changes_requested'; readonly stepId: string; readonly retryFrom: string; readonly at: string }
  | { readonly type: 'verdict.exhausted'; readonly stepId: string; readonly at: string }
  | { readonly type: 'verdict.blocked'; readonly stepId: string; readonly at: string };

export interface CompletionRunStore {
  find(runId: string): CompletionRun | undefined;
  recordCompletion(runId: string, completion: CompletionRecord): void;
  appendEvent(runId: string, event: CompletionEvent): void;
  markFailed?(runId: string, stepId: string, detail: string): void;
  preserveRetryFeedback?(runId: string, policyStepId: string, output: CompletedDocumentationOutput): RetryFeedback;
  discardRetryFeedback?(runId: string, retryFeedback: RetryFeedback): void;
  applyVerdictRetry?(runId: string, policyStepId: string, targetStepId: string, retryFeedback: RetryFeedback): void;
}

export interface OutputVerifier {
  completeExpectedOutput(
    run: CompletionRun,
    step: CompletionStep,
  ): CompletedDocumentationOutput;
  readExpectedOutput?(run: CompletionRun, step: CompletionStep): string;
  discardExpectedOutput?(step: CompletionStep): void;
}

export const COMPLETION_RUN_STORE = Symbol('COMPLETION_RUN_STORE');
export const OUTPUT_VERIFIER = Symbol('OUTPUT_VERIFIER');
export const COMPLETION_CLOCK = Symbol('COMPLETION_CLOCK');
export const COMPLETION_LOCK = Symbol('COMPLETION_LOCK');
export const COMPLETION_POLICY = Symbol('COMPLETION_POLICY');
export const PATCH_APPLIER = Symbol('PATCH_APPLIER');

export interface CompletionLock {
  acquire(runId: string, command: string): () => void;
}

export class CompletionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CompletionError';
  }
}

@Injectable()
export class CompletionService {
  constructor(
    @Inject(COMPLETION_RUN_STORE) private readonly store: CompletionRunStore,
    @Inject(OUTPUT_VERIFIER) private readonly outputVerifier: OutputVerifier,
    @Inject(COMPLETION_CLOCK)
    private readonly now: () => Date = () => new Date(),
    @Inject(COMPLETION_LOCK)
    private readonly lock: CompletionLock = { acquire: () => () => undefined },
    @Optional() @Inject(COMPLETION_POLICY)
    private readonly policy: CompletionPolicy = { evaluate: () => ({ skipStepIds: [] }) },
    @Optional() @Inject(PATCH_APPLIER)
    private readonly patches: PatchApplier = { apply: () => { throw new CompletionError('No patch applier is configured'); } },
  ) {}

  complete(runId: string, stepId: string): void {
    const release = this.lock.acquire(runId, 'complete');
    try {
      const run = this.store.find(runId);
      if (!run) {
        throw new CompletionError(`Run not found: ${runId}`);
      }
      assertRunActive(run);

      const step = run.steps.find((candidate) => candidate.id === stepId);
      if (!step) {
        throw new CompletionError(`Step not found in run ${runId}: ${stepId}`);
      }
      if (run.currentStepId !== stepId) {
        throw new CompletionError(`Step ${stepId} is not the current step`);
      }
      if (step.kind === 'gate') {
        throw new CompletionError(`Step ${stepId} is a gate and cannot produce an artifact`);
      }
      if (step.status === 'stale') {
        throw new CompletionError(`Step ${stepId} is stale`);
      }
      if (step.status === 'complete' || step.status === 'skipped') {
        throw new CompletionError(`Step ${stepId} is already complete`);
      }
      if (step.status !== 'in_progress') {
        throw new CompletionError(`Step ${stepId} must be in progress before completion`);
      }

      let output: CompletedDocumentationOutput;
      let policyResult: CompletionPolicyResult;
      let result: CompletionRecord['result'];
      let patchApplication: PatchApplication | undefined;
      let retryOperation: {
        readonly feedback: RetryFeedback;
        readonly discard: (runId: string, feedback: RetryFeedback) => void;
        readonly apply: (runId: string, policyStepId: string, targetStepId: string, feedback: RetryFeedback) => void;
      } | undefined;
      try {
        output = this.outputVerifier.completeExpectedOutput(run, step);
        const content = step.declaredResult || step.patch
          ? this.outputVerifier.readExpectedOutput?.(run, step) ?? readFileSync(output.path, 'utf8')
          : undefined;
        if (step.declaredResult && content !== undefined) {
          result = {
            value: parseStructuredResult(
              content,
              step.declaredResult,
            ),
            outputSha256: output.sha256,
            recordedAt: this.now().toISOString(),
          };
        }
        if (step.patch && content !== undefined) {
          patchApplication = this.patches.apply(run, step, content, this.now().toISOString());
        }
        policyResult = this.policy.evaluate(runId, stepId, output);
        if (policyResult.source === 'policy' && policyResult.transition?.kind === 'retry-from') {
          const preserve = this.store.preserveRetryFeedback?.bind(this.store);
          const discard = this.store.discardRetryFeedback?.bind(this.store);
          const apply = this.store.applyVerdictRetry?.bind(this.store);
          if (!preserve || !discard || !apply) {
            throw new CompletionError('Verdict retries require durable retry-feedback support from the run store');
          }
          retryOperation = { feedback: preserve(runId, stepId, output), discard, apply };
        }
        this.store.recordCompletion(runId, {
          stepId,
          output,
          ...(policyResult.skipStepIds.length > 0 ? { skipStepIds: policyResult.skipStepIds } : {}),
          ...(policyResult.reviewOutcome ? { reviewOutcome: policyResult.reviewOutcome } : {}),
          ...(result ? { result } : {}),
          ...(patchApplication ? {
            appliedPatch: patchApplication.patch,
            repositoryPatch: patchApplication.repositoryPatch,
          } : {}),
        });
      } catch (error) {
        if (retryOperation) {
          try {
            retryOperation.discard(runId, retryOperation.feedback);
          } catch {
            // Preserve the original completion failure; cleanup is best effort.
          }
        }
        if (!(error instanceof StructuredResultError)) {
          this.store.markFailed?.(runId, stepId, error instanceof Error ? error.message : String(error));
        }
        throw error;
      }
      this.store.appendEvent(runId, {
        type: 'step.completed',
        stepId,
        at: this.now().toISOString(),
        outputSha256: output.sha256,
      });
      if (result) {
        this.store.appendEvent(runId, {
          type: 'step.result.recorded',
          stepId,
          fields: Object.keys(result.value),
          outputSha256: result.outputSha256,
          at: this.now().toISOString(),
        });
      }
      if (patchApplication) {
        this.store.appendEvent(runId, {
          type: 'step.patch.applied',
          stepId,
          sha256: patchApplication.patch.sha256,
          paths: patchApplication.patch.paths,
          at: patchApplication.patch.appliedAt,
        });
      }
      if (policyResult.source === 'policy' && policyResult.reviewOutcome) {
        const transition = policyResult.transition;
        if (transition?.kind === 'retry-from') {
          const preparedRetry = retryOperation;
          if (!preparedRetry) {
            throw new CompletionError('Verdict retry was not prepared with durable feedback');
          }
          const invalidatedIds = downstreamStepIds(run, transition.targetStepId);
          for (const retryTarget of run.steps) {
            if (retryTarget.kind === 'agent'
              && retryTarget.storage === 'internal'
              && retryTarget.output
              && invalidatedIds.has(retryTarget.id)) {
              this.outputVerifier.discardExpectedOutput?.(retryTarget);
            }
          }
          preparedRetry.apply(runId, stepId, transition.targetStepId, preparedRetry.feedback);
          this.store.appendEvent(runId, {
            type: 'verdict.changes_requested',
            stepId,
            retryFrom: transition.targetStepId,
            at: this.now().toISOString(),
          });
        } else if (policyResult.transition?.kind === 'halt') {
          this.store.appendEvent(runId, policyResult.reviewOutcome.verdict === 'BLOCKED'
            ? { type: 'verdict.blocked', stepId, at: this.now().toISOString() }
            : { type: 'verdict.exhausted', stepId, at: this.now().toISOString() });
        }
      }
      if (policyResult.source !== 'policy'
        && (policyResult.reviewOutcome?.exhausted || policyResult.reviewOutcome?.verdict === 'BLOCKED')) {
        const persisted = this.store.find(runId)?.steps.find((candidate) => candidate.id === stepId);
        const cycle = persisted && 'cycle' in persisted ? persisted.cycle : undefined;
        if (cycle) {
          this.store.appendEvent(runId, policyResult.reviewOutcome.verdict === 'BLOCKED'
            ? {
                type: 'cycle.blocked', stepId, cycleId: cycle.id,
                iteration: cycle.iteration, verdict: 'BLOCKED', at: this.now().toISOString(),
              }
            : {
                type: 'cycle.exhausted', stepId, cycleId: cycle.id,
                iteration: cycle.iteration, verdict: 'CHANGES_REQUESTED', at: this.now().toISOString(),
              });
        }
      }
    } finally {
      release();
    }
  }
}

function downstreamStepIds(run: CompletionRun, sourceStepId: string): ReadonlySet<string> {
  const ids = new Set<string>();
  const visit = (stepId: string): void => {
    if (ids.has(stepId)) return;
    ids.add(stepId);
    for (const successor of run.successors?.[stepId] ?? []) visit(successor);
  };
  visit(sourceStepId);
  return ids;
}
