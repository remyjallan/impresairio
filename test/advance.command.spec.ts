import {
  AdvanceCommand,
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
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

describe('advance command output recovery', () => {
  it('stops at a host handoff without dispatching an agent process', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const dispatch = { prepare: vi.fn() };
    try {
      const command = new AdvanceCommand(
        { next: () => ({ kind: 'host-handoff', stepId: 'host-review' }) } as never,
        dispatch as never,
        {} as never, {} as never, {} as never,
        { acquireReentrant: () => () => undefined } as never,
        {} as never, () => undefined,
        { prepare: () => ({ kind: 'host-handoff', stepId: 'host-review', protocolVersion: 1 }) } as never,
      );
      await command.run(['run-1']);
      expect(dispatch.prepare).not.toHaveBeenCalled();
      expect(write).toHaveBeenCalledWith(expect.stringContaining('"kind":"host-handoff"'));
    } finally {
      write.mockRestore();
    }
  });

  it('stages an agent invocation before publishing its output', async () => {
    const runDirectory = mkdtempSync(join(tmpdir(), 'impresairio-advance-'));
    const expectedOutputPath = join(runDirectory, 'artifacts', 'implement.md');
    let nextCall = 0;
    const command = new AdvanceCommand(
      { next: () => nextCall++ === 0
        ? { kind: 'agent', stepId: 'implement' }
        : { kind: 'complete' } } as never,
      { prepare: () => ({
        actor: 'agent', profile: 'codex', provider: 'codex',
        expectedOutput: { path: expectedOutputPath },
        invocation: { command: process.execPath, args: ['-e', 'process.stdout.write("# Result")'], input: expectedOutputPath },
      }) } as never,
      { complete: () => undefined } as never,
      {
        runDirectory: () => runDirectory,
        findState: () => ({
          execution: { agentTimeoutSeconds: 1 },
          steps: [{ id: 'implement', kind: 'agent', expectedOutput: { path: expectedOutputPath } }],
        }),
        markFailed: () => undefined,
      } as never,
      { publishMarkdown: () => undefined } as never,
      { acquireReentrant: () => () => undefined } as never,
      { append: () => undefined } as never,
      () => undefined,
    );

    try {
      await command.run(['run-1']);
    } finally {
      rmSync(runDirectory, { recursive: true, force: true });
    }
  });

  it('passes failed provider output to durable run-state recovery', async () => {
    const runDirectory = mkdtempSync(join(tmpdir(), 'impresairio-advance-failure-'));
    const markFailed = vi.fn();
    const command = new AdvanceCommand(
      { next: () => ({ kind: 'agent', stepId: 'implement' }) } as never,
      { prepare: () => ({
        actor: 'agent', profile: 'codex', provider: 'codex',
        expectedOutput: { path: join(runDirectory, 'artifacts', 'implement.md') },
        invocation: { command: process.execPath, args: ['-e', 'process.stdout.write("partial output"); process.exit(1)'], input: 'work' },
      }) } as never,
      {} as never,
      { runDirectory: () => runDirectory, findState: () => ({ execution: { agentTimeoutSeconds: 1 } }), markFailed } as never,
      {} as never,
      { acquireReentrant: () => () => undefined } as never,
      { append: () => undefined } as never,
      () => undefined,
    );

    try {
      await expect(command.run(['run-1'])).rejects.toThrow('exited with status 1');
      expect(markFailed).toHaveBeenCalledWith('run-1', 'implement', expect.stringContaining('exited with status 1'), 'partial output');
    } finally {
      rmSync(runDirectory, { recursive: true, force: true });
    }
  });

  it('records a non-Error completion failure as a durable diagnostic', async () => {
    const runDirectory = mkdtempSync(join(tmpdir(), 'impresairio-advance-non-error-'));
    const markFailed = vi.fn();
    const command = new AdvanceCommand(
      { next: () => ({ kind: 'agent', stepId: 'implement' }) } as never,
      { prepare: () => ({
        actor: 'agent', profile: 'codex', provider: 'codex',
        expectedOutput: { path: join(runDirectory, 'artifacts', 'implement.md') },
        invocation: { command: process.execPath, args: ['-e', 'process.stdout.write("result")'], input: 'work' },
      }) } as never,
      { complete: () => { throw 'completion failed'; } } as never,
      { runDirectory: () => runDirectory, findState: () => ({ execution: { agentTimeoutSeconds: 1 }, steps: [{ id: 'implement', kind: 'agent', expectedOutput: { path: join(runDirectory, 'artifacts', 'implement.md') } }] }), markFailed } as never,
      { publishMarkdown: () => undefined } as never,
      { acquireReentrant: () => () => undefined } as never,
      { append: () => undefined } as never,
      () => undefined,
    );

    try {
      await expect(command.run(['run-1'])).rejects.toBe('completion failed');
      expect(markFailed).toHaveBeenCalledWith('run-1', 'implement', 'completion failed', 'result');
    } finally {
      rmSync(runDirectory, { recursive: true, force: true });
    }
  });

  it('limits Codex writable access to the staging directory', () => {
    expect(prepareExecutionInvocation({
      command: 'codex',
      args: ['exec', '--sandbox', 'read-only'],
      input: 'write to /run/artifacts/report.md',
    }, '/run/artifacts/report.md', '/run/staging/implement/artifact.md')).toEqual({
      command: 'codex',
      args: ['exec', '--sandbox', 'read-only', '--add-dir', '/run/staging/implement'],
      input: 'write to /run/staging/implement/artifact.md',
    });
  });

  it('rewrites Claude artifact paths without granting an additional directory', () => {
    expect(prepareExecutionInvocation({
      command: 'claude',
      args: ['--output', '/run/artifacts/review.md'],
      input: 'write to /run/artifacts/review.md',
    }, '/run/artifacts/review.md', '/run/staging/review/artifact.md')).toEqual({
      command: 'claude',
      args: ['--output', '/run/staging/review/artifact.md'],
      input: 'write to /run/staging/review/artifact.md',
    });
  });

  it('rewrites every argument occurrence while preserving unrelated invocation fields', () => {
    expect(prepareExecutionInvocation({
      command: 'codex',
      args: ['exec', '--output', '/run/artifacts/report.md', '--note', '/run/artifacts/report.md.bak'],
      input: 'write /run/artifacts/report.md and leave /run/artifacts/report.md.bak alone',
    }, '/run/artifacts/report.md', '/run/staging/review/artifact.md')).toEqual({
      command: 'codex',
      args: [
        'exec', '--output', '/run/staging/review/artifact.md', '--note', '/run/staging/review/artifact.md.bak',
        '--add-dir', '/run/staging/review',
      ],
      input: 'write /run/staging/review/artifact.md and leave /run/staging/review/artifact.md.bak alone',
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

  it('includes pinned reasoning effort in progress without exposing the prompt', () => {
    expect(formatAgentProgress('running', 'review', {
      provider: 'codex', profile: 'codex-sol',
      invocation: { model: 'gpt-5.6-sol', reasoningEffort: 'xhigh' },
    }, 2_200)).toBe('step: review running (provider: codex, profile: codex-sol, model: gpt-5.6-sol, reasoning effort: xhigh, elapsed: 2s)');
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
