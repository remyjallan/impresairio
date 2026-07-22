import { describe, expect, it } from 'vitest';
import { UnlockCommand } from '../src/commands/unlock.command';

describe('UnlockCommand', () => {
  it('confirms a successful unlock with a script-safe line', async () => {
    const unlocks: Array<{ readonly runId: string; readonly force: boolean }> = [];
    const output: string[] = [];
    const command = new UnlockCommand({
      unlock: (runId: string, force: boolean) => unlocks.push({ runId, force }),
    } as never, (line) => output.push(line));

    await command.run(['run-42'], { force: true });

    expect(unlocks).toEqual([{ runId: 'run-42', force: true }]);
    expect(output).toEqual(['unlocked: run-42\n']);
  });

  it('does not print confirmation when unlocking fails', async () => {
    const output: string[] = [];
    const command = new UnlockCommand({
      unlock: () => { throw new Error('lock is still active'); },
    } as never, (line) => output.push(line));

    await expect(command.run(['run-42'], {})).rejects.toThrow('lock is still active');
    expect(output).toEqual([]);
  });
});
