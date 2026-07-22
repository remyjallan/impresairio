import type {
  AgentAction,
  AgentHealthCheckInvocation,
  AgentHealthCheckRequest,
  AgentProvider,
  PreparedAgentInvocation,
  ProviderPreparationRequest,
} from './agent-provider';

export class ClaudeCodeProvider implements AgentProvider {
  readonly name = 'claude-code' as const;

  nativeSkillFor(_action: AgentAction): string | undefined {
    // The open-source provider cannot assume that a personal skill package is
    // installed. Optional skill routing belongs in user configuration.
    return undefined;
  }

  prepareInvocation(request: ProviderPreparationRequest): PreparedAgentInvocation {
    const review = request.expectsVerdict === true;
    return {
      command: 'claude',
      args: [
        '--print', '--output-format', 'json', '--no-session-persistence',
        ...selectionArgs(request.agent),
        ...(review ? ['--json-schema', JSON.stringify({
          type: 'object', additionalProperties: false,
          required: ['markdown', 'verdict'],
          properties: {
            markdown: { type: 'string' },
            verdict: { type: 'string', enum: ['APPROVED', 'CHANGES_REQUESTED', 'BLOCKED'] },
          },
        })] : []),
      ],
      input: instructionText(request),
      ...(request.agent.model ? { model: request.agent.model } : {}),
      ...(request.agent.reasoningEffort ? { reasoningEffort: request.agent.reasoningEffort } : {}),
    };
  }

  prepareHealthCheck({ agent, live }: AgentHealthCheckRequest): AgentHealthCheckInvocation {
    return live
      ? {
          command: 'claude',
          args: ['--print', '--output-format', 'json', '--no-session-persistence', ...selectionArgs(agent)],
          input: 'Reply with exactly OK. Do not use tools or modify files.',
        }
      : { command: 'claude', args: ['--version'] };
  }
}

function selectionArgs(agent: AgentHealthCheckRequest['agent']): readonly string[] {
  return [
    ...(agent.model ? ['--model', agent.model] : []),
    ...(agent.reasoningEffort ? ['--effort', agent.reasoningEffort] : []),
  ];
}

function instructionText(request: ProviderPreparationRequest): string {
  // `claude --print` returns its answer on stdout.  Asking it to save that
  // answer to the staging path makes Claude attempt a Write tool call; that
  // path deliberately sits outside the agent's workspace and is therefore
  // denied.  The runner owns persistence, so keep this transport contract
  // explicit and file-system independent.
  return `${renderInstruction(request.instruction)}\n\nReturn the complete Markdown artifact in your response only. Do not write or modify files.`;
}

export function renderInstruction(request: ProviderPreparationRequest['instruction']): string {
  if (request.kind === 'native-skill') {
    return `Use skill: ${request.skill}${request.additions ? `\n\n${request.additions}` : ''}`;
  }
  return request.content;
}
