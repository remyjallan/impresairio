import type {
  AgentAction,
  AgentProfileSelection,
  AgentHealthCheckInvocation,
  AgentHealthCheckRequest,
  AgentProvider,
  PreparedAgentInvocation,
  ProviderPreparationRequest,
} from './agent-provider';
import { renderInstruction } from './claude-code.provider';

export class CodexProvider implements AgentProvider {
  readonly name = 'codex' as const;

  nativeSkillFor(_action: AgentAction): string | undefined {
    return undefined;
  }

  prepareInvocation(request: ProviderPreparationRequest): PreparedAgentInvocation {
    return {
      command: 'codex',
      args: ['exec', '--sandbox', 'read-only', ...selectionArgs(request.agent)],
      // The runner owns artifact publication. Asking Codex to write a staging
      // file conflicts with the intentionally read-only sandbox and wraps an
      // otherwise valid response in a denied-write diagnostic.
      input: `${renderInstruction(request.instruction)}\n\nReturn the complete Markdown artifact in your response only. Do not write or modify files.`,
      ...(request.agent.model ? { model: request.agent.model } : {}),
      ...(request.agent.reasoningEffort ? { reasoningEffort: request.agent.reasoningEffort } : {}),
    };
  }

  prepareHealthCheck({ agent, live }: AgentHealthCheckRequest): AgentHealthCheckInvocation {
    return live
      ? {
          command: 'codex',
          args: ['exec', '--sandbox', 'read-only', '--skip-git-repo-check', ...selectionArgs(agent)],
          input: 'Reply with exactly OK. Do not use tools or modify files.',
        }
      : { command: 'codex', args: ['--version'] };
  }
}

function selectionArgs(agent: Pick<AgentProfileSelection, 'model' | 'reasoningEffort'>): readonly string[] {
  return [
    ...(agent.model ? ['--model', agent.model] : []),
    ...(agent.reasoningEffort ? ['-c', `model_reasoning_effort="${agent.reasoningEffort}"`] : []),
  ];
}
