import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { normalize as normalizePath } from 'node:path';
import { EventLogService } from './event-log.service';
import { FileStateStore, RunStateError } from './file-state.store';
import { RunLockService } from './run-lock.service';
import { createRunState, type RunState } from './run-state.schema';
import {
  WorkflowError,
  WorkflowRegistryService,
} from '../workflows/workflow-registry.service';
import { ConfigService } from '../config/config.service';
import { AgentProfileService } from '../agents/agent-profile.service';
import { CapabilityResolverService } from '../agents/capability-resolver.service';
import { ArtifactService } from '../documentation/artifact.service';
import {
  type ExpandedWorkflowStep,
  WorkflowExpanderService,
} from '../workflows/workflow-expander.service';
import { resolveRootParameters } from '../workflows/workflow-parameters';

export interface StartRunRequest {
  readonly id?: string;
  readonly workflowId: string;
  readonly request: string;
  readonly roles: Readonly<Record<string, string>>;
  readonly parameters?: Readonly<Record<string, string>>;
  readonly feature: {
    readonly id: string;
    readonly slug: string;
  };
  readonly repositoryDirectory?: string;
}

export const RUN_CLOCK = Symbol('RUN_CLOCK');

export function workflowActors(steps: readonly ExpandedWorkflowStep[]): string[] {
  return [...new Set(steps.flatMap((step) => {
    const needsActor = step.type === 'agent'
      || (step.type === 'host-handoff' && 'capability' in step);
    if (!needsActor) {
      return [];
    }
    if (!step.actor) {
      throw new RunStateError(`Workflow step ${step.id} requires an actor`);
    }
    return [step.actor];
  }))];
}

@Injectable()
export class RunService {
  constructor(
    @Inject(FileStateStore)
    private readonly stateStore: FileStateStore,
    @Inject(EventLogService)
    private readonly eventLog: EventLogService,
    @Inject(RunLockService)
    private readonly locks: RunLockService,
    @Inject(WorkflowRegistryService)
    private readonly workflowRegistry: WorkflowRegistryService,
    @Inject(WorkflowExpanderService)
    private readonly workflowExpander: WorkflowExpanderService,
    @Inject(ConfigService)
    private readonly configService: ConfigService,
    @Inject(AgentProfileService)
    private readonly agentProfiles: AgentProfileService,
    @Inject(CapabilityResolverService)
    private readonly capabilities: CapabilityResolverService,
    @Inject(ArtifactService)
    private readonly artifacts: ArtifactService,
    @Inject(RUN_CLOCK)
    private readonly now: () => Date = () => new Date(),
  ) {}

