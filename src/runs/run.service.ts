import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { EventLogService } from './event-log.service';
import { FileStateStore, RunStateError } from './file-state.store';
import { RunLockService } from './run-lock.service';
import { createRunState, type RunState } from './run-state.schema';
import { WorkflowRegistryService } from '../workflows/workflow-registry.service';
import { ConfigService } from '../config/config.service';

export interface StartRunRequest {
  readonly id?: string;
  readonly workflowId: string;
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
    @Inject(RUN_CLOCK)
    private readonly now: () => Date = () => new Date(),
  ) {}

  start(request: StartRunRequest): RunState {
    const id = request.id ?? `run-${randomUUID()}`;
    const timestamp = this.now().toISOString();
    const configuration = this.configService.load(request.repositoryDirectory ?? process.cwd());
    const resolvedWorkflow = this.workflowRegistry.resolve(
      request.workflowId,
      request.repositoryDirectory,
    );
    const state = createRunState({
      ...request,
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
      workflowSha256: resolvedWorkflow.sha256,
      steps: resolvedWorkflow.workflow.steps.map((step) => ({
        id: step.id,
        kind: step.type,
        ...(step.type === 'agent'
          ? {
              actor: step.actor,
              ...('action' in step
                ? { action: step.action }
                : { promptFile: step.promptFile }),
              output: step.output,
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
        roles: state.roles,
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
}
