import { Inject, Injectable } from '@nestjs/common';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { EventLogService } from './event-log.service';
import { FileStateStore } from './file-state.store';
import { assertValidRunId } from './run-id';

export interface RunLockMetadata {
  readonly pid: number;
  readonly hostname: string;
  readonly command: string;
  readonly createdAt: string;
  readonly token: string;
}

export interface RunLockRuntime {
  readonly hostname: string;
  readonly pid: number;
  readonly now: () => Date;
  readonly isPidActive: (pid: number) => boolean;
}

const nativeRuntime: RunLockRuntime = {
  hostname: hostname(),
  pid: process.pid,
  now: () => new Date(),
  isPidActive: (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  },
};

export const RUN_LOCK_RUNTIME = Symbol('RUN_LOCK_RUNTIME');

export class RunBusyError extends Error {
  constructor(runId: string) {
    super(`run busy: ${runId}`);
    this.name = 'RunBusyError';
  }
}

export class UnlockRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnlockRefusedError';
  }
}

@Injectable()
export class RunLockService {
  private readonly runtime: RunLockRuntime;
  private readonly locallyHeld = new Map<string, { depth: number; token: string; reentrant: boolean }>();

  constructor(
    @Inject(FileStateStore)
    private readonly stateStore: FileStateStore,
    @Inject(EventLogService)
    private readonly eventLog: EventLogService,
    @Inject(RUN_LOCK_RUNTIME)
    runtime: Partial<RunLockRuntime> = {},
  ) {
    this.runtime = { ...nativeRuntime, ...runtime };
  }

  acquire(runId: string, command: string): () => void {
    return this.acquireInternal(runId, command, false);
  }

  /** Own a run across a composite command whose internal services also lock it. */
  acquireReentrant(runId: string, command: string): () => void {
    return this.acquireInternal(runId, command, true);
  }

  private acquireInternal(runId: string, command: string, reentrant: boolean): () => void {
    assertValidRunId(runId);
    const held = this.locallyHeld.get(runId);
    if (held) {
      if (!held.reentrant) throw new RunBusyError(runId);
      held.depth += 1;
      return this.releaseLocal(runId, held.token);
    }
    const metadata: RunLockMetadata = {
      pid: this.runtime.pid,
      hostname: this.runtime.hostname,
      command,
      createdAt: this.runtime.now().toISOString(),
      token: randomUUID(),
    };

    if (!this.tryCreate(runId, metadata)) {
      const existing = this.read(runId);
      if (existing && this.isStaleLocalLock(existing)) {
        this.remove(runId);
        if (!this.tryCreate(runId, metadata)) {
          throw new RunBusyError(runId);
        }
        this.eventLog.append(runId, {
          type: 'run.lock.recovered',
          at: this.runtime.now().toISOString(),
          previousPid: existing.pid,
        });
      } else {
        throw new RunBusyError(runId);
      }
    }

    this.locallyHeld.set(runId, { depth: 1, token: metadata.token, reentrant });
    return this.releaseLocal(runId, metadata.token);
  }

  private releaseLocal(runId: string, token: string): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const held = this.locallyHeld.get(runId);
      if (!held || held.token !== token) return;
      held.depth -= 1;
      if (held.depth > 0) return;
      this.locallyHeld.delete(runId);
      const current = this.read(runId);
      if (current?.token === token) this.remove(runId);
    };
  }

  unlock(runId: string, force: boolean): void {
    const lock = this.read(runId);
    if (!lock) {
      if (this.lockExists(runId)) {
        if (!force) {
          throw new UnlockRefusedError(
            `Lock metadata is missing or invalid for run ${runId}; rerun with --force after confirming the owner is stopped`,
          );
        }
        this.remove(runId);
        this.eventLog.append(runId, {
          type: 'run.unlock.forced',
          at: this.runtime.now().toISOString(),
          previousLockMetadata: 'unavailable',
        });
      }
      return;
    }

    if (!force && lock.hostname !== this.runtime.hostname) {
      throw new UnlockRefusedError(
        `Cannot unlock run ${runId} from ${lock.hostname}; rerun with --force after confirming the owner is stopped`,
      );
    }
    if (!force && this.runtime.isPidActive(lock.pid)) {
      throw new UnlockRefusedError(
        `Run ${runId} is owned by active local PID ${lock.pid}; stop it or rerun with --force`,
      );
    }

    this.remove(runId);
    if (force) {
      this.eventLog.append(runId, {
        type: 'run.unlock.forced',
        at: this.runtime.now().toISOString(),
        previousPid: lock.pid,
        previousHostname: lock.hostname,
      });
    } else {
      this.eventLog.append(runId, {
        type: 'run.unlock.stale',
        at: this.runtime.now().toISOString(),
        previousPid: lock.pid,
      });
    }
  }

  private tryCreate(runId: string, metadata: RunLockMetadata): boolean {
    const directory = this.lockDirectory(runId);
    try {
      this.stateStore.fileOperations.mkdirSync(this.stateStore.runDirectory(runId), {
        recursive: true,
      });
      this.stateStore.fileOperations.mkdirSync(directory);
    } catch (error) {
      if (this.stateStore.fileOperations.existsSync(directory)) {
        return false;
      }
      throw error;
    }

    try {
      this.stateStore.fileOperations.writeFileSync(
        this.metadataPath(runId),
        `${JSON.stringify(metadata, null, 2)}\n`,
        'utf8',
      );
      return true;
    } catch (error) {
      this.stateStore.fileOperations.rmSync(directory, { recursive: true, force: true });
      throw error;
    }
  }

  private read(runId: string): RunLockMetadata | undefined {
    const path = this.metadataPath(runId);
    if (!this.stateStore.fileOperations.existsSync(path)) {
      return undefined;
    }
    try {
      const value = JSON.parse(this.stateStore.fileOperations.readFileSync(path, 'utf8')) as unknown;
      if (!this.isMetadata(value)) {
        return undefined;
      }
      return value;
    } catch {
      return undefined;
    }
  }

  private isStaleLocalLock(lock: RunLockMetadata): boolean {
    return lock.hostname === this.runtime.hostname
      && lock.pid !== this.runtime.pid
      && !this.runtime.isPidActive(lock.pid);
  }

  private remove(runId: string): void {
    this.stateStore.fileOperations.rmSync(this.lockDirectory(runId), {
      recursive: true,
      force: true,
    });
  }

  private lockDirectory(runId: string): string {
    assertValidRunId(runId);
    return join(this.stateStore.runDirectory(runId), '.lock');
  }

  private lockExists(runId: string): boolean {
    return this.stateStore.fileOperations.existsSync(this.lockDirectory(runId));
  }

  private metadataPath(runId: string): string {
    return join(this.lockDirectory(runId), 'metadata.json');
  }

  private isMetadata(value: unknown): value is RunLockMetadata {
    if (!value || typeof value !== 'object') {
      return false;
    }
    const candidate = value as Record<string, unknown>;
    return typeof candidate.pid === 'number'
      && typeof candidate.hostname === 'string'
      && typeof candidate.command === 'string'
      && typeof candidate.createdAt === 'string'
      && typeof candidate.token === 'string';
  }
}
