import { Inject, Injectable, Optional } from '@nestjs/common';
import type { CompletedDocumentationOutput } from '../documentation/documentation-target';
import type { PreparedDocumentationOutput } from '../documentation/documentation-target';

export type CompletionStepStatus =
  | 'pending'
  | 'in_progress'
  | 'complete'
  | 'skipped'
  | 'stale'
  | 'failed';

export interface CompletionStep {
  readonly id: string;
  readonly kind: 'agent' | 'gate';
  readonly status: CompletionStepStatus;
  readonly output?: PreparedDocumentationOutput;
  readonly cycle?: { readonly id: string; readonly role: 'review' | 'consolidate'; readonly iteration: number };
}

export interface CompletionRun {
  readonly id: string;
  readonly currentStepId: string | undefined;
  readonly steps: readonly CompletionStep[];
}

export interface CompletionRecord {
  readonly stepId: string;
  readonly output: CompletedDocumentationOutput;
  readonly skipStepIds?: readonly string[];
  readonly reviewOutcome?: {
    readonly verdict: 'APPROVED' | 'CHANGES_REQUESTED' | 'BLOCKED';
    readonly exhausted: boolean;
  };
}

export interface CompletionPolicyResult {
  readonly skipStepIds: readonly string[];
  readonly reviewOutcome?: CompletionRecord['reviewOutcome'];
}

export interface CompletionPolicy {
  evaluate(runId: string, stepId: string, output: CompletedDocumentationOutput): CompletionPolicyResult;
}

export type CompletionEvent =
  | { readonly type: 'step.completed'; readonly stepId: string; readonly at: string; readonly outputSha256: string }
  | { readonly type: 'cycle.exhausted'; readonly stepId: string; readonly cycleId: string; readonly iteration: number; readonly verdict: 'CHANGES_REQUESTED'; readonly at: string }
  | { readonly type: 'cycle.blocked'; readonly stepId: string; readonly cycleId: string; readonly iteration: number; readonly verdict: 'BLOCKED'; readonly at: string };

export interface CompletionRunStore {
  find(runId: string): CompletionRun | undefined;
  recordCompletion(runId: string, completion: CompletionRecord): void;
  appendEvent(runId: string, event: CompletionEvent): void;
  markFailed?(runId: string, stepId: string, detail: string): void;
}

export interface OutputVerifier {
  completeExpectedOutput(
    run: CompletionRun,
    step: CompletionStep,
  ): CompletedDocumentationOutput;
}

export const COMPLETION_RUN_STORE = Symbol('COMPLETION_RUN_STORE');
export const OUTPUT_VERIFIER = Symbol('OUTPUT_VERIFIER');
export const COMPLETION_CLOCK = Symbol('COMPLETION_CLOCK');
export const COMPLETION_LOCK = Symbol('COMPLETION_LOCK');
export const COMPLETION_POLICY = Symbol('COMPLETION_POLICY');

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
  ) {}

  complete(runId: string, stepId: string): void {
    const release = this.lock.acquire(runId, 'complete');
    try {
      const run = this.store.find(runId);
      if (!run) {
        throw new CompletionError(`Run not found: ${runId}`);
      }

      const step = run.steps.find((candidate) => candidate.id === stepId);
      if (!step) {
        throw new CompletionError(`Step not found in run ${runId}: ${stepId}`);
      }
      if (run.currentStepId !== stepId) {
        throw new CompletionError(`Step ${stepId} is not the current step`);
      }
      if (step.kind === 'gate') {
        throw new CompletionError(`Step ${stepId} is a gate and cannot be completed by an agent`);
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
      try {
        output = this.outputVerifier.completeExpectedOutput(run, step);
        policyResult = this.policy.evaluate(runId, stepId, output);
        this.store.recordCompletion(runId, {
          stepId,
          output,
          ...(policyResult.skipStepIds.length > 0 ? { skipStepIds: policyResult.skipStepIds } : {}),
          ...(policyResult.reviewOutcome ? { reviewOutcome: policyResult.reviewOutcome } : {}),
        });
      } catch (error) {
        this.store.markFailed?.(runId, stepId, error instanceof Error ? error.message : String(error));
        throw error;
      }
      this.store.appendEvent(runId, {
        type: 'step.completed',
        stepId,
        at: this.now().toISOString(),
        outputSha256: output.sha256,
      });
      if (policyResult.reviewOutcome?.exhausted || policyResult.reviewOutcome?.verdict === 'BLOCKED') {
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
