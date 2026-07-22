import { Inject, Injectable } from '@nestjs/common';
import { resolve } from 'node:path';
import { readHostHandoffOutput } from '../agents/host-handoff.service';
import { ArtifactService } from '../documentation/artifact.service';
import { CompletionService } from './completion.service';
import { EventLogService } from './event-log.service';
import { FileStateStore, RunStateError } from './file-state.store';
import { RunLockService } from './run-lock.service';

@Injectable()
export class HostHandoffSubmissionService {
  constructor(
    @Inject(FileStateStore) private readonly stateStore: FileStateStore,
    @Inject(ArtifactService) private readonly artifacts: ArtifactService,
    @Inject(CompletionService) private readonly completion: CompletionService,
    @Inject(EventLogService) private readonly events: EventLogService,
    @Inject(RunLockService) private readonly locks: RunLockService,
  ) {}

  submit(runId: string, stepId: string, sourcePath: string): void {
    const release = this.locks.acquireReentrant(runId, 'submit-host-output');
    try {
      const state = this.stateStore.findState(runId);
      if (!state) throw new RunStateError(`Run not found: ${runId}`);
      const step = state.steps.find((candidate) => candidate.id === stepId);
      if (!step || step.kind !== 'host-handoff') throw new RunStateError(`Step ${stepId} is not a host handoff`);
      if (state.currentStepId !== stepId || step.status !== 'in_progress' || !step.expectedOutput) {
        throw new RunStateError(`Host handoff ${stepId} is not awaiting output`);
      }
      if (resolve(sourcePath) === resolve(step.expectedOutput.path)) {
        throw new RunStateError('Host output source must not be the Impresairio-managed destination');
      }
      const content = readHostHandoffOutput(sourcePath);
      this.artifacts.publishMarkdown(step.expectedOutput, content.endsWith('\n') ? content : `${content}\n`);
      try {
        this.completion.complete(runId, stepId);
      } catch (error) {
        // Completion can fail before recording the state transition (for
        // example while verifying a structured result). Compensate only when
        // the state is still incomplete: an error after recordCompletion,
        // such as an event-log failure, must retain the referenced artifact.
        const persisted = this.stateStore.findState(runId);
        const persistedStep = persisted?.steps.find((candidate) => candidate.id === stepId);
        if (persistedStep?.kind === 'host-handoff' && persistedStep.status !== 'complete') {
          this.artifacts.discardOutput(step.expectedOutput);
        }
        throw error;
      }
      this.events.append(runId, { type: 'host.handoff.submitted', at: new Date().toISOString(), stepId });
    } finally {
      release();
    }
  }
}
