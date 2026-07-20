import { Inject, Injectable } from '@nestjs/common';
import { EventLogService } from '../runs/event-log.service';
import { FileStateStore, RunStateError } from '../runs/file-state.store';
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
  readonly mode: 'interactive-handoff' | 'prepared-non-interactive';
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
  ) {}

  prepare(runId: string, result: NextStepResult): AgentHandoff | undefined {
    if (result.kind !== 'agent') return undefined;
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
    const instruction = this.instructionFor(step.method, provider);
    const expectedOutput = {
      id: step.expectedOutput.id,
      path: step.expectedOutput.path,
      format: step.expectedOutput.format,
    } as const;
    const isLauncher = step.actor === 'launcher';
    const invocation = isLauncher ? undefined : this.processRunner.prepare(provider.prepareInvocation({
      runId,
      stepId: step.id,
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
      mode: isLauncher ? 'interactive-handoff' : 'prepared-non-interactive',
      instruction,
      expectedOutput,
      ...(invocation ? { invocation } : {}),
    };
    this.events.append(runId, {
      type: invocation ? 'agent.invocation.prepared' : 'agent.handoff.prepared',
      at: new Date().toISOString(),
      stepId: step.id,
      actor: step.actor,
      profile: agent.profile,
      provider: agent.provider,
      ...(agent.provider === 'opencode' ? { modelAlias: agent.modelAlias, model: agent.model } : {}),
    });
    return handoff;
  }

  private instructionFor(
    method: Extract<NonNullable<ReturnType<FileStateStore['findState']>>['steps'][number], { readonly kind: 'agent' }>['method'],
    provider: ReturnType<ProviderRegistryService['get']>,
  ): PreparedInstruction {
    if ('promptFile' in method) {
      return { kind: 'prompt-file', source: method.promptFile, content: method.content };
    }
    const nativeSkill = provider.nativeSkillFor(method.action);
    return nativeSkill
      ? { kind: 'native-skill', skill: nativeSkill }
      : { kind: 'fallback-prompt', content: fallbackPromptFor(method.action) };
  }
}
