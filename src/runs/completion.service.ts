import { Inject, Injectable } from '@nestjs/common';
import type { CompletedDocumentationOutput } from '../documentation/documentation-target';

export type CompletionStepStatus =
  | 'pending'
  | 'in_progress'
  | 'complete'
  | 'stale';

export interface CompletionStep {
  readonly id: string;
  readonly kind: 'agent' | 'gate';
  readonly status: CompletionStepStatus;
}

export interface CompletionRun {
  readonly id: string;
  readonly currentStepId: string | undefined;
  readonly steps: readonly CompletionStep[];
}

export interface CompletionRecord {
  readonly stepId: string;
  readonly output: CompletedDocumentationOutput;
}

export interface CompletionEvent {
  readonly type: 'step.completed';
  readonly stepId: string;
  readonly at: string;
  readonly outputSha256: string;
}

export interface CompletionRunStore {
  find(runId: string): CompletionRun | undefined;
  recordCompletion(runId: string, completion: CompletionRecord): void;
  appendEvent(runId: string, event: CompletionEvent): void;
}

export interface OutputVerifier {
  completeExpectedOutput(
    run: CompletionRun,
    step: CompletionStep,
  ): CompletedDocumentationOutput;
}

export const COMPLETION_RUN_STORE = Symbol('COMPLETION_RUN_STORE');
export const OUTPUT_VERIFIER = Symbol('OUTPUT_VERIFIER');

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
    private readonly now: () => Date = () => new Date(),
  ) {}

  complete(runId: string, stepId: string): void {
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
    if (step.status === 'complete') {
      throw new CompletionError(`Step ${stepId} is already complete`);
    }
    if (step.status !== 'in_progress') {
      throw new CompletionError(`Step ${stepId} must be in progress before completion`);
    }

    const output = this.outputVerifier.completeExpectedOutput(run, step);
    this.store.recordCompletion(runId, { stepId, output });
    this.store.appendEvent(runId, {
      type: 'step.completed',
      stepId,
      at: this.now().toISOString(),
      outputSha256: output.sha256,
    });
  }
}
