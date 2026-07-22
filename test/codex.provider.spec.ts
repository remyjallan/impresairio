import { describe, expect, it } from 'vitest';
import { agentSettingsForEvent } from '../src/agents/agent-provider';
import { CodexProvider } from '../src/agents/codex.provider';

describe('CodexProvider', () => {
  it('includes only configured frozen settings in event metadata', () => {
    expect(agentSettingsForEvent({})).toEqual({});
    expect(agentSettingsForEvent({ modelAlias: 'glm', model: 'openrouter/z-ai/glm-5.2' })).toEqual({
      modelAlias: 'glm', model: 'openrouter/z-ai/glm-5.2',
    });
    expect(agentSettingsForEvent({ model: 'gpt-5.6-sol', reasoningEffort: 'xhigh' })).toEqual({
      model: 'gpt-5.6-sol', reasoningEffort: 'xhigh',
    });
  });

  it('returns the artifact on stdout without asking the read-only sandbox to write it', () => {
    const invocation = new CodexProvider().prepareInvocation({
      runId: 'run-test',
      stepId: 'review',
      profile: 'codex',
      agent: { profile: 'codex', provider: 'codex' },
      instruction: { kind: 'fallback-prompt', content: 'Review the change.' },
      expectedOutput: '/tmp/impresairio/staging/review.md',
    });

    expect(invocation.args).toEqual(['exec', '--sandbox', 'read-only']);
    expect(invocation.args).not.toContain('--output-last-message');
    expect(invocation.input).toContain('Return the complete Markdown artifact in your response only.');
    expect(invocation.input).toContain('Do not write or modify files.');
    expect(invocation.input).not.toContain('/tmp/impresairio/staging/review.md');
  });

  it('passes pinned model and reasoning effort to both execution and live health checks', () => {
    const provider = new CodexProvider();
    const agent = {
      profile: 'codex-sol', provider: 'codex' as const,
      model: 'gpt-5.6-sol', reasoningEffort: 'xhigh',
    };

    expect(provider.prepareInvocation({
      runId: 'run-test', stepId: 'review', profile: 'codex-sol', agent,
      instruction: { kind: 'fallback-prompt', content: 'Review the change.' },
      expectedOutput: '/tmp/impresairio/staging/review.md',
    })).toMatchObject({
      args: ['exec', '--sandbox', 'read-only', '--model', 'gpt-5.6-sol', '-c', 'model_reasoning_effort="xhigh"'],
      model: 'gpt-5.6-sol', reasoningEffort: 'xhigh',
    });
    expect(provider.prepareHealthCheck({ profile: 'codex-sol', agent, live: true })).toEqual({
      command: 'codex',
      args: ['exec', '--sandbox', 'read-only', '--skip-git-repo-check', '--model', 'gpt-5.6-sol', '-c', 'model_reasoning_effort="xhigh"'],
      input: 'Reply with exactly OK. Do not use tools or modify files.',
    });
  });
});
