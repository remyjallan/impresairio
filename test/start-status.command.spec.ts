import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { StartCommand } from '../src/commands/start.command';
import { StatusCommand } from '../src/commands/status.command';
import { HomeDirectoryResolver } from '../src/config/home-directory.resolver';
import { EventLogService } from '../src/runs/event-log.service';
import { FileStateStore } from '../src/runs/file-state.store';
import { RunLockService } from '../src/runs/run-lock.service';
import { RunService } from '../src/runs/run.service';

const temporaryDirectories: string[] = [];

function createRunService() {
  const home = mkdtempSync(join(tmpdir(), 'impresairio-run-'));
  temporaryDirectories.push(home);
  const resolver = new HomeDirectoryResolver({ IMPRESAIRIO_HOME: home });
  const store = new FileStateStore(resolver);
  const events = new EventLogService(resolver);
  const locks = new RunLockService(store, events, {
    hostname: 'local-machine', pid: 4242, isPidActive: () => false,
    now: () => new Date('2026-07-20T10:00:00.000Z'),
  });
  return { store, events, service: new RunService(store, events, locks, () => new Date('2026-07-20T10:00:00.000Z')) };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('start and status commands', () => {
  it('creates a run state and renders its workflow and step status', async () => {
    const { store, service } = createRunService();
    const start = new StartCommand(service, () => undefined);
    const output: string[] = [];
    const status = new StatusCommand(store, (line) => output.push(line));

    await start.run(['quick-fix'], {
      launcher: 'claude', adversary: 'codex', implementer: 'opencode-glm',
      documentationRoot: '/tmp/documentation',
      runId: 'run-quick-fix',
    });
    await status.run(['run-quick-fix']);

    expect(store.findState('run-quick-fix')).toEqual(expect.objectContaining({
      workflow: expect.objectContaining({ id: 'quick-fix' }),
      roles: { launcher: 'claude', adversary: 'codex', implementer: 'opencode-glm' },
      documentationRoot: '/tmp/documentation',
      steps: [],
    }));
    expect(output.join('')).toContain('run-quick-fix');
    expect(output.join('')).toContain('workflow: quick-fix');
    expect(output.join('')).toContain('steps: 0');
  });
});
