import { Inject, Injectable } from '@nestjs/common';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { HomeDirectoryResolver } from '../config/home-directory.resolver';
import type {
  CompletionEvent,
  CompletionRecord,
  CompletionRun,
  CompletionRunStore,
} from './completion.service';
import { runStateSchema, type RunState } from './run-state.schema';
import { assertValidRunId } from './run-id';
import type { StateStore } from './state-store';

export interface StateFileOperations {
  readonly existsSync: typeof existsSync;
  readonly mkdirSync: typeof mkdirSync;
  readonly readdirSync: typeof readdirSync;
  readonly readFileSync: typeof readFileSync;
  readonly renameSync: typeof renameSync;
  readonly rmSync: typeof rmSync;
  readonly writeFileSync: typeof writeFileSync;
  readonly appendFileSync: typeof appendFileSync;
}

const nativeFileOperations: StateFileOperations = {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  appendFileSync,
};

export const FILE_STATE_OPERATIONS = Symbol('FILE_STATE_OPERATIONS');

export class RunStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RunStateError';
  }
}

@Injectable()
export class FileStateStore implements StateStore, CompletionRunStore {
  readonly fileOperations: StateFileOperations;

  constructor(
    @Inject(HomeDirectoryResolver)
    private readonly homeDirectoryResolver: HomeDirectoryResolver,
    @Inject(FILE_STATE_OPERATIONS)
    fileOperations: Partial<StateFileOperations> = {},
  ) {
    this.fileOperations = { ...nativeFileOperations, ...fileOperations };
  }

  create(state: RunState): void {
    const parsed = runStateSchema.parse(state);
    const directory = this.runDirectory(parsed.id);
    if (this.fileOperations.existsSync(this.statePath(parsed.id))) {
      throw new RunStateError(`Run already exists: ${parsed.id}`);
    }
    this.fileOperations.mkdirSync(directory, { recursive: true });
    this.writeAtomically(parsed);
  }

