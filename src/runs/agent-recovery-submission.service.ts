import { Inject, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { closeSync, fstatSync, openSync, readSync, realpathSync, statSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
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
      let source: string;
      try {
        source = realpathSync(sourcePathResolved);
        if (!statSync(source).isFile()) {
          throw new RunStateError('Agent output source must be a file');
        }
      } catch (error) {
        if (error instanceof RunStateError) throw error;
        throw new RunStateError(`Agent output source is not a readable file: ${sourcePathResolved}`);
      }
      if (!state.repositoryDirectory) {
        throw new RunStateError('External recovery requires a frozen repository directory');
      }
      let repositoryDirectory: string;
      try {
        repositoryDirectory = realpathSync(state.repositoryDirectory);
      } catch {
        throw new RunStateError('External recovery requires a readable frozen repository directory');
      }
      if (isWithin(source, repositoryDirectory)) {
        throw new RunStateError('Agent output source must be outside the repository');
      }
      const runsDirectory = dirname(this.stateStore.runDirectory(runId));
      if (isWithin(source, runsDirectory)) {
        throw new RunStateError('Agent output source must be outside the Impresairio run directories');
      }
      const content = readExternalRecoveryOutput(source);
      this.patches.validate(content);
      const artifact = content.endsWith('\n') ? content : `${content}\n`;
      const artifactSha256 = createHash('sha256').update(artifact, 'utf8').digest('hex');
      let appliedPatch: ReturnType<CompletionService['complete']>;
      try {
        this.artifacts.publishMarkdown(step.expectedOutput, artifact);
        appliedPatch = this.completion.complete(runId, stepId);
      } catch (error) {
        const latestStep = this.stateStore.findState(runId)?.steps.find((candidate) => candidate.id === stepId);
        if (latestStep?.status === 'in_progress') {
          this.artifacts.discardOutput(step.expectedOutput);
        }
        throw error;
      }
      this.events.append(runId, {
        type: 'agent.external_recovery.submitted', at: new Date().toISOString(), stepId, artifactSha256,
        ...(appliedPatch ? {
          appliedPatch: { sha256: appliedPatch.sha256, paths: appliedPatch.paths, appliedAt: appliedPatch.appliedAt },
        } : {}),
      });
    } finally {
      release();
    }
  }
}

function isWithin(path: string, directory: string): boolean {
  return path === directory || path.startsWith(`${directory}${sep}`);
}

function readExternalRecoveryOutput(path: string): string {
  const descriptor = openSync(path, 'r');
  try {
    const stats = fstatSync(descriptor);
    if (!stats.isFile()) throw new RunStateError('Agent output source must be a file');
    const buffer = Buffer.alloc(MAX_EXTERNAL_AGENT_RECOVERY_OUTPUT_BYTES + 1);
    const bytesRead = readSync(descriptor, buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_EXTERNAL_AGENT_RECOVERY_OUTPUT_BYTES) {
      throw new RunStateError(`Agent output exceeds the ${MAX_EXTERNAL_AGENT_RECOVERY_OUTPUT_BYTES}-byte limit`);
    }
    const content = buffer.subarray(0, bytesRead).toString('utf8');
    if (!content.trim()) throw new RunStateError('Agent output must not be empty');
    return content;
  } finally {
    closeSync(descriptor);
  }
}
