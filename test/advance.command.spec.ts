import {
  boundedDiagnostic,
  createProviderExecutionError,
  executeAgentProcess,
  executionDirectory,
  extractContent,
  extractDeniedWriteContent,
  formatAgentProgress,
  prepareExecutionInvocation,
} from '../src/commands/advance.command';
import { describeOpenCodeRunOutput, readOpenCodeRunOutput } from '../src/agents/opencode.provider';
import { describe, expect, it } from 'vitest';

describe('advance command output recovery', () => {
  it('limits Codex writable access to the staging directory', () => {
    expect(prepareExecutionInvocation({
      command: 'codex',
      args: ['exec', '--sandbox', 'read-only'],
      input: 'write to /run/artifacts/report.md',
    }, '/run/artifacts/report.md', '/run/staging/implement.md')).toEqual({
      command: 'codex',
      args: ['exec', '--sandbox', 'read-only', '--add-dir', '/run/staging'],
      input: 'write to /run/staging/implement.md',
    });
  });

  it('uses the frozen repository and preserves caller-CWD fallback for legacy runs', () => {
    expect(executionDirectory('/workspace/project', '/caller')).toBe('/workspace/project');
    expect(executionDirectory(undefined, '/caller')).toBe('/caller');
  });

  it('extracts a structured Claude response', () => {
    expect(extractContent(JSON.stringify({
      result: JSON.stringify({ markdown: '# Review', verdict: 'APPROVED' }),
    }))).toBe('# Review\n\nVERDICT: APPROVED');
  });

  it('keeps OpenCode JSON progress out of the published Markdown and surfaces a permission request', () => {
    const output = readOpenCodeRunOutput(JSON.stringify({
      type: 'permission.requested', part: { type: 'permission', tool: 'bash' },
    }));

    expect(output).toEqual({ kind: 'permission-request' });
    expect(describeOpenCodeRunOutput(output)).toContain('review its focused permission rules');
  });

  it('recovers only content from a completed Claude Write denial', () => {
    expect(extractDeniedWriteContent(JSON.stringify({
      subtype: 'error_during_execution',
      permission_denials: [{ tool_name: 'Write', tool_input: { file_path: '/tmp/staging.md', content: '# Review\n\nVERDICT: APPROVED\n' } }],
    }), '/tmp/staging.md')).toBe('# Review\n\nVERDICT: APPROVED\n');
  });

  it('does not turn unrelated provider failures into artifact content', () => {
    expect(extractDeniedWriteContent(JSON.stringify({
      subtype: 'error_during_execution',
      permission_denials: [{ tool_name: 'Bash', tool_input: { file_path: '/tmp/staging.md', content: '# Not an artifact' } }],
    }), '/tmp/staging.md')).toBeUndefined();
  });

  it('does not recover a denied write for another path', () => {
    expect(extractDeniedWriteContent(JSON.stringify({
      subtype: 'error_during_execution',
      permission_denials: [{ tool_name: 'Write', tool_input: { file_path: '/tmp/other.md', content: '# Wrong artifact' } }],
    }), '/tmp/staging.md')).toBeUndefined();
  });

  it('formats safe progress without including the prompt and includes the selected model', () => {
    expect(formatAgentProgress('started', 'implement', {
      provider: 'opencode', profile: 'opencode-glm', invocation: { model: 'openrouter/z-ai/glm-5.2' },
    })).toBe('step: implement started (provider: opencode, profile: opencode-glm, model: openrouter/z-ai/glm-5.2)');
  });

  it('bounds and redacts provider diagnostics', () => {
    expect(boundedDiagnostic('token=abc123 password: secret-value Bearer abc.def')).toBe(
      'token=[REDACTED] password=[REDACTED] Bearer [REDACTED]',
    );
    expect(boundedDiagnostic('x'.repeat(2_000))).toHaveLength(1_000);
  });

  it('emits heartbeats while an asynchronous provider process is running', async () => {
    const heartbeats: number[] = [];
    const execution = await executeAgentProcess({
      command: process.execPath,
      args: ['-e', 'setTimeout(() => process.stdout.write("# Report"), 25)'],
      input: 'ignored',
    }, {
      cwd: process.cwd(),
      timeoutMs: 1_000,
      heartbeatIntervalMs: 1,
      onHeartbeat: (elapsedMs) => heartbeats.push(elapsedMs),
    });

    expect(execution.exitCode).toBe(0);
    expect(execution.stdout).toBe('# Report');
    expect(heartbeats.length).toBeGreaterThan(0);
  });

  it('captures bounded diagnostics for a failed provider and reports a safe error', async () => {
    const execution = await executeAgentProcess({
      command: process.execPath,
      args: ['-e', 'process.stderr.write("token=secret-value"); process.exit(2)'],
      input: 'ignored',
    }, { cwd: process.cwd(), timeoutMs: 1_000 });

    const error = createProviderExecutionError('test-provider', 'implement', execution);

    expect(execution.exitCode).toBe(2);
    expect(error.message).toContain('exited with status 2');
    expect(error.message).not.toContain('secret-value');
    expect(error.diagnostic.stderr).toBe('token=[REDACTED]');
  });

  it('captures empty output and a timeout as distinct provider outcomes', async () => {
    const empty = await executeAgentProcess({
      command: process.execPath,
      args: ['-e', 'process.exit(0)'],
      input: 'ignored',
    }, { cwd: process.cwd(), timeoutMs: 1_000 });
    const timedOut = await executeAgentProcess({
      command: process.execPath,
      args: ['-e', 'setTimeout(() => {}, 1_000)'],
      input: 'ignored',
    }, { cwd: process.cwd(), timeoutMs: 10 });

    expect(empty.exitCode).toBe(0);
    expect(empty.stdout).toBe('');
    expect(timedOut.timedOut).toBe(true);
    expect(createProviderExecutionError('test-provider', 'implement', timedOut).message).toContain('timed out');
  });
});
