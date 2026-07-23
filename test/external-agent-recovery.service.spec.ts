import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ArtifactService } from '../src/documentation/artifact.service';
import { HomeDirectoryResolver } from '../src/config/home-directory.resolver';
import { NextCommand } from '../src/commands/next.command';
import { PrepareExternalAgentOutputCommand } from '../src/commands/prepare-external-agent-output.command';
import { SubmitAgentOutputCommand } from '../src/commands/submit-agent-output.command';
import { AgentRecoverySubmissionService } from '../src/runs/agent-recovery-submission.service';
import { ExternalAgentRecoveryService } from '../src/runs/external-agent-recovery.service';
import { EventLogService } from '../src/runs/event-log.service';
import { FileStateStore } from '../src/runs/file-state.store';
import { RunLockService } from '../src/runs/run-lock.service';
import { createRunState } from '../src/runs/run-state.schema';

const directories: string[] = [];

function harness() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'impresairio-external-recovery-')));
  directories.push(home);
  const resolver = new HomeDirectoryResolver({ IMPRESAIRIO_HOME: home });
  const store = new FileStateStore(resolver);
  const events = new EventLogService(resolver);
  const locks = new RunLockService(store, events, { hostname: 'local', pid: 4242, isPidActive: () => false });
  const initial = createRunState({
    id: 'run-external', workflowId: 'quick-fix', workflowSha256: 'a'.repeat(64), roles: {}, repositoryDirectory: home,
    documentation: {
      target: { name: 'test', kind: 'filesystem', root: home, defaultFormat: 'markdown' }, featurePath: 'Features/{{ feature.id }}',
      bindings: { project: { name: 'Test', slug: 'test' }, feature: { id: 'EXT-1', slug: 'recovery' }, run: { id: 'run-external' } },
    },
    steps: [{ id: 'implement', kind: 'agent', actor: 'implementer', action: 'implementation', patch: 'apply-unified-diff', output: { id: 'implementation', filename: 'Implementation.md', storage: 'internal' } }],
    now: '2026-07-23T12:00:00.000Z',
  });
  store.create({
    ...initial,
    currentStepId: 'implement',
    steps: initial.steps.map((step) => step.kind === 'agent'
      ? {
          ...step, status: 'failed' as const,
          expectedOutput: { id: 'implementation', targetRoot: home, directory: join(home, 'runs', 'run-external', 'artifacts'), path: join(home, 'runs', 'run-external', 'artifacts', 'Implementation.md'), format: 'markdown' as const },
          attempts: [{ number: 1, startedAt: '2026-07-23T12:00:00.000Z', inputArtifactHashes: {} }],
        }
      : step),
  });
  return { home, store, events, locks, recovery: new ExternalAgentRecoveryService(store, events, locks) };
}

afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

