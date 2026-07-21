import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const projectRoot = resolve(__dirname, '..');

function helpFor(...arguments_: readonly string[]) {
  return spawnSync(
    process.execPath,
    ['dist/main.js', ...arguments_],
    { cwd: projectRoot, encoding: 'utf8' },
  );
}

describe('CLI help', () => {
  it('lists the supported V0 commands from the executable entrypoint', () => {
    const result = helpFor('--help');

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('Usage: impresairio [options] [command]');
    expect(result.stdout).toContain('start');
    expect(result.stdout).toContain('next');
    expect(result.stdout).toContain('approve');
    expect(result.stdout).toContain('request-changes');
    expect(result.stdout).toContain('retry');
    expect(result.stdout).toContain('complete');
    expect(result.stdout).toContain('status');
    expect(result.stdout).toContain('list');
    expect(result.stdout).toContain('doctor');
    expect(result.stdout).toContain('unlock');
  });

  it('documents required feature bindings on the start command', () => {
    const result = helpFor('start', '--help');

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('Usage: impresairio start [options] <workflow-id>');
    expect(result.stdout).toContain('--feature-id <id>');
    expect(result.stdout).toContain('--feature-slug <slug>');
    expect(result.stdout).toContain('--launcher <profile>');
    expect(result.stdout).toContain('--adversary <profile>');
    expect(result.stdout).toContain('--implementer <profile>');
  });
});
