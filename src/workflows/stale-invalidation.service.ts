import { Inject, Injectable } from '@nestjs/common';
import { ArtifactService } from '../documentation/artifact.service';
import { EventLogService } from '../runs/event-log.service';
import { FileStateStore, RunStateError } from '../runs/file-state.store';
import type { RunState } from '../runs/run-state.schema';
import { invalidateFrom } from '../runs/step-invalidation';
import { isVerdictHalted } from './verdict-completion.policy';

type AgentRunStep = Extract<RunState['steps'][number], { readonly kind: 'agent' }>;

export const GATE_CLOCK = Symbol('GATE_CLOCK');

export class ApprovalIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApprovalIntegrityError';
  }
}

@Injectable()
export class StaleInvalidationService {
  constructor(
    @Inject(FileStateStore) private readonly stateStore: FileStateStore,
    @Inject(EventLogService) private readonly eventLog: EventLogService,
    @Inject(ArtifactService) private readonly artifacts: ArtifactService,
    @Inject(GATE_CLOCK) private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * Rechecks every already approved artifact. A divergent file makes the
   * approval unusable, stales its producer and all completed successors, then
   * stops the command that discovered the problem.
   */
  preflightApprovedArtifacts(runId: string, state: RunState): RunState {
    for (const gate of state.steps) {
      if (gate.kind !== 'gate' || gate.status !== 'complete' || !gate.approval) {
        continue;
      }
      const producer = this.producerForArtifact(state, gate.artifact);
      let currentHash: string | undefined;
      try {
        currentHash = this.artifacts.currentHash(producer.output, state.documentation.target.root);
      } catch {
        // A missing, empty or unsafe file is just as invalid as a hash mismatch.
      }
      if (currentHash === gate.approval.approvedArtifactHash) {
        continue;
      }

      const invalidated = this.invalidateFrom(state, producer.id, 'approved-artifact-changed');
      const steps = invalidated.steps.map((step) => step.id === gate.id
        ? { ...step, status: 'stale' as const, approval: undefined }
        : step);
      const next = this.withTimestamp({ ...invalidated, steps });
      this.stateStore.save(next);
      this.eventLog.append(runId, {
        type: 'approval.invalidated',
        at: this.now().toISOString(),
        gateId: gate.id,
        artifactId: gate.artifact,
        reason: 'approved-artifact-changed',
      });
      throw new ApprovalIntegrityError(
        `Approved artifact ${gate.artifact} changed; ${producer.id} and its successors are stale`,
      );
    }
    return state;
  }

  /** Mark a producer pending and stale only completed/in-progress downstream work. */
  requestChanges(runId: string, state: RunState, gateId: string, comment: string): RunState {
    const gate = state.steps.find((step) => step.id === gateId);
    if (!gate || gate.kind !== 'gate') {
      throw new RunStateError(`Step ${gateId} is not a human gate`);
    }
    if (gate.status === 'stale') {
      throw new RunStateError(`Gate ${gateId} is stale and cannot receive request-changes`);
    }
    const producer = this.producerForArtifact(state, gate.artifact);
    const invalidated = this.invalidateFrom(state, producer.id, 'request-changes', producer.id);
    const timestamp = this.now().toISOString();
    const steps = invalidated.steps.map((step) => {
      if (step.id === producer.id && step.kind === 'agent') {
        return {
          ...step,
          status: 'pending' as const,
          output: undefined,
          approval: undefined,
          inputArtifactHashes: undefined,
          dispatchPreparedAt: undefined,
          reviewOutcome: undefined,
          result: undefined,
          conditionDecision: undefined,
        };
      }
      if (step.id === gate.id && step.kind === 'gate') {
        return {
          ...step,
          status: 'pending' as const,
          approval: undefined,
          feedback: [...step.feedback, { requestedAt: timestamp, comment }],
        };
      }
      return step;
    });
    const next = this.withTimestamp({
      ...invalidated,
      currentStepId: invalidated.currentStepId === producer.id
        ? undefined
        : invalidated.currentStepId,
      steps,
    });
    this.stateStore.save(next);
    this.eventLog.append(runId, {
      type: 'gate.changes_requested',
      at: timestamp,
      gateId,
      producerStepId: producer.id,
      comment,
    });
    return next;
  }

  retry(runId: string, state: RunState, stepId: string): RunState {
    const step = state.steps.find((candidate) => candidate.id === stepId);
    if (!step || step.kind !== 'agent') {
      throw new RunStateError(`Step ${stepId} is not an agent step`);
    }
    const verdictHalted = isVerdictHalted(step);
    if (step.status !== 'stale' && step.status !== 'failed' && !verdictHalted) {
      throw new RunStateError(`Step ${stepId} can only be retried when stale, failed or halted on a verdict`);
    }
    if (step.declaredOutput.storage === 'internal' && step.expectedOutput) {
      this.artifacts.discardOutput(step.expectedOutput);
    }
    const timestamp = this.now().toISOString();
    const steps = state.steps.map((candidate) => candidate.id === stepId && candidate.kind === 'agent'
      ? {
          ...candidate,
          status: 'pending' as const,
          output: undefined,
          approval: undefined,
          inputArtifactHashes: undefined,
          dispatchPreparedAt: undefined,
          reviewOutcome: undefined,
          result: undefined,
          conditionDecision: undefined,
          retryContext: undefined,
          acknowledgment: undefined,
        }
      : candidate);
    const next = this.withTimestamp({
      ...state,
      currentStepId: state.currentStepId === stepId ? undefined : state.currentStepId,
      steps,
    });
    this.stateStore.save(next);
    this.eventLog.append(runId, { type: 'step.retry_requested', at: timestamp, stepId });
    return next;
  }

  acknowledge(runId: string, state: RunState, stepId: string, comment: string): RunState {
    const step = state.steps.find((candidate) => candidate.id === stepId);
    if (!step || step.kind !== 'agent' || !isVerdictHalted(step)) {
      throw new RunStateError(`Step ${stepId} has no unacknowledged halted verdict`);
    }
    const timestamp = this.now().toISOString();
    const steps = state.steps.map((candidate) => candidate.id === stepId && candidate.kind === 'agent'
      ? { ...candidate, acknowledgment: { at: timestamp, comment } }
      : candidate);
    const next = this.withTimestamp({ ...state, steps });
    this.stateStore.save(next);
    this.eventLog.append(runId, { type: 'verdict.acknowledged', at: timestamp, stepId, comment });
    return next;
  }

  /**
   * A stale gate has no work of its own. In V0's ordered workflow it can be
   * reopened once every preceding step was rebuilt and completed. Its prior
   * approval is intentionally not restored: the human must approve again.
   */
  reopenGateIfReady(runId: string, state: RunState, gateId: string): RunState | undefined {
    const gateIndex = state.steps.findIndex((step) => step.id === gateId);
    const gate = state.steps[gateIndex];
    if (!gate || gate.kind !== 'gate' || gate.status !== 'stale') {
      return undefined;
    }
    if (state.steps.slice(0, gateIndex).some((step) => step.status !== 'complete' && step.status !== 'skipped')) {
      return undefined;
    }
    const timestamp = this.now().toISOString();
    const steps = state.steps.map((step) => step.id === gateId
      ? { ...step, status: 'pending' as const, approval: undefined }
      : step);
    const next = this.withTimestamp({ ...state, steps });
    this.stateStore.save(next);
    this.eventLog.append(runId, { type: 'gate.reopened', at: timestamp, gateId });
    return next;
  }

  approve(runId: string, state: RunState, gateId: string, comment?: string): RunState {
    const gate = state.steps.find((step) => step.id === gateId);
    if (!gate || gate.kind !== 'gate') {
      throw new RunStateError(`Step ${gateId} is not a human gate`);
    }
    if (gate.status !== 'pending') {
      throw new RunStateError(`Gate ${gateId} must be pending before approval`);
    }
    const gateIndex = state.steps.findIndex((step) => step.id === gateId);
    if (state.steps.slice(0, gateIndex).some((step) => step.status !== 'complete' && step.status !== 'skipped')) {
      throw new RunStateError(`Gate ${gateId} has incomplete prerequisite steps`);
    }
    const producer = this.producerForArtifact(state, gate.artifact);
    const currentHash = this.artifacts.currentHash(producer.output, state.documentation.target.root);
    const outdatedConsumers = this.consumersWithOutdatedInput(state, producer.declaredOutput.id, currentHash);
    if (outdatedConsumers.length > 0) {
      const invalidated = outdatedConsumers.reduce(
        (current, consumer) => this.invalidateFrom(current, consumer.id, 'input-artifact-changed'),
        state,
      );
      const next = this.withTimestamp(invalidated);
      this.stateStore.save(next);
      this.eventLog.append(runId, {
        type: 'artifact.input.invalidated',
        at: this.now().toISOString(),
        artifactId: producer.declaredOutput.id,
        consumerStepIds: outdatedConsumers.map((step) => step.id),
      });
      throw new ApprovalIntegrityError(
        `Artifact ${producer.declaredOutput.id} changed after a consuming step completed; retry ${outdatedConsumers.map((step) => step.id).join(', ')}`,
      );
    }
    const timestamp = this.now().toISOString();
    if (producer.output.sha256 !== currentHash) {
      this.eventLog.append(runId, {
        type: 'artifact.hash.refreshed-before-approval', at: timestamp,
        artifactId: producer.declaredOutput.id, previousHash: producer.output.sha256, currentHash,
      });
    }
    const steps = state.steps.map((step) => {
      if (step.id === producer.id && step.kind === 'agent' && step.output) {
        return { ...step, output: { ...step.output, sha256: currentHash } };
      }
      if (step.id === gateId && step.kind === 'gate') {
        return {
          ...step,
          status: 'complete' as const,
          approval: {
            approvedArtifactHash: currentHash,
            approvedAt: timestamp,
            ...(comment ? { comment } : {}),
          },
        };
      }
      return step;
    });
    const next = this.withTimestamp({ ...state, steps });
    this.stateStore.save(next);
    this.eventLog.append(runId, {
      type: 'gate.approved', at: timestamp, gateId, artifactId: gate.artifact, artifactHash: currentHash,
      ...(comment ? { comment } : {}),
    });
    return next;
  }

  /** Uses the state-frozen direct successor table; it is not a workflow graph DSL. */
  invalidateFrom(
    state: RunState,
    sourceStepId: string,
    _reason: string,
    preservePendingStepId?: string,
  ): RunState {
    return invalidateFrom(state, sourceStepId, preservePendingStepId);
  }

  private consumersWithOutdatedInput(
    state: RunState,
    artifactId: string,
    currentHash: string,
  ): AgentRunStep[] {
    return state.steps.filter((step, index): step is AgentRunStep => step.kind === 'agent'
      && step.status === 'complete'
      && step.inputArtifactHashes?.[artifactId] !== undefined
      && step.inputArtifactHashes[artifactId] !== currentHash
      && step.declaredOutput.id !== artifactId
      // A later consolidation of the same canonical artifact supersedes this
      // consumer. Only the final review of a bounded cycle can block approval.
      && !state.steps.slice(index + 1).some((later) => later.kind === 'agent'
        && later.status === 'complete'
        && later.declaredOutput.id === artifactId
        && Boolean(later.output)));
  }

  private producerForArtifact(state: RunState, artifactId: string): AgentRunStep & { output: NonNullable<AgentRunStep['output']> } {
    const producer = state.steps.findLast((step): step is AgentRunStep => step.kind === 'agent'
      && step.declaredOutput.id === artifactId && step.status === 'complete' && Boolean(step.output));
    if (!producer || !producer.output) {
      throw new RunStateError(`Artifact ${artifactId} has no completed producer output`);
    }
    return producer as AgentRunStep & { output: NonNullable<AgentRunStep['output']> };
  }

  private withTimestamp(state: RunState): RunState {
    return { ...state, updatedAt: this.now().toISOString() };
  }
}
