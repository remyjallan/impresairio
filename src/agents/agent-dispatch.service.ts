import { Inject, Injectable } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { EventLogService } from '../runs/event-log.service';
import { FileStateStore, RunStateError } from '../runs/file-state.store';
import { RunLockService } from '../runs/run-lock.service';
import type { NextStepResult } from '../workflows/workflow-runner.service';
import {
  AGENT_PROCESS_RUNNER,
  type AgentProcessRunner,
  type PreparedAgentInvocation,
  type PreparedInstruction,
} from './agent-provider';
import { fallbackPromptFor } from './fallback-prompts';
import { ProviderRegistryService } from './provider-registry.service';

export interface AgentHandoff {
  readonly kind: 'agent';
  readonly stepId: string;
  readonly actor: string;
  readonly profile: string;
  readonly provider: string;
  readonly mode: 'prepared-non-interactive';
  readonly instruction: PreparedInstruction;
  readonly expectedOutput: {
    readonly id: string;
    readonly path: string;
    readonly format: 'markdown';
  };
  readonly invocation?: PreparedAgentInvocation;
}

@Injectable()
export class AgentDispatchService {
  constructor(
    @Inject(FileStateStore) private readonly stateStore: FileStateStore,
    @Inject(ProviderRegistryService) private readonly providers: ProviderRegistryService,
    @Inject(EventLogService) private readonly events: EventLogService,
    @Inject(AGENT_PROCESS_RUNNER) private readonly processRunner: AgentProcessRunner,
    @Inject(RunLockService) private readonly locks: RunLockService,
  ) {}

  prepare(runId: string, result: NextStepResult): AgentHandoff | undefined {
    if (result.kind !== 'agent') return undefined;
    const release = this.locks.acquire(runId, 'dispatch');
    try {
      const state = this.stateStore.findState(runId);
      if (!state) throw new RunStateError(`Run not found: ${runId}`);
      const step = state.steps.find((candidate) => candidate.id === result.stepId);
      if (!step || step.kind !== 'agent' || !step.expectedOutput) {
        throw new RunStateError(`Agent step ${result.stepId} has no prepared output`);
      }
    const agent = state.resolvedActors[step.actor];
    if (!agent) {
      throw new RunStateError(`Agent profile is not frozen for actor ${step.actor}`);
    }
    const provider = this.providers.get(agent.provider);
    const baseInstruction = this.instructionFor(step.method, provider, agent.skills);
    const context = this.contextFor(state, step.id);
    const feedback = this.feedbackFor(state, step.declaredOutput.id);
    const additions = [
      state.request ? `Work request:\n${state.request}` : undefined,
      context ? `Input artifacts:\n${context}` : undefined,
      feedback ? `Human feedback to address:\n${feedback}` : undefined,
    ].filter((value): value is string => Boolean(value)).join('\n\n');
    const instruction = additions ? this.withAdditions(baseInstruction, additions) : baseInstruction;
    const expectedOutput = {
      id: step.expectedOutput.id,
      path: step.expectedOutput.path,
      format: step.expectedOutput.format,
    } as const;
    const alreadyPrepared = Boolean(step.dispatchPreparedAt);
    const invocation = this.processRunner.prepare(provider.prepareInvocation({
      runId,
      stepId: step.id,
      ...('action' in step.method ? { action: step.method.action } : {}),
      profile: agent.profile,
      agent,
      instruction,
      expectedOutput: expectedOutput.path,
    }));
    const handoff: AgentHandoff = {
      kind: 'agent',
      stepId: step.id,
      actor: step.actor,
      profile: agent.profile,
      provider: agent.provider,
      mode: 'prepared-non-interactive',
      instruction,
      expectedOutput,
      ...(invocation ? { invocation } : {}),
    };
    if (!alreadyPrepared) {
      this.stateStore.save({
        ...state,
        steps: state.steps.map((candidate) => candidate.id === step.id && candidate.kind === 'agent'
          ? { ...candidate, dispatchPreparedAt: new Date().toISOString() }
          : candidate),
        updatedAt: new Date().toISOString(),
      });
        this.events.append(runId, {
          type: invocation ? 'agent.invocation.prepared' : 'agent.handoff.prepared',
          at: new Date().toISOString(),
          stepId: step.id,
          actor: step.actor,
          profile: agent.profile,
          provider: agent.provider,
          ...(agent.provider === 'opencode' ? { modelAlias: agent.modelAlias, model: agent.model } : {}),
      });
    }
    return handoff;
    } finally {
      release();
    }
  }

  private instructionFor(
    method: Extract<NonNullable<ReturnType<FileStateStore['findState']>>['steps'][number], { readonly kind: 'agent' }>['method'],
    provider: ReturnType<ProviderRegistryService['get']>,
    skills: Readonly<Record<string, string>> | undefined,
  ): PreparedInstruction {
    if ('promptFile' in method) {
      return { kind: 'prompt-file', source: method.promptFile, content: method.content };
    }
    const nativeSkill = skills?.[method.action] ?? provider.nativeSkillFor(method.action);
    return nativeSkill
      ? { kind: 'native-skill', skill: nativeSkill }
      : { kind: 'fallback-prompt', content: fallbackPromptFor(method.action) };
  }

  private contextFor(state: NonNullable<ReturnType<FileStateStore['findState']>>, stepId: string): string {
    const index = state.steps.findIndex((step) => step.id === stepId);
    const artifacts = new Map<string, string>();
    for (const step of state.steps.slice(0, index)) {
      if (step.kind !== 'agent' || step.status !== 'complete' || !step.output) continue;
      try { artifacts.set(step.declaredOutput.id, readFileSync(step.output.path, 'utf8')); } catch { /* completion will surface missing inputs */ }
    }
    return [...artifacts.entries()].map(([id, content]) => `## ${id}\n${content}`).join('\n\n');
  }

  private feedbackFor(state: NonNullable<ReturnType<FileStateStore['findState']>>, outputId: string): string {
    return state.steps
      .filter((step): step is Extract<typeof state.steps[number], { readonly kind: 'gate' }> => step.kind === 'gate' && step.artifact === outputId)
      .flatMap((step) => step.feedback.map((item) => `- ${item.comment}`))
      .join('\n');
  }

  private withAdditions(instruction: PreparedInstruction, additions: string): PreparedInstruction {
    if (instruction.kind === 'native-skill') {
      return { ...instruction, additions };
    }
    return { ...instruction, content: `${instruction.content}\n\n${additions}` };
  }
}
