import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { Injectable } from '@nestjs/common';
import type { CompletionRun, CompletionStep, PatchApplication, PatchApplier } from './completion.service';

export class RepositoryPatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RepositoryPatchError';
  }
}

@Injectable()
export class RepositoryPatchService implements PatchApplier {
  apply(
    run: CompletionRun,
    step: CompletionStep,
    markdown: string,
    appliedAt: string,
  ): PatchApplication {
    if (step.patch !== 'apply-unified-diff') {
      throw new RepositoryPatchError(`Step ${step.id} does not declare a patch contract`);
    }
    if (!run.repositoryDirectory) {
      throw new RepositoryPatchError(`Run ${run.id} has no frozen repository directory`);
    }

    const repository = realpathSync(run.repositoryDirectory);
    const topLevel = this.git(repository, ['rev-parse', '--show-toplevel']).stdout.trim();
    if (!topLevel || realpathSync(topLevel) !== repository) {
      throw new RepositoryPatchError(`Run repository is not the Git worktree root: ${repository}`);
    }

    const patch = parseUnifiedPatch(markdown);
    const currentDiff = this.git(repository, ['diff', '--binary']).stdout;
    const currentSha256 = sha256(currentDiff);
    if (!run.repositoryPatch && currentDiff.length > 0) {
      throw new RepositoryPatchError('Repository has tracked changes; apply the patch from a clean worktree');
    }
    if (run.repositoryPatch && currentSha256 !== run.repositoryPatch.currentSha256) {
      throw new RepositoryPatchError('Repository changed outside this run after an earlier patch was applied');
    }
    if (this.git(repository, ['diff', '--cached', '--quiet']).status !== 0) {
      throw new RepositoryPatchError('Repository has staged changes; apply the patch from a clean index');
    }

    for (const path of patch.paths) {
      if (this.git(repository, ['ls-files', '--error-unmatch', '--', path]).status !== 0) {
        throw new RepositoryPatchError(`Patch path is not an existing tracked file: ${path}`);
      }
    }

    // Models frequently preserve the exact changed lines but miscount hunk
    // lengths. `--recount` still requires every context line to match; it
    // only recalculates those redundant header counts before applying.
    this.requireSuccess(repository, ['apply', '--check', '--recount', '--whitespace=error'], patch.content, 'Patch cannot be applied');
    this.requireSuccess(repository, ['apply', '--recount', '--whitespace=error'], patch.content, 'Patch could not be applied');
    const nextDiff = this.git(repository, ['diff', '--binary']).stdout;

    return {
      patch: { sha256: sha256(patch.content), paths: [...patch.paths], appliedAt },
      repositoryPatch: {
        baselineSha256: run.repositoryPatch?.baselineSha256 ?? currentSha256,
        currentSha256: sha256(nextDiff),
      },
    };
  }

  private git(repository: string, args: readonly string[], input?: string): { readonly status: number; readonly stdout: string; readonly stderr: string } {
    const result = spawnSync('git', ['-C', repository, ...args], {
      encoding: 'utf8', input, timeout: 30_000, maxBuffer: 4 * 1024 * 1024,
    });
    if (result.error) throw new RepositoryPatchError(`Could not execute git: ${result.error.message}`);
    return { status: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  }

  private requireSuccess(repository: string, args: readonly string[], input: string, message: string): void {
    const result = this.git(repository, args, input);
    if (result.status === 0) return;
    const detail = (result.stderr || result.stdout).trim();
    throw new RepositoryPatchError(detail ? `${message}: ${detail}` : message);
  }
}

function parseUnifiedPatch(markdown: string): { readonly content: string; readonly paths: readonly string[] } {
  const matches = [...markdown.matchAll(/```impresairio-patch\r?\n([\s\S]*?)\r?\n```/g)];
  if (matches.length !== 1) {
    throw new RepositoryPatchError('Expected exactly one impresairio-patch fenced block');
  }
  const content = matches[0][1];
  if (/^(?:new file mode|deleted file mode|rename from |rename to |--- \/dev\/null|\+\+\+ \/dev\/null)$/m.test(content)) {
    throw new RepositoryPatchError('Patch may modify existing tracked files only; additions, deletions and renames are not allowed');
  }
  const pairs = gitPathPairs(content);
  if (pairs.length === 0) {
    throw new RepositoryPatchError('Patch must contain at least one unified diff file pair');
  }
  const paths = pairs.map(([before, after]) => {
    if (before !== after || !isSafeTrackedPath(before)) {
      throw new RepositoryPatchError(`Patch may only modify safe existing paths, received ${before} -> ${after}`);
    }
    return before;
  });
  return { content: content.endsWith('\n') ? content : `${content}\n`, paths: [...new Set(paths)] };
}

function gitPathPairs(content: string): Array<readonly [string, string]> {
  const gitHeaders = [...content.matchAll(/^diff --git a\/([^\s]+) b\/([^\s]+)$/gm)];
  if (gitHeaders.length > 0) return gitHeaders.map((header) => [header[1], header[2]] as const);

  return [...content.matchAll(/^--- a\/([^\t\s]+)(?:\t.*)?\r?\n\+\+\+ b\/([^\t\s]+)(?:\t.*)?$/gm)]
    .map((header) => [header[1], header[2]] as const);
}

function isSafeTrackedPath(path: string): boolean {
  return /^[A-Za-z0-9._/-]+$/.test(path)
    && path.split('/').every((segment) => segment.length > 0 && segment !== '.' && segment !== '..' && segment !== '.git');
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
