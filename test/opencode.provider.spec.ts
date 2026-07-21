import { describe, expect, it } from 'vitest';
import { OpenCodeProvider, OpenCodeProviderError } from '../src/agents/opencode.provider';

describe('OpenCodeProvider', () => {
  const provider = new OpenCodeProvider();

  it('requires a resolved model before a non-interactive invocation is prepared', () => {
    expect(() => provider.prepareInvocation({
      runId: 'run-1', stepId: 'implementation', profile: 'opencode-glm',
      instruction: { kind: 'fallback-prompt', content: 'Implement the feature.' },
      expectedOutput: '/docs/report.md',
      agent: { profile: 'opencode-glm', provider: 'opencode', modelAlias: 'glm-5.2' },
    })).toThrow(new OpenCodeProviderError('OpenCode profile opencode-glm requires a resolved model ID'));
  });

  it('prepares, but does not execute, an invocation with the resolved model ID', () => {
    expect(provider.prepareInvocation({
      runId: 'run-1', stepId: 'implementation', profile: 'opencode-glm',
      instruction: { kind: 'fallback-prompt', content: 'Implement the feature.' },
      expectedOutput: '/docs/report.md',
      agent: {
        profile: 'opencode-glm', provider: 'opencode', modelAlias: 'glm-5.2', model: 'z-ai/glm-5.2',
      },
    })).toMatchObject({
      command: 'opencode', args: ['run', '--model', 'z-ai/glm-5.2'], model: 'z-ai/glm-5.2',
    });
  });

  it('uses the same resolved model ID for a live health probe', () => {
    expect(provider.prepareHealthCheck({
      profile: 'opencode-glm',
      agent: {
        profile: 'opencode-glm', provider: 'opencode', modelAlias: 'glm-5.2', model: 'openrouter/z-ai/glm-5.2',
      },
      live: true,
    })).toEqual({
      command: 'opencode',
      args: ['run', '--model', 'openrouter/z-ai/glm-5.2'],
      input: 'Reply with exactly OK. Do not use tools or modify files.',
    });
  });
});