  findState(runId: string): RunState | undefined {
    const path = this.statePath(runId);
    if (!this.fileOperations.existsSync(path)) {
      return undefined;
    }

    let value: unknown;
    try {
      value = JSON.parse(this.fileOperations.readFileSync(path, 'utf8'));
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'could not read JSON';
      throw new RunStateError(`Invalid state for run ${runId}: ${detail}`);
    }

    const parsed = runStateSchema.safeParse(value);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new RunStateError(
        `Invalid state for run ${runId}: ${issue.path.join('.') || '(root)'}: ${issue.message}`,
      );
    }
    return parsed.data;
  }

  /** Returns readable runs newest first; a damaged run never hides the others. */
  listStates(): readonly RunState[] {
    const runsDirectory = join(this.homeDirectoryResolver.resolve(), 'runs');
    if (!this.fileOperations.existsSync(runsDirectory)) return [];
    const states: RunState[] = [];
    for (const entry of this.fileOperations.readdirSync(runsDirectory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      try {
        const state = this.findState(entry.name);
        if (state) states.push(state);
      } catch (error) {
        // Listing is recovery-oriented: a damaged state is still accessible by
        // its ID for diagnosis, but must not hide valid sibling runs.
        if (!(error instanceof RunStateError)) throw error;
      }
    }
    return states.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  save(state: RunState): void {
    const parsed = runStateSchema.parse(state);
    if (!this.fileOperations.existsSync(this.statePath(parsed.id))) {
      throw new RunStateError(`Run not found: ${parsed.id}`);
    }
    this.writeAtomically(parsed);
  }

  findById(runId: string): { readonly id: string } | undefined {
    const state = this.findState(runId);
    return state ? { id: state.id } : undefined;
  }

  find(runId: string): CompletionRun | undefined {
    const state = this.findState(runId);
    if (!state) {
      return undefined;
    }
    return {
      id: state.id,
      currentStepId: state.currentStepId,
      steps: state.steps.map((step) => ({
        id: step.id,
        kind: step.kind,
        status: step.status,
        ...(step.kind === 'agent' && step.cycle ? { cycle: step.cycle } : {}),
        ...(step.kind === 'agent' && step.expectedOutput
          ? { output: step.expectedOutput }
          : {}),
      })),
    };
  }

  recordCompletion(runId: string, completion: CompletionRecord): void {
    const state = this.requiredState(runId);
    const stepIndex = state.steps.findIndex((step) => step.id === completion.stepId);
    if (stepIndex < 0) {
      throw new RunStateError(`Step not found in run ${runId}: ${completion.stepId}`);
    }
    const completedAt = new Date().toISOString();
    let steps = state.steps.map((step, index) => {
      if (index !== stepIndex) {
        return step;
      }
      if (step.kind !== 'agent') {
        throw new RunStateError(`Step ${completion.stepId} is not an agent step`);
      }
      const lastAttempt = step.attempts.at(-1);
      if (!lastAttempt) {
        throw new RunStateError(`Step ${completion.stepId} has no recorded attempt`);
      }
      return {
        ...step,
        status: 'complete' as const,
        output: { ...completion.output, completedAt },
        ...(completion.reviewOutcome ? { reviewOutcome: completion.reviewOutcome } : {}),
        attempts: [
          ...step.attempts.slice(0, -1),
          {
            ...lastAttempt,
            completedAt,
            outputSha256: completion.output.sha256,
          },
        ],
      };
    });
    const skipped = new Set(completion.skipStepIds ?? []);
    steps = steps.map((step) => skipped.has(step.id) && step.kind === 'agent' && step.status === 'pending'
      ? { ...step, status: 'skipped' as const }
      : step);
    this.save({ ...state, steps, updatedAt: completedAt });
  }

  appendEvent(runId: string, event: CompletionEvent): void {
    this.appendJsonLine(runId, { ...event });
  }

  markFailed(runId: string, stepId: string, detail: string): void {
    const state = this.requiredState(runId);
    const failedStep = state.steps.find((step) => step.id === stepId);
    if (!failedStep || failedStep.kind !== 'agent' || failedStep.status !== 'in_progress') return;
    const timestamp = new Date().toISOString();
    const steps = state.steps.map((step) => step.id === stepId && step.kind === 'agent' && step.status === 'in_progress'
      ? { ...step, status: 'failed' as const, dispatchPreparedAt: undefined }
      : step);
    this.save({ ...state, steps, updatedAt: timestamp });
    this.appendJsonLine(runId, {
      type: 'step.failed', at: timestamp, stepId,
      detail: detail.length > 1000 ? `${detail.slice(0, 997)}...` : detail,
    });
  }

  runDirectory(runId: string): string {
    assertValidRunId(runId);
    return join(this.homeDirectoryResolver.resolve(), 'runs', runId);
  }

  statePath(runId: string): string {
    return join(this.runDirectory(runId), 'state.json');
  }

  appendJsonLine(runId: string, event: Record<string, unknown>): void {
    const directory = this.runDirectory(runId);
    this.fileOperations.mkdirSync(directory, { recursive: true });
    this.fileOperations.appendFileSync(
      join(directory, 'events.jsonl'),
      `${JSON.stringify(event)}\n`,
      'utf8',
    );
  }

  private requiredState(runId: string): RunState {
    const state = this.findState(runId);
    if (!state) {
      throw new RunStateError(`Run not found: ${runId}`);
    }
    return state;
  }

  private writeAtomically(state: RunState): void {
    const target = this.statePath(state.id);
    const temporary = join(
      this.runDirectory(state.id),
      `.state.${process.pid}.${Date.now()}.tmp`,
    );
    try {
      this.fileOperations.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
      this.fileOperations.renameSync(temporary, target);
    } finally {
      if (this.fileOperations.existsSync(temporary)) {
        this.fileOperations.rmSync(temporary, { force: true });
      }
    }
  }
}
