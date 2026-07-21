import { readFileSync } from 'node:fs';
import { Injectable } from '@nestjs/common';
import type { CompletedDocumentationOutput } from '../documentation/documentation-target';
import type { CompletionPolicy, CompletionPolicyResult } from '../runs/completion.service';
import { FileStateStore, RunStateError } from '../runs/file-state.store';
import type { RunState } from '../runs/run-state.schema';

@Injectable()
export class ReviewCycleCompletionPolicy implements CompletionPolicy {
  constructor(private readonly stateStore: FileStateStore) {}

  evaluate(runId: string, stepId: string, output: CompletedDocumentationOutput): CompletionPolicyResult {
    const state = this.stateStore.findState(runId);
    if (!state) throw new RunStateError(`Run not found: ${runId}`);
    const index = state.steps.findIndex((step) => step.id === stepId);
    const step = state.steps[index];
    if (!step || step.kind !== 'agent' || step.cycle?.role !== 'review') return { skipStepIds: [] };

    const verdict = /(?:^|\n)VERDICT:\s*(APPROVED|CHANGES_REQUESTED|BLOCKED)\s*$/i.exec(
      readFileSync(output.path, 'utf8'),
    )?.[1]?.toUpperCase();
    if (verdict !== 'APPROVED' && verdict !== 'CHANGES_REQUESTED' && verdict !== 'BLOCKED') {
      throw new RunStateError(`Review ${stepId} must end with VERDICT: APPROVED, CHANGES_REQUESTED or BLOCKED`);
    }
    const laterCycleSteps = state.steps.slice(index + 1)
      .filter((candidate) => candidate.kind === 'agent'
        && candidate.cycle?.id === step.cycle?.id
        && candidate.status === 'pending');
    if (verdict === 'CHANGES_REQUESTED') {
      return {
        skipStepIds: [],
        reviewOutcome: {
          verdict,
          exhausted: !laterCycleSteps.some((candidate) => candidate.kind === 'agent' && candidate.cycle?.role === 'consolidate'),
        },
      };
    }

    return {
      skipStepIds: laterCycleSteps.map((candidate) => candidate.id),
      reviewOutcome: { verdict, exhausted: false },
    };
  }
}

export function cycleReviewWarnings(state: RunState, gateStepId?: string): readonly string[] {
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
