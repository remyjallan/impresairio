import { Inject, Injectable } from '@nestjs/common';
import { resolve } from 'node:path';
import { readHostHandoffOutput } from '../agents/host-handoff.service';
import { ArtifactService } from '../documentation/artifact.service';
import { CompletionService } from './completion.service';
import { EventLogService } from './event-log.service';
import { FileStateStore, RunStateError } from './file-state.store';
import { RunLockService } from './run-lock.service';

@Injectable()
export class AgentRecoverySubmissionService {
  constructor(
    @Inject(FileStateStore) private readonly stateStore: FileStateStore,
    @Inject(ArtifactService) private readonly artifacts: ArtifactService,
    @Inject(CompletionService) private readonly completion: CompletionService,
    @Inject(EventLogService) private readonly events: EventLogService,
    @Inject(RunLockService) private readonly locks: RunLockService,
  ) {}

  submit(runId: string, stepId: string, sourcePath: string): void {
    const release = this.locks.acquireReentrant(runId, 'submit-agent-output');
    try {
      const state = this.stateStore.findState(runId);
      if (!state) throw new RunStateError(`Run not found: ${runId}`);
      const step = state.steps.find((candidate) => candidate.id === stepId);
      if (!step || step.kind !== 'agent' || !step.externalRecovery) {
        throw new RunStateError(`Step ${stepId} is not awaiting external agent output`);
      }
      if (state.currentStepId !== stepId || step.status !== 'in_progress' || !step.expectedOutput) {
        throw new RunStateError(`External recovery ${stepId} is not awaiting output`);
      }
      if (resolve(sourcePath) === resolve(step.expectedOutput.path)) {
        throw new RunStateError('Agent output source must not be the Impresairio-managed destination');
      }
      const content = readHostHandoffOutput(sourcePath);
      this.artifacts.publishMarkdown(step.expectedOutput, content.endsWith('\n') ? content : `${content}\n`);
      this.completion.complete(runId, stepId);
      this.events.append(runId, { type: 'agent.external_recovery.submitted', at: new Date().toISOString(), stepId });
    } finally {
      release();
    }
  }
}
