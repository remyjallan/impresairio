import type { RunState } from '../runs/run-state.schema';

export const AGENT_PROVIDER_NAMES = ['claude-code', 'codex', 'opencode'] as const;
export type AgentProviderName = (typeof AGENT_PROVIDER_NAMES)[number];
export type AgentAction = Extract<
  Extract<RunState['steps'][number], { readonly kind: 'agent' }>['method'],
  { readonly action: string }
>['action'];

export type PreparedInstruction =
  | { readonly kind: 'native-skill'; readonly skill: string }
  | { readonly kind: 'fallback-prompt'; readonly content: string }
  | { readonly kind: 'prompt-file'; readonly source: string; readonly content: string };

export interface ProviderPreparationRequest {
  readonly runId: string;
  readonly stepId: string;
  readonly profile: string;
  /** The port validates its own provider-specific requirements before use. */
  readonly agent: {
    readonly profile: string;
    readonly provider: AgentProviderName;
    readonly modelAlias?: string;
    readonly model?: string;
  };
  readonly instruction: PreparedInstruction;
  readonly expectedOutput: string;
}

export interface PreparedAgentInvocation {
  readonly command: string;
  readonly args: readonly string[];
  readonly input: string;
  readonly model?: string;
}

/**
 * This is intentionally a preparation port. V0 never asks a provider to start
 * a real CLI process; automatic execution is a later opt-in mode.
 */
export interface AgentProvider {
  readonly name: AgentProviderName;
  nativeSkillFor(action: AgentAction): string | undefined;
  prepareInvocation(request: ProviderPreparationRequest): PreparedAgentInvocation;
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