describe('ExternalAgentRecoveryService', () => {
  it('turns a failed patch step into an explicit host-to-runner handoff', () => {
    const { home, store, events, recovery } = harness();

    const handoff = recovery.prepare('run-external', 'implement', 'The configured provider produced an unappliable patch.');

    expect(handoff).toMatchObject({
      kind: 'external-agent-output', runId: 'run-external', stepId: 'implement', repositoryDirectory: home,
      expectedOutput: { id: 'implementation', maxBytes: 1_048_576 },
    });
    expect(handoff.instruction).toContain('submit-agent-output');
    expect(recovery.handoff('run-external', { kind: 'external-agent-output', stepId: 'implement' })).toMatchObject({
      kind: 'external-agent-output', stepId: 'implement', reason: 'The configured provider produced an unappliable patch.',
    });
    const prepared = store.findState('run-external');
    if (!prepared) throw new Error('missing prepared state');
    store.save({ ...prepared, repositoryDirectory: undefined });
    expect(recovery.handoff('run-external', { kind: 'external-agent-output', stepId: 'implement' })?.repositoryDirectory).toBe(process.cwd());
    expect(store.findState('run-external')?.steps[0]).toMatchObject({
      status: 'in_progress', externalRecovery: { reason: 'The configured provider produced an unappliable patch.' },
      attempts: [{ number: 1 }, { number: 2 }],
    });
    expect(events.read('run-external')).toContainEqual(expect.objectContaining({ type: 'agent.external_recovery.prepared', stepId: 'implement' }));
  });

  it('rejects invalid or unprepared external recovery transitions', () => {
    const { store, recovery } = harness();
    expect(() => recovery.prepare('run-external', 'missing', 'Manual recovery.')).toThrow('not a patch-producing agent step');
    expect(() => recovery.prepare('run-external', 'implement', '   ')).toThrow('reason must not be empty');
    expect(() => recovery.handoff('run-external', { kind: 'external-agent-output', stepId: 'implement' })).toThrow('has not been prepared');
    const state = store.findState('run-external');
    if (!state) throw new Error('missing run state');
    store.save({ ...state, steps: state.steps.map((step) => step.kind === 'agent' ? { ...step, status: 'pending' as const } : step) });
    expect(() => recovery.prepare('run-external', 'implement', 'Manual recovery.')).toThrow('must be a failed prepared agent step');
    expect(recovery.handoff('run-external', { kind: 'agent', stepId: 'implement' })).toBeUndefined();
  });

  it('prints the recovery envelope from next without invoking an agent provider', async () => {
    const { recovery } = harness();
    recovery.prepare('run-external', 'implement', 'Taking over the failed patch.');
    const output: string[] = [];
    const command = new NextCommand(
      { next: () => ({ kind: 'external-agent-output', stepId: 'implement' }) } as never,
      { prepare: () => undefined } as never,
      (line) => output.push(line),
      undefined,
      recovery,
    );

    await command.run(['run-external']);

    expect(JSON.parse(output.join(''))).toMatchObject({ kind: 'external-agent-output', stepId: 'implement' });
  });

  it('requires a reason before the CLI prepares a recovery envelope', async () => {
    const { recovery } = harness();
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const command = new PrepareExternalAgentOutputCommand(recovery);

    try {
      expect(command.parseReason('Manual patch recovery.')).toBe('Manual patch recovery.');
      await expect(command.run(['run-external', 'implement'], {})).rejects.toThrow('requires --reason');
      await command.run(['run-external', 'implement'], { reason: 'Manual patch recovery.' });
      expect(JSON.parse(String(write.mock.calls[0]?.[0]))).toMatchObject({ kind: 'external-agent-output', stepId: 'implement' });
    } finally {
      write.mockRestore();
    }
  });

  it('submits external Markdown through the runner-owned completion path', async () => {
    const { home, store, events, locks, recovery } = harness();
    recovery.prepare('run-external', 'implement', 'Taking over the failed patch.');
    const source = join(home, 'host-authored-patch.md');
    writeFileSync(source, '```impresairio-patch\ndiff --git a/a.ts b/a.ts\n```\n', 'utf8');
    const publishMarkdown = vi.fn();
    const complete = vi.fn();
    const submission = new AgentRecoverySubmissionService(
      store,
      { publishMarkdown } as unknown as ArtifactService,
      { complete } as never,
      events,
      locks,
    );

    await new SubmitAgentOutputCommand(submission).run(['run-external', 'implement', source]);

    expect(publishMarkdown).toHaveBeenCalledWith(expect.objectContaining({ id: 'implementation' }), expect.stringContaining('impresairio-patch'));
    expect(complete).toHaveBeenCalledWith('run-external', 'implement');
    expect(events.read('run-external')).toContainEqual(expect.objectContaining({ type: 'agent.external_recovery.submitted', stepId: 'implement' }));
  });

  it('rejects unprepared, inactive, and managed-file submissions', () => {
    const { home, store, events, locks, recovery } = harness();
    const submission = new AgentRecoverySubmissionService(store, {} as never, {} as never, events, locks);
    const source = join(home, 'response.md');
    writeFileSync(source, '# Response\n', 'utf8');
    expect(() => submission.submit('run-external', 'implement', source)).toThrow('not awaiting external agent output');
    recovery.prepare('run-external', 'implement', 'Manual recovery.');
    const prepared = store.findState('run-external');
    if (!prepared) throw new Error('missing prepared state');
    store.save({ ...prepared, currentStepId: undefined });
    expect(() => submission.submit('run-external', 'implement', source)).toThrow('is not awaiting output');
    store.save(prepared);
    const step = prepared.steps[0];
    if (!step || step.kind !== 'agent' || !step.expectedOutput) throw new Error('missing output');
    const managedPath = step.expectedOutput.path;
    expect(() => submission.submit('run-external', 'implement', managedPath)).toThrow('must not be the Impresairio-managed destination');
  });
});
