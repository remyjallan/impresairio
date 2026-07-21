import { readFileSync } from 'node:fs';
import { Injectable } from '@nestjs/common';
import type { CompletedDocumentationOutput } from '../documentation/documentation-target';
import type { CompletionPolicy, CompletionPolicyResult } from '../runs/completion.service';
import { FileStateStore, RunStateError } from '../runs/file-state.store';
import type { RunState } from '../runs/run-state.schema';

type RunStep = RunState['steps'][number];
type AgentRunStep = Extract<RunStep, { readonly kind: 'agent' }>;

const verdictPattern = /(?:^|\n)VERDICT:\s*(APPROVED|CHANGES_REQUESTED|BLOCKED)\s*$/i;

function readVerdict(stepId: string, path: string): 'APPROVED' | 'CHANGES_REQUESTED' | 'BLOCKED' {
  const verdict = verdictPattern.exec(readFileSync(path, 'utf8'))?.[1]?.toUpperCase();
  if (verdict !== 'APPROVED' && verdict !== 'CHANGES_REQUESTED' && verdict !== 'BLOCKED') {
    throw new RunStateError(`Review ${stepId} must end with VERDICT: APPROVED, CHANGES_REQUESTED or BLOCKED`);
  }
  return verdict;
}

/** A completed policy step whose negative verdict still awaits a human decision. */
export function isVerdictHalted(step: RunStep): step is AgentRunStep {
  return step.kind === 'agent'
    && step.verdictPolicy !== undefined
    && step.status === 'complete'
    && step.reviewOutcome !== undefined
    && step.acknowledgment === undefined
    && (step.reviewOutcome.verdict === 'BLOCKED' || step.reviewOutcome.exhausted);
}

@Injectable()
export class VerdictCompletionPolicy implements CompletionPolicy {
  constructor(private readonly stateStore: FileStateStore) {}

  evaluate(runId: string, stepId: string, output: CompletedDocumentationOutput): CompletionPolicyResult {
    const state = this.stateStore.findState(runId);
    if (!state) throw new RunStateError(`Run not found: ${runId}`);
    const index = state.steps.findIndex((step) => step.id === stepId);
    const step = state.steps[index];
    if (!step || step.kind !== 'agent') return { skipStepIds: [] };

    if (step.verdictPolicy) {
      return this.evaluatePolicyStep(step, output);
    }
    if (step.cycle?.role === 'review') {
      return this.evaluateCycleReview(state, index, step, output);
    }
    return { skipStepIds: [] };
  }

  private evaluatePolicyStep(step: AgentRunStep, output: CompletedDocumentationOutput): CompletionPolicyResult {
    const verdict = readVerdict(step.id, output.path);
    if (verdict === 'APPROVED') {
      return {
        skipStepIds: [], source: 'policy',
        reviewOutcome: { verdict, exhausted: false },
        transition: { kind: 'continue' },
      };
    }
    if (verdict === 'BLOCKED') {
      return {
        skipStepIds: [], source: 'policy',
        reviewOutcome: { verdict, exhausted: false },
        transition: { kind: 'halt' },
      };
    }
    const budget = step.verdictPolicy?.changesRequested;
    const used = step.verdictRetries ?? 0;
    if (!budget || used >= budget.maxIterations) {
      return {
        skipStepIds: [], source: 'policy',
        reviewOutcome: { verdict, exhausted: true },
        transition: { kind: 'halt' },
      };
    }
    return {
      skipStepIds: [], source: 'policy',
      reviewOutcome: { verdict, exhausted: false },
      transition: { kind: 'retry-from', targetStepId: budget.retryFrom },
    };
  }

  private evaluateCycleReview(
    state: RunState,
    index: number,
    step: AgentRunStep,
    output: CompletedDocumentationOutput,
  ): CompletionPolicyResult {
    const verdict = readVerdict(step.id, output.path);
    const laterCycleSteps = state.steps.slice(index + 1)
      .filter((candidate) => candidate.kind === 'agent'
        && candidate.cycle?.id === step.cycle?.id
        && candidate.status === 'pending');
    if (verdict === 'CHANGES_REQUESTED') {
      return {
        skipStepIds: [], source: 'cycle', transition: { kind: 'continue' },
        reviewOutcome: {
          verdict,
          exhausted: !laterCycleSteps.some((candidate) => candidate.kind === 'agent' && candidate.cycle?.role === 'consolidate'),
        },
      };
    }
    return {
      skipStepIds: laterCycleSteps.map((candidate) => candidate.id),
      source: 'cycle', transition: { kind: 'continue' },
      reviewOutcome: { verdict, exhausted: false },
    };
  }
}

/** Warnings for unresolved verdicts: exhausted or blocked cycles, and halted policy steps. */
export function verdictWarnings(state: RunState, gateStepId?: string): readonly string[] {
  return [...cycleWarnings(state, gateStepId), ...(gateStepId ? [] : policyHaltWarnings(state))];
}

function cycleWarnings(state: RunState, gateStepId?: string): readonly string[] {
  let startIndex = 0;
  let endIndex = state.steps.length;
  if (gateStepId) {
    const gateIndex = state.steps.findIndex((step) => step.id === gateStepId && step.kind === 'gate');
    if (gateIndex < 0) return [];
    startIndex = gateIndex - 1;
    while (startIndex >= 0 && state.steps[startIndex].kind !== 'gate') startIndex -= 1;
    startIndex += 1;
    endIndex = gateIndex;
  }
  return state.steps.slice(startIndex, endIndex).flatMap((step, offset) => {
    if (step.kind !== 'agent' || step.status !== 'complete' || step.cycle?.role !== 'review'
      || (!step.reviewOutcome?.exhausted && step.reviewOutcome?.verdict !== 'BLOCKED')) return [];
    if (!gateStepId) {
      const stepIndex = startIndex + offset;
      const followingGate = state.steps.slice(stepIndex + 1).find((candidate) => candidate.kind === 'gate');
      if (!followingGate || followingGate.status === 'complete') return [];
    }
    const artifact = step.output?.path ? `; review artifact: ${step.output.path}` : '';
    const outcome = step.reviewOutcome.verdict === 'BLOCKED'
      ? `blocked at iteration ${step.cycle.iteration} with VERDICT: BLOCKED`
      : `exhausted at iteration ${step.cycle.iteration} with VERDICT: CHANGES_REQUESTED`;
    return [`cycle ${step.cycle.id} ${outcome} (${step.id})${artifact}; human decision required`];
  });
}

function policyHaltWarnings(state: RunState): readonly string[] {
  return state.steps.filter(isVerdictHalted).map((step) => {
    const artifact = step.output?.path ? `; review artifact: ${step.output.path}` : '';
    const outcome = step.reviewOutcome?.verdict === 'BLOCKED'
      ? 'halted with VERDICT: BLOCKED'
      : `exhausted its ${step.verdictPolicy?.changesRequested?.maxIterations ?? 0} allowed retries with VERDICT: CHANGES_REQUESTED`;
    return `step ${step.id} ${outcome}${artifact}; acknowledge with a comment or retry the step`;
  });
}
