import type { RunState } from '../runs/run-state.schema';

export const AGENT_PROVIDER_NAMES = ['claude-code', 'codex', 'opencode'] as const;
export type AgentProviderName = (typeof AGENT_PROVIDER_NAMES)[number];
export type AgentAction = Extract<
  Extract<RunState['steps'][number], { readonly kind: 'agent' }>['method'],
  { readonly action: string }
>['action'];

export type PreparedInstruction =
  | { readonly kind: 'native-skill'; readonly skill: string; readonly additions?: string }
  | { readonly kind: 'fallback-prompt'; readonly content: string }
  | { readonly kind: 'prompt-file'; readonly source: string; readonly content: string };

export interface AgentProfileSelection {
  readonly profile: string;
  readonly provider: AgentProviderName;
  readonly modelAlias?: string;
  readonly model?: string;
  readonly reasoningEffort?: string;
}

export interface ProviderPreparationRequest {
  readonly runId: string;
  readonly stepId: string;
  readonly expectsVerdict?: boolean;
  readonly profile: string;
  /** The port validates its own provider-specific requirements before use. */
  readonly agent: AgentProfileSelection;
  readonly instruction: PreparedInstruction;
  readonly expectedOutput: string;
}

export interface PreparedAgentInvocation {
  readonly command: string;
  readonly args: readonly string[];
  readonly input: string;
  readonly model?: string;
  readonly reasoningEffort?: string;
}

export function agentSettingsForEvent(agent: {
  readonly modelAlias?: string;
  readonly model?: string;
  readonly reasoningEffort?: string;
}): {
  readonly modelAlias?: string;
  readonly model?: string;
  readonly reasoningEffort?: string;
} {
  return {
    ...(agent.modelAlias ? { modelAlias: agent.modelAlias } : {}),
    ...(agent.model ? { model: agent.model } : {}),
    ...(agent.reasoningEffort ? { reasoningEffort: agent.reasoningEffort } : {}),
  };
}

/** A provider-owned, side-effect-free or minimal live connectivity probe. */
export interface AgentHealthCheckInvocation {
  readonly command: string;
  readonly args: readonly string[];
  readonly input?: string;
}

export interface AgentHealthCheckRequest {
  readonly profile: string;
  readonly agent: AgentProfileSelection;
  readonly live: boolean;
}

/**
 * This port prepares invocations only. `next` exposes them as handoffs, while
 * the explicit `advance` command is the sole component allowed to execute one.
 */
export interface AgentProvider {
  readonly name: AgentProviderName;
  nativeSkillFor(action: AgentAction): string | undefined;
  prepareInvocation(request: ProviderPreparationRequest): PreparedAgentInvocation;
  prepareHealthCheck(request: AgentHealthCheckRequest): AgentHealthCheckInvocation;
}

export interface AgentProcessRunner {
  prepare(invocation: PreparedAgentInvocation): PreparedAgentInvocation;
}

export const AGENT_PROCESS_RUNNER = Symbol('AGENT_PROCESS_RUNNER');

export class PlannedAgentProcessRunner implements AgentProcessRunner {
  prepare(invocation: PreparedAgentInvocation): PreparedAgentInvocation {
    return invocation;
  }
}