  start(request: StartRunRequest): RunState {
    this.validateFeature(request.feature);
    const workRequest = this.validateRequest(request.request);
    const id = request.id ?? `run-${randomUUID()}`;
    const timestamp = this.now().toISOString();
    const repositoryDirectory = realpathSync(request.repositoryDirectory ?? process.cwd());
    const configuration = this.configService.load(repositoryDirectory);
    const resolvedWorkflow = this.workflowRegistry.resolve(
      request.workflowId,
      repositoryDirectory,
    );
    const parameters = resolveRootParameters(resolvedWorkflow.workflow.parameters, request.parameters ?? {});
    const expanded = this.workflowExpander.expand(resolvedWorkflow, repositoryDirectory, parameters);
    const steps = expanded.steps;
    const documentation: RunState['documentation'] = {
      target: configuration.documentation.target,
      featurePath: configuration.documentation.featurePath,
      bindings: {
        project: configuration.project,
        feature: request.feature,
        run: { id },
      },
    };
    this.validateArtifactDestinations(id, steps, documentation);
    const actors = workflowActors(steps);
    const resolvedActors = this.agentProfiles.resolveForActors(
      request.roles,
      actors,
      configuration.agentProfiles,
    );
    const state = createRunState({
      ...request,
      request: workRequest,
      repositoryDirectory,
      id,
      now: timestamp,
      documentation,
      execution: configuration.execution,
      workflowSha256: resolvedWorkflow.sha256,
      workflowDefinitions: expanded.definitions,
      resolvedActors,
      parameters,
      steps: steps.map((step) => ({
        id: step.id,
        kind: step.type,
        ...(step.type === 'agent'
          ? {
              actor: step.actor,
              ...('capability' in step
                ? {
                    method: this.resolveCapabilityForActor(
                      step.capability,
                      step.actor,
                      resolvedActors,
                    ),
                  }
                : {
                    promptFile: step.promptFile,
                    prompt: this.workflowRegistry.readPromptFile(
                      step.definition,
                      step.promptFile,
                    ),
              }),
              output: step.output,
              executionAuthorization: step.executionAuthorization,
              effectiveParameters: step.effectiveParameters,
              ...(step.result ? { result: step.result } : {}),
              ...(step.when ? { when: step.when } : {}),
              ...(step.cycle ? { cycle: step.cycle } : {}),
              ...(step.verdictPolicy ? { verdictPolicy: step.verdictPolicy } : {}),
              ...(step.patch ? { patch: step.patch } : {}),
            }
          : step.type === 'host-handoff'
            ? ('capability' in step
              ? {
                  actor: step.actor,
                  method: this.resolveCapabilityForActor(
                    step.capability,
                    step.actor,
                    resolvedActors,
                  ),
                  interaction: step.interaction,
                  inputs: step.inputs,
                  output: step.output,
                  sideEffects: step.sideEffects,
                }
              : {
                  promptFile: step.promptFile,
                  prompt: this.workflowRegistry.readPromptFile(step.definition, step.promptFile),
                  inputs: step.inputs,
                  output: step.output,
                  sideEffects: step.sideEffects,
                })
            : { artifact: step.artifact }),
      })),
    });
    const release = this.locks.acquire(id, 'start');
    try {
      this.stateStore.create(state);
      this.eventLog.append(id, {
        type: 'run.started',
        at: timestamp,
        workflowId: state.workflow.id,
        workflowSha256: state.workflow.sha256,
        workflowDefinitions: state.workflow.definitions,
        workflowSource: resolvedWorkflow.source,
        documentationTarget: state.documentation.target.name,
        repositoryDirectory: state.repositoryDirectory,
        roles: state.roles,
        parameters: state.parameters,
        resolvedActors: state.resolvedActors,
      });
    } finally {
      release();
    }
    return state;
  }

  status(runId: string): RunState {
    const state = this.stateStore.findState(runId);
    if (!state) {
      throw new RunStateError(`Run not found: ${runId}`);
    }
    return state;
  }

  private resolveCapabilityForActor(
    capability: string,
    actor: string,
    resolvedActors: RunState['resolvedActors'],
  ) {
    const frozenActor = resolvedActors[actor];
    if (!frozenActor) {
      throw new RunStateError(`Agent profile is not frozen for actor ${actor}`);
    }
    // AgentProfileService freezes the exact role binding in `profile`; resolve
    // from that immutable run snapshot rather than the mutable start request.
    return this.capabilities.resolve(capability, actor, frozenActor);
  }

  private validateFeature(feature: StartRunRequest['feature']): void {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(feature.id)) {
      throw new RunStateError('Feature ID must contain only letters, numbers, dots, underscores or hyphens');
    }
    if (!/^[a-z0-9]+(?:[-_][a-z0-9]+)*$/.test(feature.slug)) {
      throw new RunStateError('Feature slug must use lowercase letters, numbers, hyphens or underscores');
    }
  }

  private validateRequest(request: string): string {
    const normalized = request.trim();
    if (!normalized) {
      throw new RunStateError('Work request must not be empty');
    }
    if (normalized.length > 20_000) {
      throw new RunStateError('Work request must not exceed 20000 characters');
    }
    return normalized;
  }

  private validateArtifactDestinations(
    runId: string,
    steps: readonly ExpandedWorkflowStep[],
    documentation: RunState['documentation'],
  ): void {
    const destinations = new Map<string, { readonly stepId: string; readonly outputId: string }>();
    for (const step of steps) {
      if (step.type !== 'agent' && step.type !== 'host-handoff') continue;
      const destinationPath = step.output.storage === 'internal'
        ? this.artifacts.resolveInternalOutputPath(this.stateStore.runDirectory(runId), step.output)
        : this.artifacts.resolveOutputPath({
            target: documentation.target,
            featurePath: documentation.featurePath,
            bindings: documentation.bindings,
            output: step.output,
          });
      const destinationKey = normalizePath(destinationPath).normalize('NFC').toLowerCase();
      const previous = destinations.get(destinationKey);
      if (previous && previous.outputId !== step.output.id) {
        throw new WorkflowError(
          `Artifact destination collision at "${destinationPath}": step "${previous.stepId}" output "${previous.outputId}" and step "${step.id}" output "${step.output.id}"`,
        );
      }
      destinations.set(destinationKey, { stepId: step.id, outputId: step.output.id });
    }
  }
}
