import { Inject, Injectable } from '@nestjs/common';
import { EventLogService } from '../runs/event-log.service';
import { FileStateStore, RunStateError } from '../runs/file-state.store';
import { RunLockService } from '../runs/run-lock.service';
import { assertRunActive, type RunState } from '../runs/run-state.schema';
import { agentSettingsForEvent } from './agent-provider';

type AgentStep = Extract<RunState['steps'][number], { readonly kind: 'agent' }>;
type FrozenAgent = NonNullable<AgentStep['agentOverride']>;

@Injectable()
export class AgentFallbackService {
  constructor(
    @Inject(FileStateStore) private readonly stateStore: FileStateStore,
    @Inject(EventLogService) private readonly events: EventLogService,
    @Inject(RunLockService) private readonly locks: RunLockService,
  ) {}

  select(runId: string, stepId: string, profileName: string, reason: string): void {
    const release = this.locks.acquire(runId, 'fallback');
    try {
      const state = this.stateStore.findState(runId);
      if (!state) throw new RunStateError(`Run not found: ${runId}`);
      assertRunActive(state);
      const step = state.steps.find((candidate) => candidate.id === stepId);
      if (!step || step.kind !== 'agent') {
        throw new RunStateError(`Step ${stepId} is not an agent step`);
      }
      if (step.status !== 'failed') {
        throw new RunStateError(`Step ${stepId} can only select a fallback after a provider failure`);
      }
      const resolvedActor = state.resolvedActors[step.actor];
      if (!resolvedActor) {
        throw new RunStateError(`Agent profile is not frozen for actor ${step.actor}`);
      }
      const fallback = resolvedActor.fallbacks?.find((candidate) => candidate.profile === profileName);
      if (!fallback) {
        const allowed = resolvedActor.fallbacks?.map((candidate) => candidate.profile) ?? [];
        throw new RunStateError(
          `Profile "${profileName}" is not a configured fallback for actor ${step.actor}; allowed fallbacks: ${allowed.join(', ') || 'none'}`,
        );
      }
      if (step.fallbackHistory?.some((entry) => entry.to.profile === fallback.profile)) {
        throw new RunStateError(`Fallback profile "${profileName}" was already used for step ${stepId}`);
      }

      const normalizedReason = reason.trim();
      if (!normalizedReason) throw new RunStateError('Fallback reason must not be empty');
      const { fallbacks, ...primary } = resolvedActor;
      void fallbacks;
      const from: FrozenAgent = step.agentOverride ?? primary;
      const timestamp = new Date().toISOString();
      const history = [...(step.fallbackHistory ?? []), {
        from,
        to: fallback,
        reason: normalizedReason,
        selectedAt: timestamp,
      }];
      const steps = state.steps.map((candidate) => candidate.id === stepId && candidate.kind === 'agent'
        ? {
            ...candidate,
            status: 'pending' as const,
            agentOverride: fallback,
            fallbackHistory: history,
            dispatchPreparedAt: undefined,
            inputArtifactHashes: undefined,
            output: undefined,
            result: undefined,
            reviewOutcome: undefined,
            conditionDecision: undefined,
            retryContext: undefined,
            acknowledgment: undefined,
          }
        : candidate);
      this.stateStore.save({
        ...state,
        currentStepId: state.currentStepId === stepId ? undefined : state.currentStepId,
        steps,
        updatedAt: timestamp,
      });
      this.events.append(runId, {
        type: 'agent.fallback.selected',
        at: timestamp,
        stepId,
        actor: step.actor,
        fromProfile: from.profile,
        fromProvider: from.provider,
        toProfile: fallback.profile,
        toProvider: fallback.provider,
        ...agentSettingsForEvent(fallback),
        reason: normalizedReason,
      });
    } finally {
      release();
    }
  }
}
