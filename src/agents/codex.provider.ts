import type {
  AgentAction,
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
      args: ['exec', '--output-last-message', request.expectedOutput],
      input: `${renderInstruction(request.instruction)}\n\nExpected Markdown output: ${request.expectedOutput}`,
    };
  }

  prepareHealthCheck({ live }: AgentHealthCheckRequest): AgentHealthCheckInvocation {
    return live
      ? {
          command: 'codex',
          args: ['exec', '--sandbox', 'read-only', '--skip-git-repo-check'],
          input: 'Reply with exactly OK. Do not use tools or modify files.',
        }
      : { command: 'codex', args: ['--version'] };
  }
}
