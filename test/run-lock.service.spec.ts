import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HomeDirectoryResolver } from '../src/config/home-directory.resolver';
import { EventLogService } from '../src/runs/event-log.service';
import { FileStateStore } from '../src/runs/file-state.store';
import {
  RunBusyError,
  RunLockService,
  UnlockRefusedError,
} from '../src/runs/run-lock.service';

const temporaryDirectories: string[] = [];

function createServices(options?: { readonly hostname?: string; readonly isPidActive?: (pid: number) => boolean }) {
  const home = mkdtempSync(join(tmpdir(), 'impresairio-lock-'));
  temporaryDirectories.push(home);
  const resolver = new HomeDirectoryResolver({ IMPRESAIRIO_HOME: home });
  const stateStore = new FileStateStore(resolver);
  const eventLog = new EventLogService(resolver);
  const lock = new RunLockService(stateStore, eventLog, {
    hostname: options?.hostname ?? 'local-machine',
    pid: 4242,
    isPidActive: options?.isPidActive ?? (() => false),
    now: () => new Date('2026-07-20T10:00:00.000Z'),
  });
  return { home, stateStore, eventLog, lock };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('RunLockService', () => {
  it('acquires exclusively and releases the lock', () => {
    const { lock } = createServices();
    const release = lock.acquire('run-1', 'status');

    expect(() => lock.acquire('run-1', 'status')).toThrow(RunBusyError);
    release();
    expect(() => lock.acquire('run-1', 'status')).not.toThrow();
  });

  it('refuses an active local PID', () => {
    const { stateStore, eventLog } = createServices();
    const owner = new RunLockService(stateStore, eventLog, {
      hostname: 'local-machine', pid: 9999, isPidActive: () => true,
    });
    owner.acquire('run-1', 'start');
    const otherProcessLock = new RunLockService(
      stateStore,
      eventLog,
      { hostname: 'local-machine', pid: 4242, isPidActive: () => true },
    );

    expect(() => otherProcessLock.acquire('run-1', 'next')).toThrow('run busy');
  });

  it('removes a stale local PID before acquiring', () => {
    const { lock, stateStore, eventLog } = createServices({ isPidActive: () => false });
    const first = new RunLockService(stateStore, eventLog, {
      hostname: 'local-machine', pid: 9999, isPidActive: () => false,
    });
    first.acquire('run-1', 'next');

    expect(() => lock.acquire('run-1', 'next')).not.toThrow();
  });

  it('requires force to remove a remote lock and logs a forced unlock', () => {
    const { lock, stateStore, eventLog } = createServices();
    const remote = new RunLockService(stateStore, eventLog, {
      hostname: 'other-machine', pid: 9999, isPidActive: () => true,
    });
    remote.acquire('run-1', 'next');

    expect(() => lock.unlock('run-1', false)).toThrow(UnlockRefusedError);
    lock.unlock('run-1', true);

    expect(eventLog.read('run-1')).toContainEqual(expect.objectContaining({
      type: 'run.unlock.forced',
    }));
  });

  it('only force-unlocks an incomplete lock and records the recovery', () => {
    const { lock, stateStore, eventLog } = createServices();
    mkdirSync(join(stateStore.runDirectory('run-1'), '.lock'), { recursive: true });

    expect(() => lock.unlock('run-1', false)).toThrow('metadata is missing or invalid');
    lock.unlock('run-1', true);

    expect(eventLog.read('run-1')).toContainEqual(expect.objectContaining({
      type: 'run.unlock.forced',
      previousLockMetadata: 'unavailable',
    }));
    expect(() => lock.acquire('run-1', 'next')).not.toThrow();
  });

  it('rejects unsafe run IDs before touching the lock path', () => {
    const { lock } = createServices();

    expect(() => lock.acquire('../outside', 'next')).toThrow('Invalid run ID');
  });
});
