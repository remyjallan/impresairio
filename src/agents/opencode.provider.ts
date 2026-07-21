import type {
  AgentAction,
  AgentHealthCheckInvocation,
  AgentHealthCheckRequest,
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
      // OpenCode may try to inspect or write a path mentioned in its prompt.
      // Run artifacts can be outside its repository sandbox, while the runner
      // is the only component allowed to publish them. Keep this transport
      // contract path-free, but allow repository inspection.
      input: `${renderInstruction(request.instruction)}\n\nYou may inspect repository files. Return the complete Markdown artifact in your response only. Do not write or modify files.`,
      model: request.agent.model,
    };
  }

  prepareHealthCheck({ agent, live }: AgentHealthCheckRequest): AgentHealthCheckInvocation {
    if (agent.provider !== 'opencode' || !agent.model) {
      throw new OpenCodeProviderError('OpenCode health checks require a resolved model ID');
    }
    return live
      ? {
          command: 'opencode',
          args: ['run', '--model', agent.model],
          input: 'Reply with exactly OK. Do not use tools or modify files.',
        }
      : { command: 'opencode', args: ['--version'] };
  }
}
