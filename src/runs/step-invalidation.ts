import type { RunState } from './run-state.schema';

/**
 * Marks the transitive successors of a source step stale (for completed or
 * in-progress work) or pending again (for previously skipped work). Pure
 * state transform shared by gate recovery and verdict-driven retries; the
 * caller persists the returned state.
 */
export function invalidateFrom(
  state: RunState,
  sourceStepId: string,
  preservePendingStepId?: string,
): RunState {
  const staleIds = new Set<string>();
  const visit = (stepId: string): void => {
    if (staleIds.has(stepId)) return;
    staleIds.add(stepId);
    for (const successor of state.workflow.successors[stepId] ?? []) {
      visit(successor);
    }
  };
  visit(sourceStepId);
  const steps = state.steps.map((step) => {
    if (!staleIds.has(step.id) || step.id === preservePendingStepId) {
      return step;
    }
    if (step.status === 'complete' || step.status === 'in_progress') {
      return step.kind === 'gate'
        ? { ...step, status: 'stale' as const, approval: undefined }
        : { ...step, status: 'stale' as const, approval: undefined, reviewOutcome: undefined };
    }
    if (step.status === 'skipped' && step.kind === 'agent') {
      return {
        ...step,
        status: 'pending' as const,
        output: undefined,
        inputArtifactHashes: undefined,
        dispatchPreparedAt: undefined,
        reviewOutcome: undefined,
      };
    }
    return step;
  });
  return { ...state, steps };
}
