import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const projectRoot = resolve(__dirname, '..');

describe('impresairio status', () => {
  it('builds the CLI before npm packages it', () => {
    const packageJson = JSON.parse(
      readFileSync(resolve(projectRoot, 'package.json'), 'utf8'),
    ) as { scripts?: Record<string, string> };

    expect(packageJson.scripts?.prepack).toBe('pnpm run build');
  });

  it('fails with a stable error when the run does not exist', () => {
    const result = spawnSync(
      process.execPath,
      ['dist/main.js', 'status', 'unknown-run'],
      {
        cwd: projectRoot,
        encoding: 'utf8',
      },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Run not found: unknown-run');
  });
});
