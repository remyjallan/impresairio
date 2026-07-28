import { Inject, Injectable, Optional } from '@nestjs/common';
import { Command, CommandRunner, Option } from 'nest-commander';
import { EventLogService, type RunEvent } from '../runs/event-log.service';
import { FileStateStore } from '../runs/file-state.store';

export const FOLLOW_WRITER = Symbol('FOLLOW_WRITER');
export const FOLLOW_PROCESS_ALIVE = Symbol('FOLLOW_PROCESS_ALIVE');

const DEFAULT_IDLE_TIMEOUT_MS = 90_000;

interface FollowOptions { readonly intervalMs?: number; readonly idleTimeoutMs?: number; }

@Injectable()
@Command({ name: 'follow', arguments: '<run-id>', description: 'Follow durable progress from a detached advance process until it stops.' })
export class FollowCommand extends CommandRunner {
  constructor(
    private readonly stateStore: FileStateStore,
    private readonly events: EventLogService,
    @Inject(FOLLOW_WRITER) private readonly write: (line: string) => void = (line) => process.stdout.write(line),
    @Optional() @Inject(FOLLOW_PROCESS_ALIVE) private readonly processAlive: (pid: number) => boolean = isProcessAlive,
  ) { super(); }

  async run([runId]: string[], options: FollowOptions = {}): Promise<void> {
    let offset = 0;
    const intervalMs = options.intervalMs ?? 1_000;
    const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    const startedAt = Date.now();
    for (;;) {
      const state = this.stateStore.findState(runId);
      if (!state) throw new Error(`Run not found: ${runId}`);
      const events = this.events.read(runId);
      for (const event of events.slice(offset)) this.write(`${formatFollowEvent(event)}\n`);
      offset = events.length;
      const hasActiveStep = state.steps.some((step) => step.status === 'in_progress');
      const detachedProcess = mostRecentDetachedProcess(events);
      if (detachedProcess !== undefined && !this.processAlive(detachedProcess)) {
        if (hasActiveStep) {
          throw new Error(`Detached advance process ${detachedProcess} is no longer running; the run is still in progress. Use status to inspect it, then retry or abandon it.`);
        }
        return;
      }
      if (!hasActiveStep) return;
      const lastActivityAt = latestEventTimestamp(events) ?? startedAt;
      if (Date.now() - lastActivityAt > idleTimeoutMs) {
        throw new Error(`Run ${runId} has been in progress without durable activity for more than ${idleTimeoutMs}ms; use status to inspect it, then retry or abandon it.`);
      }
      await new Promise<void>((resolve) => setTimeout(resolve, intervalMs));
    }
  }

  @Option({ flags: '--interval-ms <milliseconds>', description: 'Polling interval while following (default: 1000).' })
  parseInterval(value: string): number {
    const interval = Number(value);
    if (!Number.isInteger(interval) || interval < 100 || interval > 60_000) {
      throw new Error('follow --interval-ms must be an integer between 100 and 60000');
    }
    return interval;
  }

  @Option({ flags: '--idle-timeout-ms <milliseconds>', description: 'Stop if an active run has no durable progress (default: 90000).' })
  parseIdleTimeout(value: string): number {
    const timeout = Number(value);
    if (!Number.isInteger(timeout) || timeout < 30_000 || timeout > 3_600_000) {
      throw new Error('follow --idle-timeout-ms must be an integer between 30000 and 3600000');
    }
    return timeout;
  }
}

function formatFollowEvent(event: RunEvent): string {
  if (event.type === 'agent.execution.progress') {
    return `step: ${String(event.stepId)} running (elapsed: ${String(event.elapsedSeconds)}s)`;
  }
  return `${event.at} ${event.type}${event.stepId ? ` (${String(event.stepId)})` : ''}`;
}

function mostRecentDetachedProcess(events: readonly RunEvent[]): number | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type === 'advance.detached' && typeof event.pid === 'number' && Number.isInteger(event.pid) && event.pid > 0) {
      return event.pid;
    }
  }
  return undefined;
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function latestEventTimestamp(events: readonly RunEvent[]): number | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const timestamp = Date.parse(events[index]?.at ?? '');
    if (!Number.isNaN(timestamp)) return timestamp;
  }
  return undefined;
}
