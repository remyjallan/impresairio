import { describe, expect, it } from 'vitest';
import {
  describeOpenCodeRunOutput,
  OpenCodeProvider,
  OpenCodeProviderError,
  readOpenCodeRunOutput,
} from '../src/agents/opencode.provider';

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
    const invocation = provider.prepareInvocation({
      runId: 'run-1', stepId: 'implementation', profile: 'opencode-glm',
      instruction: { kind: 'fallback-prompt', content: 'Implement the feature.' },
      expectedOutput: '/docs/report.md',
      agent: {
        profile: 'opencode-glm', provider: 'opencode', modelAlias: 'glm-5.2', model: 'z-ai/glm-5.2',
      },
    });
    expect(invocation).toMatchObject({
      command: 'opencode', args: ['run', '--model', 'z-ai/glm-5.2', '--format', 'json'], model: 'z-ai/glm-5.2',
    });
    expect(invocation.input).toContain('You may inspect repository files.');
    expect(invocation.input).toContain('Return the complete Markdown artifact in your response only.');
    expect(invocation.input).toContain('Do not write or modify files.');
    expect(invocation.input).not.toContain('Do not read');
    expect(invocation.input).not.toContain('/docs/report.md');
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
      args: ['run', '--model', 'openrouter/z-ai/glm-5.2', '--format', 'json'],
      input: 'Reply with exactly OK. Do not use tools or modify files.',
    });
  });

  it('extracts final Markdown from OpenCode JSONL without treating progress as content', () => {
    expect(readOpenCodeRunOutput([
      JSON.stringify({ type: 'step_start', part: { type: 'step-start' } }),
      JSON.stringify({ type: 'text', part: { type: 'text', text: '# Report\n\nDone.' } }),
      JSON.stringify({ type: 'step_finish', part: { type: 'step-finish' } }),
    ].join('\n'))).toEqual({ kind: 'text', content: '# Report\n\nDone.' });
  });

  it('classifies an OpenCode permission request without enabling auto approval', () => {
    const output = readOpenCodeRunOutput(JSON.stringify({
      type: 'permission.requested', part: { type: 'permission', tool: 'bash' },
    }));

    expect(output).toEqual({ kind: 'permission-request' });
    expect(describeOpenCodeRunOutput(output)).toContain('never enables --auto');
  });
});
