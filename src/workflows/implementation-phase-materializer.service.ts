import { Inject, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { EventLogService } from '../runs/event-log.service';
import { FileStateStore, RunStateError } from '../runs/file-state.store';
import { runStateSchema, type RunState } from '../runs/run-state.schema';
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
    if (placeholder.status !== 'pending' && placeholder.status !== 'complete') {
      throw new RunStateError(`Implementation phase placeholder ${stepId} is ${placeholder.status}`);
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
    const manifestSha256 = createHash('sha256').update(markdown).digest('hex');
    if (placeholder.status === 'complete') {
      const generated = placeholder.generatedStepIds ?? [];
      if (generated.length === 0 || generated.some((id) => !state.steps.some((step) => step.id === id))) {
        throw new RunStateError(`Materialized implementation phase placeholder ${stepId} has an inconsistent generated sequence`);
      }
      if (state.steps.some((step) => generated.includes(step.id) && step.status !== 'pending')) {
        throw new RunStateError(`Materialized implementation phase placeholder ${stepId} cannot be re-entered after a generated phase starts`);
      }
      if (placeholder.manifestSha256 !== manifestSha256) {
        throw new RunStateError(`Materialized implementation phase manifest ${placeholder.artifact} has changed`);
      }
      return state;
    }
    const sourceGate = state.steps.slice(0, index).find((step): step is Extract<RunState['steps'][number], { readonly kind: 'gate' }> => (
      step.kind === 'gate' && step.artifact === placeholder.artifact && step.status === 'complete' && step.approval !== undefined
    ));
    if (!sourceGate?.approval) {
      throw new RunStateError(`Implementation phase manifest ${placeholder.artifact} must be approved before materialization`);
    }
    if (sourceGate.approval.approvedArtifactHash !== manifestSha256
      || source.output.sha256 !== manifestSha256) {
      throw new RunStateError(`Approved implementation phase manifest artifact ${placeholder.artifact} has changed`);
    }
    const manifest = parseImplementationPhaseManifest(markdown);
    // The parser accepts dependencies only on earlier phases; this fixed serial sequence therefore honors each dependency.
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
      // Implementation emits a patch; only its configured reviewer emits a verdict and controls retries.
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
      // Gates address declared artifact IDs, which stale invalidation resolves to the producing completed step.
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
    const existingSuccessors = state.workflow.successors;
    const generatedStepIds = generated.map((step) => step.id);
    const successorOfPlaceholder = existingSuccessors[placeholder.id] ?? [];
    const materializedSuccessors = Object.fromEntries(generatedStepIds.map((generatedStepId, offset) => [
      generatedStepId,
      offset + 1 < generatedStepIds.length ? [generatedStepIds[offset + 1]] : successorOfPlaceholder,
    ]));
    const next = {
      ...state,
      workflow: {
        ...state.workflow,
        successors: {
          ...existingSuccessors,
          [placeholder.id]: [generatedStepIds[0]],
          ...materializedSuccessors,
        },
      },
      steps,
      updatedAt: now,
    };
    const validated = runStateSchema.parse(next);
    this.states.save(validated);
    this.events.append(runId, {
      type: 'phase-manifest.materialized', at: now, stepId,
      artifact: placeholder.artifact, manifestSha256, generatedStepIds,
    });
    return validated;
  }
}
