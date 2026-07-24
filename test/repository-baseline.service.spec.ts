import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RepositoryBaselineError, RepositoryBaselineService } from '../src/runs/repository-baseline.service';

const temporaryDirectories: string[] = [];

function repository(): string {
  const directory = mkdtempSync(join(tmpdir(), 'impresairio-baseline-'));
  temporaryDirectories.push(directory);
  git(directory, ['init']);
  git(directory, ['config', 'user.email', 'test@example.com']);
  git(directory, ['config', 'user.name', 'Test User']);
  writeFileSync(join(directory, 'tracked.txt'), 'initial\n');
  git(directory, ['add', 'tracked.txt']);
  git(directory, ['commit', '-m', 'initial']);
  return directory;
}

function git(directory: string, args: readonly string[]): void {
  const result = spawnSync('git', ['-C', directory, ...args], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('RepositoryBaselineService', () => {
  it('captures a clean repository revision and accepts it while unchanged', () => {
    const directory = repository();
    const service = new RepositoryBaselineService();

    const baseline = service.capture(directory);

    expect(baseline.head).toMatch(/^[a-f0-9]{40}$/);
    expect(baseline.tree).toMatch(/^[a-f0-9]{40}$/);
    expect(() => service.assertCurrent(directory, baseline)).not.toThrow();
  });

  it('refuses a dirty working tree or staged index without modifying either', () => {
    const workingTree = repository();
    writeFileSync(join(workingTree, 'tracked.txt'), 'working change\n');
    expect(() => new RepositoryBaselineService().capture(workingTree))
      .toThrow('tracked changes; start from a clean worktree');

    const index = repository();
    writeFileSync(join(index, 'tracked.txt'), 'staged change\n');
    git(index, ['add', 'tracked.txt']);
    expect(() => new RepositoryBaselineService().capture(index))
      .toThrow('staged changes; start from a clean index');
  });

  it('requires a repository root and committed baseline', () => {
    const directory = repository();
    const nested = join(directory, 'nested');
    mkdirSync(nested);
    expect(() => new RepositoryBaselineService().capture(nested))
      .toThrow('require the Git worktree root');

    const empty = mkdtempSync(join(tmpdir(), 'impresairio-empty-git-'));
    temporaryDirectories.push(empty);
    git(empty, ['init']);
    expect(() => new RepositoryBaselineService().capture(empty))
      .toThrow('require a committed Git baseline');

    const nonGit = mkdtempSync(join(tmpdir(), 'impresairio-non-git-'));
    temporaryDirectories.push(nonGit);
    expect(() => new RepositoryBaselineService().capture(nonGit))
      .toThrow('require a Git worktree root');
    expect(() => new RepositoryBaselineService().capture(join(nonGit, 'missing')))
      .toThrow('Run repository is not readable');
  });

  it('rejects revision drift before another patch can be applied', () => {
    const directory = repository();
    const service = new RepositoryBaselineService();
    const baseline = service.capture(directory);
    writeFileSync(join(directory, 'tracked.txt'), 'committed change\n');
    git(directory, ['add', 'tracked.txt']);
    git(directory, ['commit', '-m', 'drift']);

    expect(() => service.assertCurrent(directory, baseline))
      .toThrow(RepositoryBaselineError);
    expect(() => service.assertCurrent(directory, baseline))
      .toThrow('Repository revision changed outside this run');
  });
});
