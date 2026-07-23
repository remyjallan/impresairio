import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AbandonCommand } from '../src/commands/abandon.command';
import { HomeDirectoryResolver } from '../src/config/home-directory.resolver';
import { EventLogService } from '../src/runs/event-log.service';
import { FileStateStore } from '../src/runs/file-state.store';
import { RunAbandonService } from '../src/runs/run-abandon.service';
import { RunLockService } from '../src/runs/run-lock.service';
import { assertRunActive, createRunState } from '../src/runs/run-state.schema';

const directories: string[] = [];

function harness() {
  const home = mkdtempSync(join(tmpdir(), 'impresairio-abandon-'));
  directories.push(home);
  const resolver = new HomeDirectoryResolver({ IMPRESAIRIO_HOME: home });
  const store = new FileStateStore(resolver);
  const events = new EventLogService(resolver);
  const locks = new RunLockService(store, events, { pid: process.pid, isPidActive: () => true });
  const service = new RunAbandonService(store, events, locks);
  const state = createRunState({
    id: 'run-abandon', workflowId: 'quick-fix', workflowSha256: 'a'.repeat(64), roles: {},
    documentation: {
      target: { name: 'test', kind: 'filesystem', root: home, defaultFormat: 'markdown' }, featurePath: 'Features/{{ feature.id }}',
      bindings: { project: { name: 'Test', slug: 'test' }, feature: { id: 'AB-1', slug: 'abandon' }, run: { id: 'run-abandon' } },
    },
    steps: [{ id: 'implement', kind: 'agent', actor: 'implementer', action: 'implementation', output: { id: 'report', filename: 'report.md' } }],
    now: '2026-07-23T12:00:00.000Z',
  });
  store.create({ ...state, steps: state.steps.map((step) => step.kind === 'agent' ? { ...step, status: 'failed' as const } : step) });
  return { store, events, locks, service };
}

afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

describe('RunAbandonService', () => {
  it('records an audited terminal abandonment with an external reference', () => {
    const { store, events, service } = harness();
    service.abandon('run-abandon', 'Delivered manually after provider failure.', 'abc123');
    expect(store.findState('run-abandon')?.abandonment).toMatchObject({ reason: 'Delivered manually after provider failure.', externalReference: 'abc123' });
    expect(events.read('run-abandon')).toContainEqual(expect.objectContaining({ type: 'run.abandoned', reason: 'Delivered manually after provider failure.', externalReference: 'abc123' }));
  });

  it('requires a reason and rejects completed, active, or already abandoned runs', () => {
    const { store, service } = harness();
    expect(() => service.abandon('run-abandon', '  ')).toThrow('reason must not be empty');
    const current = store.findState('run-abandon')!;
    store.save({ ...current, steps: current.steps.map((step) => step.kind === 'agent' ? { ...step, status: 'in_progress' as const } : step) });
    expect(() => service.abandon('run-abandon', 'stop')).toThrow('in-progress step');
    store.save({ ...current, steps: current.steps.map((step) => ({ ...step, status: 'complete' as const })) });
    expect(() => service.abandon('run-abandon', 'stop')).toThrow('already complete');
    store.save(current);
    service.abandon('run-abandon', 'stop');
    expect(() => service.abandon('run-abandon', 'again')).toThrow('already abandoned');
    expect(() => service.abandon('missing-run', 'stop')).toThrow('Run not found');
  });

  it('omits a blank external reference from the durable state and event', () => {
    const { store, events, service } = harness();
    service.abandon('run-abandon', '  Stop here.  ', '   ');
    expect(store.findState('run-abandon')?.abandonment).toMatchObject({ reason: 'Stop here.' });
    expect(store.findState('run-abandon')?.abandonment).not.toHaveProperty('externalReference');
    expect(events.read('run-abandon').at(-1)).not.toHaveProperty('externalReference');
  });

  it('exposes a required CLI reason', async () => {
    const { service } = harness();
    await expect(new AbandonCommand(service).run(['run-abandon'], {})).rejects.toThrow('abandon requires --reason');
  });

  it('passes command options through and rejects an abandoned state before a mutation', async () => {
    const { service, store } = harness();
    const command = new AbandonCommand(service);

    expect(command.parseReason('manual delivery')).toBe('manual delivery');
    expect(command.parseExternalReference('abc123')).toBe('abc123');
    await command.run(['run-abandon'], { reason: 'manual delivery', externalReference: 'abc123' });

    const state = store.findState('run-abandon')!;
    expect(() => assertRunActive(state)).toThrow('was abandoned');
  });
});
