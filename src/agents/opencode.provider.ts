import type {
  AgentAction,
  AgentProvider,
  PreparedAgentInvocation,
  ProviderPreparationRequest,
} from './agent-provider';
import { renderInstruction } from './claude-code.provider';

export class OpenCodeProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OpenCodeProviderError';
  }
}

export class OpenCodeProvider implements AgentProvider {
  readonly name = 'opencode' as const;

  nativeSkillFor(_action: AgentAction): string | undefined {
    return undefined;
  }

  prepareInvocation(request: ProviderPreparationRequest): PreparedAgentInvocation {
    if (request.agent.provider !== 'opencode' || !request.agent.model) {
      throw new OpenCodeProviderError(
        `OpenCode profile ${request.profile} requires a resolved model ID`,
      );
    }
    return {
      command: 'opencode',
      args: ['run', '--model', request.agent.model],
      input: `${renderInstruction(request.instruction)}\n\nExpected Markdown output: ${request.expectedOutput}`,
      model: request.agent.model,
    };
  }
}
