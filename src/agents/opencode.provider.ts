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

export type OpenCodeRunOutput =
  | { readonly kind: 'text'; readonly content: string }
  | { readonly kind: 'permission-request' }
  | { readonly kind: 'no-text-event' };

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
      args: ['run', '--model', request.agent.model, '--format', 'json'],
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
          args: ['run', '--model', agent.model, '--format', 'json'],
          input: 'Reply with exactly OK. Do not use tools or modify files.',
        }
      : { command: 'opencode', args: ['--version'] };
  }
}

/** Extract the final assistant text from OpenCode's documented JSONL run output. */
export function readOpenCodeRunOutput(stdout: string): OpenCodeRunOutput {
  const events = stdout.split('\n').flatMap((line) => {
    if (!line.trim()) return [];
    try {
      return [JSON.parse(line) as Record<string, unknown>];
    } catch {
      return [];
    }
  });
  const content = events.flatMap((event) => {
    if (event.type !== 'text' || !isRecord(event.part) || event.part.type !== 'text') return [];
    return typeof event.part.text === 'string' ? [event.part.text] : [];
  }).join('');
  if (content.trim()) return { kind: 'text', content };
  if (events.some(isPermissionEvent)) return { kind: 'permission-request' };
  return { kind: 'no-text-event' };
}

export function describeOpenCodeRunOutput(output: OpenCodeRunOutput): string {
  if (output.kind === 'permission-request') {
    return 'OpenCode requested permission instead of returning an artifact; review its focused permission rules or run the step manually. Impresairio never enables --auto.';
  }
  return 'OpenCode returned no text event; run "impresairio doctor --live --profile <profile>", then check provider authentication, the pinned model, and OpenCode permission rules.';
}

function isPermissionEvent(event: Record<string, unknown>): boolean {
  const type = typeof event.type === 'string' ? event.type : '';
  if (/permission|approval/i.test(type)) return true;
  return JSON.stringify(event).match(/\b(permission|approval)\b/i) !== null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
