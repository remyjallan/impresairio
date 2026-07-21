import { describe, expect, it } from 'vitest';
import { CodexProvider } from '../src/agents/codex.provider';

describe('CodexProvider', () => {
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
});
