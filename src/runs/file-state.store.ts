import { Inject, Injectable } from '@nestjs/common';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
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
  readonly readFileSync: typeof readFileSync;
  readonly renameSync: typeof renameSync;
  readonly rmSync: typeof rmSync;
  readonly writeFileSync: typeof writeFileSync;
  readonly appendFileSync: typeof appendFileSync;
}

const nativeFileOperations: StateFileOperations = {
  existsSync,
  mkdirSync,
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
    const steps = state.steps.map((step, index) => index === stepIndex
      ? {
          ...step,
          status: 'complete' as const,
          output: { ...completion.output, completedAt },
        }
      : step);
    this.save({ ...state, steps, updatedAt: completedAt });
  }

  appendEvent(runId: string, event: CompletionEvent): void {
    this.appendJsonLine(runId, { ...event });
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
