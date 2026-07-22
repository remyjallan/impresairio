import { describe, expect, it } from 'vitest';
import { ClaudeCodeProvider } from '../src/agents/claude-code.provider';

describe('ClaudeCodeProvider', () => {
  it('passes pinned model and reasoning effort to both execution and live health checks', () => {
    const provider = new ClaudeCodeProvider();
    const agent = {
      profile: 'claude-fast', provider: 'claude-code' as const,
      model: 'sonnet', reasoningEffort: 'high',
    };

    expect(provider.prepareInvocation({
      runId: 'run-test', stepId: 'design', profile: 'claude-fast', agent,
      instruction: { kind: 'fallback-prompt', content: 'Design the change.' },
      expectedOutput: '/tmp/impresairio/staging/design.md',
    })).toMatchObject({
      args: ['--print', '--output-format', 'json', '--no-session-persistence', '--model', 'sonnet', '--effort', 'high'],
      model: 'sonnet', reasoningEffort: 'high',
    });
    expect(provider.prepareHealthCheck({ profile: 'claude-fast', agent, live: true })).toEqual({
      command: 'claude',
      args: ['--print', '--output-format', 'json', '--no-session-persistence', '--model', 'sonnet', '--effort', 'high'],
      input: 'Reply with exactly OK. Do not use tools or modify files.',
    });
  });
});
