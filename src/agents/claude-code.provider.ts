import type {
  AgentAction,
  AgentProvider,
  PreparedAgentInvocation,
  ProviderPreparationRequest,
} from './agent-provider';

const nativeSkills: Partial<Record<AgentAction, string>> = {
  'feature-design': 'superremy-codex:brainstorming',
  'integration-plan': 'superremy-codex:writing-plans',
  implementation: 'superremy-codex:subagent-driven-development',
  investigate: 'superremy-codex:quick-fix',
};

export class ClaudeCodeProvider implements AgentProvider {
  readonly name = 'claude-code' as const;

  nativeSkillFor(action: AgentAction): string | undefined {
    return nativeSkills[action];
  }

  prepareInvocation(request: ProviderPreparationRequest): PreparedAgentInvocation {
    return {
      command: 'claude',
      args: ['--print'],
      input: instructionText(request),
    };
  }
}

function instructionText(request: ProviderPreparationRequest): string {
  return `${renderInstruction(request.instruction)}\n\nExpected Markdown output: ${request.expectedOutput}`;
}

export function renderInstruction(request: ProviderPreparationRequest['instruction']): string {
  if (request.kind === 'native-skill') return `Use skill: ${request.skill}`;
  return request.content;
}
