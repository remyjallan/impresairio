import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CompletionRun, CompletionStep } from '../src/runs/completion.service';
import { RepositoryPatchService } from '../src/runs/repository-patch.service';

const temporaryDirectories: string[] = [];

function repository(): string {
  const directory = mkdtempSync(join(tmpdir(), 'impresairio-patch-'));
  temporaryDirectories.push(directory);
  git(directory, ['init']);
  git(directory, ['config', 'user.email', 'test@example.com']);
  git(directory, ['config', 'user.name', 'Test User']);
  writeFileSync(join(directory, 'greet.ts'), "export const greet = (name: string) => `Hello, ${name}`;\n");
  git(directory, ['add', 'greet.ts']);
  git(directory, ['commit', '-m', 'initial']);
  return directory;
}

function git(directory: string, args: readonly string[]): void {
  const result = spawnSync('git', ['-C', directory, ...args], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
}

function run(directory: string): CompletionRun {
  return {
    id: 'run-patch', repositoryDirectory: directory, currentStepId: 'implement',
    steps: [step()],
  };
}

function step(): CompletionStep {
  return { id: 'implement', kind: 'agent', status: 'in_progress', patch: 'apply-unified-diff' };
}

function markdown(patch: string): string {
  return `# Implementation\n\nApplied the requested behavior.\n\n\`\`\`impresairio-patch\n${patch}\n\`\`\`\n`;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('RepositoryPatchService', () => {
  it('applies exactly one valid unified diff to an existing tracked file', () => {
    const directory = repository();
    const patch = [
      'diff --git a/greet.ts b/greet.ts',
      'index 55155b8..31f0b65 100644',
      '--- a/greet.ts',
      '+++ b/greet.ts',
      '@@ -1 +1 @@',
      '-export const greet = (name: string) => `Hello, ${name}`;',
      '+export const greet = (name: string) => `Hello, ${name}!`;',
    ].join('\n');

    const result = new RepositoryPatchService().apply(run(directory), step(), markdown(patch), '2026-07-21T12:00:00.000Z');

    expect(readFileSync(join(directory, 'greet.ts'), 'utf8')).toContain('Hello, ${name}!');
    expect(result.patch.paths).toEqual(['greet.ts']);
    expect(result.patch.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.repositoryPatch.baselineSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.repositoryPatch.currentSha256).not.toBe(result.repositoryPatch.baselineSha256);
  });

  it('accepts a standard unified diff without an optional diff --git header', () => {
    const directory = repository();
    const patch = [
      '--- a/greet.ts',
      '+++ b/greet.ts',
      '@@ -1 +1 @@',
      '-export const greet = (name: string) => `Hello, ${name}`;',
      '+export const greet = (name: string) => `Hello, ${name}!`;',
    ].join('\n');

    const result = new RepositoryPatchService().apply(run(directory), step(), markdown(patch), '2026-07-21T12:00:00.000Z');

    expect(readFileSync(join(directory, 'greet.ts'), 'utf8')).toContain('Hello, ${name}!');
    expect(result.patch.paths).toEqual(['greet.ts']);
  });

  it('recounts an otherwise applicable patch with model-generated hunk lengths', () => {
    const directory = repository();
    const patch = [
      'diff --git a/greet.ts b/greet.ts',
      '--- a/greet.ts',
      '+++ b/greet.ts',
      '@@ -1,4 +1,7 @@',
      '-export const greet = (name: string) => `Hello, ${name}`;',
      '+export const greet = (name: string) => `Hello, ${name}!`;',
    ].join('\n');

    new RepositoryPatchService().apply(run(directory), step(), markdown(patch), '2026-07-21T12:00:00.000Z');

    expect(readFileSync(join(directory, 'greet.ts'), 'utf8')).toContain('Hello, ${name}!');
  });

  it('rejects a missing patch block without changing the repository', () => {
    const directory = repository();

    expect(() => new RepositoryPatchService().apply(run(directory), step(), '# Implementation\n', '2026-07-21T12:00:00.000Z'))
      .toThrow('Expected exactly one impresairio-patch fenced block');
    expect(readFileSync(join(directory, 'greet.ts'), 'utf8')).toContain('Hello, ${name}`;');
  });

  it('rejects a patch that targets an untracked path', () => {
    const directory = repository();
    const patch = [
      'diff --git a/new.ts b/new.ts',
      'new file mode 100644',
      'index 0000000..e69de29',
      '--- /dev/null',
      '+++ b/new.ts',
      '@@ -0,0 +1 @@',
      '+export const value = 1;',
    ].join('\n');

    expect(() => new RepositoryPatchService().apply(run(directory), step(), markdown(patch), '2026-07-21T12:00:00.000Z'))
      .toThrow('additions, deletions and renames are not allowed');
  });

  it('rejects a patch that deletes a tracked file', () => {
    const directory = repository();
    const patch = [
      'diff --git a/greet.ts b/greet.ts',
      'deleted file mode 100644',
      'index 55155b8..0000000',
      '--- a/greet.ts',
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
      '-export const greet = (name: string) => `Hello, ${name}`;',
    ].join('\n');

    expect(() => new RepositoryPatchService().apply(run(directory), step(), markdown(patch), '2026-07-21T12:00:00.000Z'))
      .toThrow('additions, deletions and renames are not allowed');
    expect(readFileSync(join(directory, 'greet.ts'), 'utf8')).toContain('Hello, ${name}`;');
  });

  it('rejects external tracked changes after a previous run patch', () => {
    const directory = repository();
    const patch = [
      'diff --git a/greet.ts b/greet.ts',
      'index 55155b8..31f0b65 100644',
      '--- a/greet.ts',
      '+++ b/greet.ts',
      '@@ -1 +1 @@',
      '-export const greet = (name: string) => `Hello, ${name}`;',
      '+export const greet = (name: string) => `Hello, ${name}!`;',
    ].join('\n');
    const service = new RepositoryPatchService();
    const first = service.apply(run(directory), step(), markdown(patch), '2026-07-21T12:00:00.000Z');
    writeFileSync(join(directory, 'greet.ts'), "export const greet = (name: string) => `Hi, ${name}!`;\n");

    expect(() => service.apply({ ...run(directory), repositoryPatch: first.repositoryPatch }, step(), markdown(patch), '2026-07-21T12:01:00.000Z'))
      .toThrow('Repository changed outside this run');
  });
});
