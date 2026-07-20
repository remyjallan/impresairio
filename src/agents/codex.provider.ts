import type {
  AgentAction,
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
      args: ['exec'],
      input: `${renderInstruction(request.instruction)}\n\nExpected Markdown output: ${request.expectedOutput}`,
    };
  }
}
