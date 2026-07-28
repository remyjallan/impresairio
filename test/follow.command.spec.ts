import { describe, expect, it } from 'vitest';
import { FollowCommand, isProcessAlive } from '../src/commands/follow.command';

describe('follow command', () => {
  it('prints durable progress events and returns once no step is active', async () => {
    const output: string[] = [];
    const command = new FollowCommand(
      { findState: () => ({ steps: [{ id: 'review', status: 'complete' }] }) } as never,
      { read: () => [
        { type: 'agent.execution.started', at: '2026-07-27T10:00:00.000Z', stepId: 'review' },
        { type: 'agent.execution.progress', at: '2026-07-27T10:00:30.000Z', stepId: 'review', elapsedSeconds: 30 },
      ] } as never,
      (line) => output.push(line),
    );

    await command.run(['run-follow']);

    expect(output).toEqual([
      '2026-07-27T10:00:00.000Z agent.execution.started (review)\n',
      'step: review running (elapsed: 30s)\n',
    ]);
    expect(command.parseInterval('250')).toBe(250);
    expect(() => command.parseInterval('10')).toThrow('between 100 and 60000');
    expect(command.parseIdleTimeout('30000')).toBe(30000);
    expect(() => command.parseIdleTimeout('10')).toThrow('between 30000 and 3600000');
  });

  it('rejects an unknown run before waiting', async () => {
    const command = new FollowCommand({ findState: () => undefined } as never, { read: () => [] } as never, () => undefined);
    await expect(command.run(['missing'])).rejects.toThrow('Run not found: missing');
  });

  it('waits for an active detached step before returning', async () => {
    let reads = 0;
    const command = new FollowCommand(
      { findState: () => ({ steps: [{ id: 'review', status: reads++ === 0 ? 'in_progress' : 'complete' }] }) } as never,
      { read: () => [] } as never,
      () => undefined,
    );
    await command.run(['run-wait'], { intervalMs: 100 });
    expect(reads).toBe(2);
  });

  it('reports a crashed detached advance instead of polling indefinitely', async () => {
    const command = new FollowCommand(
      { findState: () => ({ steps: [{ id: 'review', status: 'in_progress' }] }) } as never,
      { read: () => [{ type: 'advance.detached', at: '2026-07-27T10:00:00.000Z', pid: 1234 }] } as never,
      () => undefined,
      () => false,
    );

    await expect(command.run(['run-crashed'])).rejects.toThrow('Detached advance process 1234 is no longer running');
  });

  it('returns if a detached process is gone before the run has an active step', async () => {
    const command = new FollowCommand(
      { findState: () => ({ steps: [{ id: 'review', status: 'pending' }] }) } as never,
      { read: () => [{ type: 'advance.detached', at: '2026-07-27T10:00:00.000Z', pid: 1234 }] } as never,
      () => undefined,
      () => false,
    );

    await expect(command.run(['run-not-started'])).resolves.toBeUndefined();
  });

  it('stops an active run with no durable activity even without a detached PID', async () => {
    const command = new FollowCommand(
      { findState: () => ({ steps: [{ id: 'review', status: 'in_progress' }] }) } as never,
      { read: () => [{ type: 'agent.execution.started', at: '2020-01-01T00:00:00.000Z', stepId: 'review' }] } as never,
      () => undefined,
    );

    await expect(command.run(['run-idle'], { idleTimeoutMs: 30_000 })).rejects.toThrow('without durable activity');
  });

  it('uses the follow start time when an event timestamp is invalid', async () => {
    let reads = 0;
    const command = new FollowCommand(
      { findState: () => ({ steps: [{ id: 'review', status: reads++ === 0 ? 'in_progress' : 'complete' }] }) } as never,
      { read: () => [{ type: 'agent.execution.started', at: 'not-a-timestamp', stepId: 'review' }] } as never,
      () => undefined,
    );

    await expect(command.run(['run-invalid-event'], { intervalMs: 100 })).resolves.toBeUndefined();
  });

  it('recognizes the current process as alive', () => {
    expect(isProcessAlive(process.pid)).toBe(true);
    expect(isProcessAlive(Number.MAX_SAFE_INTEGER)).toBe(false);
  });
});
