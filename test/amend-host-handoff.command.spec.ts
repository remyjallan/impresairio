import { describe, expect, it, vi } from 'vitest';
import { AmendHostHandoffCommand } from '../src/commands/amend-host-handoff.command';

describe('amend-host-handoff command', () => {
  it('passes the required audited reason to the amendment service', async () => {
    const amendments = { amend: vi.fn() };
    const command = new AmendHostHandoffCommand(amendments as never);

    await command.run(['run-42', 'brainstorm'], { reason: 'Add the confirmed decision.' });

    expect(amendments.amend).toHaveBeenCalledWith('run-42', 'brainstorm', 'Add the confirmed decision.');
    expect(command.parseReason('record this reason')).toBe('record this reason');
  });

  it('rejects a missing or oversized reason before it reaches the service', async () => {
    const amendments = { amend: vi.fn() };
    const command = new AmendHostHandoffCommand(amendments as never);

    await expect(command.run(['run-42', 'brainstorm'], {})).rejects.toThrow('requires --reason');
    await expect(command.run(['run-42', 'brainstorm'], { reason: 'x'.repeat(1_001) })).rejects.toThrow('must not exceed');

    expect(amendments.amend).not.toHaveBeenCalled();
  });
});
