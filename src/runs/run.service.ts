import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { EventLogService } from './event-log.service';
import { FileStateStore, RunStateError } from './file-state.store';
import { RunLockService } from './run-lock.service';
import { createRunState, type RunState } from './run-state.schema';
import { WorkflowRegistryService } from '../workflows/workflow-registry.service';
import { ConfigService } from '../config/config.service';
import { AgentProfileService } from '../agents/agent-profile.service';
import type { Workflow, WorkflowStep } from '../workflows/workflow.schema';

export interface StartRunRequest {
  readonly id?: string;
  readonly workflowId: string;
  readonly request: string;
  readonly roles: Readonly<Record<string, string>>;
  readonly feature: {
    readonly id: string;
    readonly slug: string;
  };
  readonly repositoryDirectory?: string;
}

export const RUN_CLOCK = Symbol('RUN_CLOCK');

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
    @Inject(ConfigService)
    private readonly configService: ConfigService,
    @Inject(AgentProfileService)
    private readonly agentProfiles: AgentProfileService,
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
    const steps = expandWorkflow(resolvedWorkflow.workflow);
    const actors = [...new Set(steps.flatMap((step) => (
      step.type === 'agent' ? [step.actor] : []
    )))];
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
      documentation: {
        target: configuration.documentation.target,
        featurePath: configuration.documentation.featurePath,
        bindings: {
          project: configuration.project,
          feature: request.feature,
          run: { id },
        },
      },
      execution: configuration.execution,
      workflowSha256: resolvedWorkflow.sha256,
      resolvedActors,
      steps: steps.map((step) => ({
        id: step.id,
        kind: step.type,
        ...(step.type === 'agent'
          ? {
              actor: step.actor,
              ...('action' in step
                ? { action: step.action }
                : {
                    promptFile: step.promptFile,
                    prompt: this.workflowRegistry.readPromptFile(
                      resolvedWorkflow,
                      step.promptFile,
                    ),
              }),
              output: step.output,
              ...(step.cycle ? { cycle: step.cycle } : {}),
            }
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
        workflowSource: resolvedWorkflow.source,
        documentationTarget: state.documentation.target.name,
        repositoryDirectory: state.repositoryDirectory,
        roles: state.roles,
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
}

type ExpandedStep = Exclude<WorkflowStep, { readonly type: 'review-cycle' }> & {
  readonly cycle?: { readonly id: string; readonly role: 'review' | 'consolidate'; readonly iteration: number };
};

function expandWorkflow(workflow: Workflow): readonly ExpandedStep[] {
  return workflow.steps.flatMap((step): readonly ExpandedStep[] => {
    if (step.type !== 'review-cycle') return [step];
    const expanded: ExpandedStep[] = [{ id: step.id, type: 'agent', actor: step.actor, action: step.action, output: step.output }];
    for (let index = 1; index <= step.maxIterations; index += 1) {
      expanded.push({ id: `${step.id}-review-${index}`, type: 'agent', actor: step.reviewer, action: step.reviewAction,
        output: { id: `${step.id}-review-${index}`, filename: `.review-${step.id}-${index}.md`, storage: 'internal' },
        cycle: { id: step.id, role: 'review', iteration: index } });
      if (index < step.maxIterations) expanded.push({ id: `${step.id}-consolidate-${index}`, type: 'agent', actor: step.actor, action: step.action, output: step.output,
        cycle: { id: step.id, role: 'consolidate', iteration: index } });
    }
    expanded.push({ id: step.gateId, type: 'gate', artifact: step.output.id });
    return expanded;
  });
}
