import { describe, expect, it } from 'vitest';
import { DoctorCommand } from '../src/commands/doctor.command';

describe('DoctorCommand', () => {
  it('renders frozen model and reasoning settings when they are configured', async () => {
    const output: string[] = [];
    const command = new DoctorCommand({
      check: () => [
        { profile: 'claude-fast', provider: 'claude-code', model: 'sonnet', reasoningEffort: 'medium', ok: true, detail: 'live probe succeeded' },
        { profile: 'opencode-glm', provider: 'opencode', model: 'openrouter/z-ai/glm-5.2', ok: true, detail: 'live probe succeeded' },
        { profile: 'defaults', provider: 'codex', ok: true, detail: 'executable available' },
      ],
    } as never, (line) => output.push(line));

    await command.run([], { live: true });

    expect(output.join('')).toBe([
      'OK\tclaude-fast\tclaude-code (model=sonnet, reasoningEffort=medium)\tlive probe succeeded\n',
      'OK\topencode-glm\topencode (model=openrouter/z-ai/glm-5.2)\tlive probe succeeded\n',
      'OK\tdefaults\tcodex\texecutable available\n',
    ].join(''));
  });

  it('reports a failed check after rendering it', async () => {
    const output: string[] = [];
    const command = new DoctorCommand({
      check: () => [{ profile: 'codex-sol', provider: 'codex', model: 'gpt-5.6-sol', reasoningEffort: 'xhigh', ok: false, detail: 'authentication failed' }],
    } as never, (line) => output.push(line));

    await expect(command.run([], {})).rejects.toThrow('One or more agent checks failed.');
    expect(output.join('')).toContain('FAIL\tcodex-sol\tcodex (model=gpt-5.6-sol, reasoningEffort=xhigh)\tauthentication failed');
  });
});
