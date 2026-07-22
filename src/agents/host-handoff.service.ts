import { Inject, Injectable } from '@nestjs/common';
import { readFileSync, statSync } from 'node:fs';
import { ArtifactService } from '../documentation/artifact.service';
import { EventLogService } from '../runs/event-log.service';
import { FileStateStore, RunStateError } from '../runs/file-state.store';
import { RunLockService } from '../runs/run-lock.service';
import type { RunState } from '../runs/run-state.schema';
import type { NextStepResult } from '../workflows/workflow-runner.service';

export const HOST_HANDOFF_PROTOCOL_VERSION = 1;
export const MAX_HOST_HANDOFF_INPUT_BYTES = 1_048_576;
export const MAX_HOST_HANDOFF_OUTPUT_BYTES = 1_048_576;

export interface HostHandoff {
  readonly kind: 'host-handoff';
  readonly protocolVersion: typeof HOST_HANDOFF_PROTOCOL_VERSION;
  readonly runId: string;
  readonly stepId: string;
  readonly repositoryDirectory: string;
  readonly sideEffects: 'none';
  readonly instruction: { readonly source: string; readonly content: string };
  readonly inputs: readonly {
    readonly id: string;
    readonly path: string;
    readonly sha256: string;
    readonly format: 'markdown';
    readonly trust: 'untrusted';
  }[];
  readonly expectedOutput: { readonly id: string; readonly format: 'markdown'; readonly maxBytes: number };
}

type ResolvedHostHandoffInput = HostHandoff['inputs'][number] & { readonly bytes: number };

type ArtifactRunStep = Extract<RunState['steps'][number], { readonly kind: 'agent' | 'host-handoff' }>;

@Injectable()
export class HostHandoffService {
  constructor(
    @Inject(FileStateStore) private readonly stateStore: FileStateStore,
    @Inject(EventLogService) private readonly events: EventLogService,
    @Inject(ArtifactService) private readonly artifacts: ArtifactService,
    @Inject(RunLockService) private readonly locks: RunLockService,
  ) {}

  prepare(runId: string, result: NextStepResult): HostHandoff | undefined {
    if (result.kind !== 'host-handoff') return undefined;
    const release = this.locks.acquire(runId, 'host-handoff');
    try {
      const state = this.stateStore.findState(runId);
      if (!state) throw new RunStateError(`Run not found: ${runId}`);
      const step = state.steps.find((candidate) => candidate.id === result.stepId);
      if (!step || step.kind !== 'host-handoff' || !step.expectedOutput || step.status !== 'in_progress') {
        throw new RunStateError(`Host handoff ${result.stepId} has not been prepared`);
      }
      const resolvedInputs: ResolvedHostHandoffInput[] = step.inputArtifactIds.map((id) => {
        const producer = state.steps.findLast((candidate): candidate is ArtifactRunStep => (candidate.kind === 'agent' || candidate.kind === 'host-handoff')
          && candidate.declaredOutput.id === id && candidate.status === 'complete' && Boolean(candidate.output));
        if (!producer || !producer.output) throw new RunStateError(`Host handoff input ${id} has no completed artifact`);
        const bytes = statSync(producer.output.path).size;
        if (bytes > MAX_HOST_HANDOFF_INPUT_BYTES) {
          throw new RunStateError(`Host handoff input ${id} exceeds the ${MAX_HOST_HANDOFF_INPUT_BYTES}-byte limit`);
        }
        const currentHash = this.artifacts.currentHash(
          producer.output,
          producer.expectedOutput?.targetRoot ?? state.documentation.target.root,
        );
        if (step.inputArtifactHashes?.[id] !== currentHash) {
          throw new RunStateError(`Host handoff input ${id} changed after the handoff was prepared; retry ${step.id}`);
        }
        return { id, path: producer.output.path, sha256: currentHash, format: 'markdown' as const, trust: 'untrusted' as const, bytes };
      });
      const totalBytes = resolvedInputs.reduce((total, input) => total + input.bytes, 0);
      if (totalBytes > MAX_HOST_HANDOFF_INPUT_BYTES) {
        throw new RunStateError(`Host handoff inputs exceed the ${MAX_HOST_HANDOFF_INPUT_BYTES}-byte aggregate limit`);
      }
      const inputs = resolvedInputs.map(({ bytes: _bytes, ...input }) => input);
      const handoff: HostHandoff = {
        kind: 'host-handoff',
        protocolVersion: HOST_HANDOFF_PROTOCOL_VERSION,
        runId,
        stepId: step.id,
        repositoryDirectory: state.repositoryDirectory ?? process.cwd(),
        sideEffects: step.sideEffects,
        instruction: { source: step.promptFile, content: step.prompt },
        inputs,
        expectedOutput: { id: step.expectedOutput.id, format: 'markdown', maxBytes: MAX_HOST_HANDOFF_OUTPUT_BYTES },
      };
      if (!step.handoffPreparedAt) {
        const at = new Date().toISOString();
        this.stateStore.save({
          ...state,
          steps: state.steps.map((candidate) => candidate.id === step.id && candidate.kind === 'host-handoff'
            ? { ...candidate, handoffPreparedAt: at }
            : candidate),
          updatedAt: at,
        });
        this.events.append(runId, {
          type: 'host.handoff.prepared', at, stepId: step.id,
          inputArtifactIds: step.inputArtifactIds, sideEffects: step.sideEffects,
        });
      }
      return handoff;
    } finally {
      release();
    }
  }
}

export function readHostHandoffOutput(path: string): string {
  const stats = statSync(path);
  if (!stats.isFile()) throw new RunStateError(`Host output source is not a file: ${path}`);
  if (stats.size > MAX_HOST_HANDOFF_OUTPUT_BYTES) {
    throw new RunStateError(`Host output exceeds the ${MAX_HOST_HANDOFF_OUTPUT_BYTES}-byte limit`);
  }
  const content = readFileSync(path, 'utf8');
  if (!content.trim()) throw new RunStateError('Host output must not be empty');
  return content;
}
