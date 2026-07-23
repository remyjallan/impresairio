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
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { HomeDirectoryResolver } from '../config/home-directory.resolver';
import type {
  CompletionEvent,
  CompletionRecord,
  CompletionRun,
  CompletionRunStore,
  RetryFeedback,
} from './completion.service';
import { runStateSchema, type RunState } from './run-state.schema';
import { assertValidRunId } from './run-id';
import { invalidateFrom } from './step-invalidation';
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

/** Returns the largest valid UTF-8 prefix whose byte length does not exceed `limit`. */
function utf8Boundary(bytes: Buffer, limit: number): number {
  let boundary = Math.min(limit, bytes.length);
  while (boundary > 0 && (bytes[boundary] ?? 0) >> 6 === 0b10) {
    boundary -= 1;
  }
  return boundary;
}

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
      ...(state.repositoryDirectory ? { repositoryDirectory: state.repositoryDirectory } : {}),
      ...(state.repositoryPatch ? { repositoryPatch: state.repositoryPatch } : {}),
      currentStepId: state.currentStepId,
      successors: state.workflow.successors,
      steps: state.steps.map((step) => ({
        id: step.id,
        kind: step.kind,
        status: step.status,
        ...(step.kind === 'agent' && step.cycle ? { cycle: step.cycle } : {}),
        ...(step.kind === 'agent' && step.declaredResult ? { declaredResult: step.declaredResult } : {}),
        ...(step.kind === 'agent' || step.kind === 'host-handoff' ? { storage: step.declaredOutput.storage } : {}),
        ...(step.kind === 'agent' && step.patch ? { patch: step.patch } : {}),
        ...((step.kind === 'agent' || step.kind === 'host-handoff') && step.expectedOutput
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
      if (step.kind !== 'agent' && step.kind !== 'host-handoff') {
        throw new RunStateError(`Step ${completion.stepId} cannot produce an artifact`);
      }
      const lastAttempt = step.attempts.at(-1);
      if (!lastAttempt) {
        throw new RunStateError(`Step ${completion.stepId} has no recorded attempt`);
      }
      const completed = {
        ...step,
        status: 'complete' as const,
        output: { ...completion.output, completedAt },
        attempts: [
          ...step.attempts.slice(0, -1),
          {
            ...lastAttempt,
            completedAt,
            outputSha256: completion.output.sha256,
          },
        ],
      };
      return step.kind === 'agent'
        ? {
            ...completed,
            retryContext: undefined,
            ...(completion.reviewOutcome ? { reviewOutcome: completion.reviewOutcome } : {}),
            ...(completion.result ? { result: completion.result } : {}),
            ...(completion.appliedPatch ? { appliedPatch: completion.appliedPatch } : {}),
          }
        : completed;
    });
    const skipped = new Set(completion.skipStepIds ?? []);
    steps = steps.map((step) => skipped.has(step.id) && step.kind === 'agent' && step.status === 'pending'
      ? { ...step, status: 'skipped' as const }
      : step);
    this.save({
      ...state,
      ...(completion.repositoryPatch ? { repositoryPatch: completion.repositoryPatch } : {}),
      steps,
      updatedAt: completedAt,
    });
  }

  appendEvent(runId: string, event: CompletionEvent): void {
    this.appendJsonLine(runId, { ...event });
  }

  markFailed(runId: string, stepId: string, detail: string, rawOutput?: string): void {
    const state = this.requiredState(runId);
    const failedStep = state.steps.find((step) => step.id === stepId);
    if (!failedStep || (failedStep.kind !== 'agent' && failedStep.kind !== 'host-handoff') || failedStep.status !== 'in_progress') return;
    const timestamp = new Date().toISOString();
    const failureOutput = this.failedOutputFor(runId, failedStep, rawOutput, detail, timestamp);
    const steps = state.steps.map((step) => step.id === stepId && (step.kind === 'agent' || step.kind === 'host-handoff') && step.status === 'in_progress'
      ? step.kind === 'agent'
        ? { ...step, status: 'failed' as const, dispatchPreparedAt: undefined, ...(failureOutput ? { failedAgentOutput: failureOutput } : {}) }
        : { ...step, status: 'failed' as const, handoffPreparedAt: undefined }
      : step);
    this.save({ ...state, steps, updatedAt: timestamp });
    this.appendJsonLine(runId, {
      type: 'step.failed', at: timestamp, stepId,
      detail: detail.length > 1000 ? `${detail.slice(0, 997)}...` : detail,
    });
  }

  private failedOutputFor(
    runId: string,
    step: Extract<RunState['steps'][number], { readonly kind: 'agent' | 'host-handoff' }>,
    rawOutput: string | undefined,
    detail: string,
    timestamp: string,
  ) {
    if (step.kind !== 'agent' || !rawOutput?.trim()) return undefined;
    return this.preserveFailedAgentOutput(runId, step.id, step.attempts.at(-1)?.number ?? 1, rawOutput, detail, timestamp);
  }

  private preserveFailedAgentOutput(
    runId: string,
    stepId: string,
    attempt: number,
    rawOutput: string,
    diagnostic: string,
    at: string,
  ): { readonly artifactPath: string; readonly artifactSha256: string; readonly at: string; readonly diagnostic: string; readonly truncated: boolean } {
    const maximumBytes = 256 * 1024;
    const bytes = Buffer.from(rawOutput, 'utf8');
    const truncated = bytes.length > maximumBytes;
    const content = (truncated
      ? bytes.subarray(0, utf8Boundary(bytes, maximumBytes)).toString('utf8')
      : rawOutput).trimEnd();
    const stepHash = createHash('sha256').update(stepId).digest('hex');
    const directory = join(this.runDirectory(runId), 'failed-agent-output');
    const artifactPath = join(directory, `${stepHash}-${attempt}.md`);
    this.fileOperations.mkdirSync(directory, { recursive: true });
    this.fileOperations.writeFileSync(artifactPath, content, 'utf8');
    const boundedDiagnostic = diagnostic.length > 1_000
      ? `${diagnostic.slice(0, 997)}...`
      : diagnostic;
    return {
      artifactPath,
      artifactSha256: createHash('sha256').update(content).digest('hex'),
      at,
      diagnostic: boundedDiagnostic,
      truncated,
    };
  }

  /**
   * Copies the completed reviewer artifact outside the reusable agent-output
   * path. The original is deliberately discarded before the reviewer is run
   * again; this copy remains the durable context for the retried author.
   */
  preserveRetryFeedback(runId: string, policyStepId: string, output: { readonly path: string; readonly sha256: string }): RetryFeedback {
    const state = this.requiredState(runId);
    const policyStep = state.steps.find((step) => step.id === policyStepId);
    if (!policyStep || policyStep.kind !== 'agent') {
      throw new RunStateError(`Step ${policyStepId} is not an agent verdict step`);
    }
    const content = this.fileOperations.readFileSync(output.path, 'utf8');
    const actualSha256 = createHash('sha256').update(content).digest('hex');
    if (actualSha256 !== output.sha256) {
      throw new RunStateError(`Verdict artifact for step ${policyStepId} changed before retry feedback was preserved`);
    }
    const retryNumber = (policyStep.verdictRetries ?? 0) + 1;
    const stepHash = createHash('sha256').update(policyStepId).digest('hex');
    const directory = join(this.runDirectory(runId), 'retry-feedback');
    const artifactPath = join(directory, `${stepHash}-${retryNumber}.md`);
    this.fileOperations.mkdirSync(directory, { recursive: true });
    this.fileOperations.writeFileSync(artifactPath, content, 'utf8');
    const preservedContent = this.fileOperations.readFileSync(artifactPath, 'utf8');
    const preservedSha256 = createHash('sha256').update(preservedContent).digest('hex');
    if (preservedSha256 !== actualSha256) {
      this.fileOperations.rmSync(artifactPath, { force: true });
      throw new RunStateError(`Preserved retry feedback for step ${policyStepId} changed while it was being saved`);
    }
    return { sourceStepId: policyStepId, artifactPath, artifactSha256: actualSha256 };
  }

  /** Removes an uncommitted retry-feedback copy after completion state could not be saved. */
  discardRetryFeedback(runId: string, retryFeedback: RetryFeedback): void {
    const state = this.requiredState(runId);
    const policyStep = state.steps.find((step) => step.id === retryFeedback.sourceStepId);
    if (!policyStep || policyStep.kind !== 'agent') {
      throw new RunStateError(`Step ${retryFeedback.sourceStepId} is not an agent verdict step`);
    }
    const retryNumber = (policyStep.verdictRetries ?? 0) + 1;
    const stepHash = createHash('sha256').update(retryFeedback.sourceStepId).digest('hex');
    const expectedPath = join(this.runDirectory(runId), 'retry-feedback', `${stepHash}-${retryNumber}.md`);
    if (retryFeedback.artifactPath !== expectedPath) {
      throw new RunStateError(`Retry feedback for step ${retryFeedback.sourceStepId} is outside the run retry-feedback directory`);
    }
    this.fileOperations.rmSync(expectedPath, { force: true });
  }

  /** Reopens the retry target after a CHANGES_REQUESTED verdict and stales everything the target feeds, including the verdict step itself. */
  applyVerdictRetry(runId: string, policyStepId: string, targetStepId: string, retryFeedback: RetryFeedback): void {
    const state = this.requiredState(runId);
    const policyStep = state.steps.find((step) => step.id === policyStepId);
    if (!policyStep || policyStep.kind !== 'agent' || !policyStep.output) {
      throw new RunStateError(`Step ${policyStepId} has no completed verdict artifact`);
    }
    const target = state.steps.find((step) => step.id === targetStepId);
    if (!target || (target.kind !== 'agent' && target.kind !== 'host-handoff')) {
      throw new RunStateError(`Verdict retry target is not an agent or host-handoff step: ${targetStepId}`);
    }
    const timestamp = new Date().toISOString();
    const invalidated = invalidateFrom(state, targetStepId);
    const previousStatus = new Map(state.steps.map((step) => [step.id, step.status]));
    const steps = invalidated.steps.map((step) => {
      // Steps invalidated by the policy's own bounded loop are machine-reopened
      // work, not externally tampered artifacts: agent steps return to pending
      // so the loop can continue, while gates stay stale and reopen through the
      // existing prerequisite check.
      if (step.kind === 'agent' && step.status === 'stale' && previousStatus.get(step.id) !== 'stale' && step.id !== targetStepId) {
        return {
          ...step,
          status: 'pending' as const,
          output: undefined,
          inputArtifactHashes: undefined,
          dispatchPreparedAt: undefined,
          reviewOutcome: undefined,
          result: undefined,
          conditionDecision: undefined,
          ...(step.id === policyStepId ? { verdictRetries: (step.verdictRetries ?? 0) + 1 } : {}),
        };
      }
      if (step.id === targetStepId && (step.kind === 'agent' || step.kind === 'host-handoff')) {
        return {
          ...step,
          status: 'pending' as const,
          output: undefined,
          inputArtifactHashes: undefined,
          ...(step.kind === 'agent'
            ? { dispatchPreparedAt: undefined, result: undefined, conditionDecision: undefined }
            : { handoffPreparedAt: undefined }),
          retryContext: {
            sourceStepId: retryFeedback.sourceStepId,
            artifactPath: retryFeedback.artifactPath,
            artifactSha256: retryFeedback.artifactSha256,
            at: timestamp,
          },
        };
      }
      return step;
    });
    this.save({ ...invalidated, steps, currentStepId: undefined, updatedAt: timestamp });
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
