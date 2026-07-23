import { Inject, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { readHostHandoffOutput } from '../agents/host-handoff.service';
import { ArtifactService } from '../documentation/artifact.service';
import { CompletionService } from './completion.service';
import { EventLogService } from './event-log.service';
import { MAX_EXTERNAL_AGENT_RECOVERY_OUTPUT_BYTES } from './external-agent-recovery.service';
import { FileStateStore, RunStateError } from './file-state.store';
import { RepositoryPatchService } from './repository-patch.service';
import { RunLockService } from './run-lock.service';

@Injectable()
export class AgentRecoverySubmissionService {
  constructor(
    @Inject(FileStateStore) private readonly stateStore: FileStateStore,
    @Inject(ArtifactService) private readonly artifacts: ArtifactService,
    @Inject(CompletionService) private readonly completion: CompletionService,
    @Inject(EventLogService) private readonly events: EventLogService,
    @Inject(RunLockService) private readonly locks: RunLockService,
    @Inject(RepositoryPatchService) private readonly patches: RepositoryPatchService,
  ) {}

  submit(runId: string, stepId: string, sourcePath: string): void {
    const release = this.locks.acquireReentrant(runId, 'submit-agent-output');
    try {
      const state = this.stateStore.findState(runId);
      if (!state) throw new RunStateError(`Run not found: ${runId}`);
      if (this.events.read(runId).some((event) => event.type === 'agent.external_recovery.submitted' && event.stepId === stepId)) {
        throw new RunStateError(`External recovery ${stepId} was already submitted`);
      }
      const step = state.steps.find((candidate) => candidate.id === stepId);
      if (!step || step.kind !== 'agent' || !step.externalRecovery) {
        throw new RunStateError(`Step ${stepId} is not awaiting external agent output`);
      }
      if (state.currentStepId !== stepId || step.status !== 'in_progress' || !step.expectedOutput) {
        throw new RunStateError(`External recovery ${stepId} is not awaiting output`);
      }
      const sourcePathResolved = resolve(sourcePath);
      if (sourcePathResolved === resolve(step.expectedOutput.path)) {
        throw new RunStateError('Agent output source must not be the Impresairio-managed destination');
      }
      const source = realpathSync(sourcePathResolved);
      if (state.repositoryDirectory && isWithin(source, realpathSync(state.repositoryDirectory))) {
        throw new RunStateError('Agent output source must be outside the repository');
      }
      if (isWithin(source, dirname(step.expectedOutput.directory))) {
        throw new RunStateError('Agent output source must be outside the Impresairio run directory');
      }
      const content = readHostHandoffOutput(source);
      if (Buffer.byteLength(content, 'utf8') > MAX_EXTERNAL_AGENT_RECOVERY_OUTPUT_BYTES) {
        throw new RunStateError(`Agent output exceeds the ${MAX_EXTERNAL_AGENT_RECOVERY_OUTPUT_BYTES}-byte limit`);
      }
      this.patches.validate(content);
      const artifact = content.endsWith('\n') ? content : `${content}\n`;
      const artifactSha256 = createHash('sha256').update(artifact, 'utf8').digest('hex');
      this.artifacts.publishMarkdown(step.expectedOutput, artifact);
      const appliedPatch = this.completion.complete(runId, stepId);
      if (!appliedPatch) {
        throw new RunStateError(`External recovery ${stepId} completed without applying a patch`);
      }
      this.events.append(runId, {
        type: 'agent.external_recovery.submitted', at: new Date().toISOString(), stepId, artifactSha256,
        appliedPatch: { sha256: appliedPatch.sha256, paths: appliedPatch.paths, appliedAt: appliedPatch.appliedAt },
      });
    } finally {
      release();
    }
  }
}

function isWithin(path: string, directory: string): boolean {
  const pathFromDirectory = relative(directory, path);
  return pathFromDirectory === '' || (!pathFromDirectory.startsWith('..') && !pathFromDirectory.startsWith('/'));
}
