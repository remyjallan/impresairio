import { Inject, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { EventLogService } from '../runs/event-log.service';
import { FileStateStore, RunStateError } from '../runs/file-state.store';
import type { RunState } from '../runs/run-state.schema';
import { parseImplementationPhaseManifest } from './implementation-phase-manifest';

/** Expands a previously approved data manifest into a fixed serial run sequence. */
@Injectable()
export class ImplementationPhaseMaterializerService {
  constructor(
    @Inject(FileStateStore) private readonly states: FileStateStore,
    @Inject(EventLogService) private readonly events: EventLogService,
  ) {}

  materialize(runId: string, stepId: string, now = new Date().toISOString()): RunState {
    const state = this.states.findState(runId);
    if (!state) throw new RunStateError(`Run not found: ${runId}`);
    const index = state.steps.findIndex((step) => step.id === stepId);
    const placeholder = state.steps[index];
    if (!placeholder || placeholder.kind !== 'phase-manifest') {
      throw new RunStateError(`Step ${stepId} is not an implementation phase placeholder`);
    }
    if (placeholder.status === 'complete') {
      const generated = placeholder.generatedStepIds ?? [];
      if (generated.length === 0 || generated.some((id) => !state.steps.some((step) => step.id === id))) {
        throw new RunStateError(`Materialized implementation phase placeholder ${stepId} has an inconsistent generated sequence`);
      }
      return state;
    }
    if (placeholder.status !== 'pending') {
      throw new RunStateError(`Implementation phase placeholder ${stepId} is ${placeholder.status}`);
    }
    const sourceGate = state.steps.slice(0, index).find((step) => (
      step.kind === 'gate' && step.artifact === placeholder.artifact && step.status === 'complete' && step.approval
    ));
    if (!sourceGate) {
      throw new RunStateError(`Implementation phase manifest ${placeholder.artifact} must be approved before materialization`);
    }
    const source = state.steps.slice(0, index)
      .filter((step): step is Extract<RunState['steps'][number], { readonly kind: 'agent' | 'host-handoff' }> => (
        step.kind === 'agent' || step.kind === 'host-handoff'
      ))
      .find((step) => step.declaredOutput.id === placeholder.artifact && step.status === 'complete' && step.output);
    if (!source?.output) {
      throw new RunStateError(`Approved implementation phase manifest artifact ${placeholder.artifact} is unavailable`);
    }
    let markdown: string;
    try {
      markdown = readFileSync(source.output.path, 'utf8');
    } catch {
      throw new RunStateError(`Approved implementation phase manifest artifact ${placeholder.artifact} cannot be read`);
    }
    const manifest = parseImplementationPhaseManifest(markdown);
    const manifestSha256 = createHash('sha256').update(markdown).digest('hex');
    const generated = manifest.phases.flatMap((phase) => {
      const implementationId = `${placeholder.id}--${phase.id}`;
      const implementation = {
        id: implementationId,
        kind: 'agent' as const,
        status: 'pending' as const,
        actor: placeholder.actor,
        executionAuthorization: 'explicit' as const,
        method: placeholder.method,
        declaredOutput: {
          id: implementationId,
          filename: `.phase-${placeholder.id}-${phase.id}.patch.md`,
          storage: 'internal' as const,
        },
        phase,
        patch: 'apply-unified-diff' as const,
        attempts: [],
      };
      const review = placeholder.reviewer && placeholder.reviewMethod ? [{
        id: `${implementationId}--review`,
        kind: 'agent' as const,
        status: 'pending' as const,
        actor: placeholder.reviewer,
        executionAuthorization: 'explicit' as const,
        method: placeholder.reviewMethod,
        declaredOutput: {
          id: `${implementationId}--review`,
          filename: `.phase-${placeholder.id}-${phase.id}.review.md`,
          storage: 'internal' as const,
        },
        phase,
        verdictPolicy: {
          ...(phase.retryBudget > 0
            ? { changesRequested: { retryFrom: implementationId, maxIterations: phase.retryBudget } }
            : {}),
          blocked: 'stop' as const,
        },
        attempts: [],
      }] : [];
      const gate = phase.gate ? [{
        id: `${implementationId}--approve`,
        kind: 'gate' as const,
        status: 'pending' as const,
        artifact: review.length > 0 ? review[0].declaredOutput.id : implementation.declaredOutput.id,
        feedback: [],
      }] : [];
      return [implementation, ...review, ...gate];
    });
    const steps = [
      ...state.steps.slice(0, index),
      { ...placeholder, status: 'complete' as const, manifestSha256, materializedAt: now, generatedStepIds: generated.map((step) => step.id) },
      ...generated,
      ...state.steps.slice(index + 1),
    ];
    const next = {
      ...state,
      workflow: {
        ...state.workflow,
        successors: Object.fromEntries(steps.map((step, offset) => [
          step.id,
          offset + 1 < steps.length ? [steps[offset + 1].id] : [],
        ])),
      },
      steps,
      updatedAt: now,
    };
    this.states.save(next);
    this.events.append(runId, {
      type: 'phase-manifest.materialized', at: now, stepId,
      artifact: placeholder.artifact, manifestSha256, generatedStepIds: generated.map((step) => step.id),
    });
    return next;
  }
}
