import { describe, expect, it } from 'vitest';
import { artifactEnvelopeInstruction, ClaudeCodeProvider } from '../src/agents/claude-code.provider';

describe('ClaudeCodeProvider', () => {
  it('adapts the artifact envelope protocol to plain and structured verdict responses', () => {
    expect(artifactEnvelopeInstruction(false)).toContain('Do not add prose outside the envelope.');
    expect(artifactEnvelopeInstruction(true)).toContain('append exactly one required VERDICT line');
    expect(artifactEnvelopeInstruction(true, true)).toContain('structured markdown field');
  });

  it('passes pinned model and reasoning effort to both execution and live health checks', () => {
    const provider = new ClaudeCodeProvider();
    const agent = {
      profile: 'claude-fast', provider: 'claude-code' as const,
      model: 'sonnet', reasoningEffort: 'high',
    };

    const invocation = provider.prepareInvocation({
      runId: 'run-test', stepId: 'design', profile: 'claude-fast', agent,
      instruction: { kind: 'fallback-prompt', content: 'Design the change.' },
      expectedOutput: '/tmp/impresairio/staging/design.md',
    });
    expect(invocation).toMatchObject({
      args: ['--print', '--output-format', 'json', '--no-session-persistence', '--model', 'sonnet', '--effort', 'high'],
      model: 'sonnet', reasoningEffort: 'high',
    });
    expect(invocation.input).toContain('IMPRESAIRIO_ARTIFACT_END');
    expect(provider.prepareHealthCheck({ profile: 'claude-fast', agent, live: true })).toEqual({
      command: 'claude',
      args: ['--print', '--output-format', 'json', '--no-session-persistence', '--model', 'sonnet', '--effort', 'high'],
      input: 'Reply with exactly OK. Do not use tools or modify files.',
    });
  });
});
