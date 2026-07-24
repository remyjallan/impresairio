import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { Injectable } from '@nestjs/common';

export interface RepositoryBaseline {
  readonly head: string;
  readonly tree: string;
}

export class RepositoryBaselineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RepositoryBaselineError';
  }
}

/**
 * Captures the immutable Git revision that a patch-producing run is allowed to
 * start from. It never repairs or changes an operator worktree.
 */
@Injectable()
export class RepositoryBaselineService {
  capture(repositoryDirectory: string): RepositoryBaseline {
    const repository = this.requireWorktreeRoot(repositoryDirectory);
    this.requireClean(repository);
    return {
      head: this.readRevision(repository, 'HEAD'),
      tree: this.readRevision(repository, 'HEAD^{tree}'),
    };
  }

  assertCurrent(repositoryDirectory: string, baseline: RepositoryBaseline): void {
    const repository = this.requireWorktreeRoot(repositoryDirectory);
    const head = this.readRevision(repository, 'HEAD');
    const tree = this.readRevision(repository, 'HEAD^{tree}');
    if (head !== baseline.head || tree !== baseline.tree) {
      throw new RepositoryBaselineError(
        'Repository revision changed outside this run; reconcile the repository before applying another patch',
      );
    }
  }

  private requireWorktreeRoot(repositoryDirectory: string): string {
    let repository: string;
    try {
      repository = realpathSync(repositoryDirectory);
    } catch {
      throw new RepositoryBaselineError(`Run repository is not readable: ${repositoryDirectory}`);
    }
    const topLevel = this.git(repository, ['rev-parse', '--show-toplevel']);
    if (topLevel.status !== 0 || !topLevel.stdout.trim()) {
      throw new RepositoryBaselineError('Repository-patch workflows require a Git worktree root');
    }
    if (realpathSync(topLevel.stdout.trim()) !== repository) {
      throw new RepositoryBaselineError('Repository-patch workflows require the Git worktree root');
    }
    return repository;
  }

  private requireClean(repository: string): void {
    if (this.git(repository, ['diff', '--quiet']).status !== 0) {
      throw new RepositoryBaselineError('Repository has tracked changes; start from a clean worktree');
    }
    if (this.git(repository, ['diff', '--cached', '--quiet']).status !== 0) {
      throw new RepositoryBaselineError('Repository has staged changes; start from a clean index');
    }
  }

  private readRevision(repository: string, revision: string): string {
    const result = this.git(repository, ['rev-parse', '--verify', revision]);
    const value = result.stdout.trim();
    if (result.status !== 0 || !/^[a-f0-9]{40,64}$/.test(value)) {
      throw new RepositoryBaselineError('Repository-patch workflows require a committed Git baseline');
    }
    return value;
  }

  private git(repository: string, args: readonly string[]): { readonly status: number; readonly stdout: string } {
    const result = spawnSync('git', ['-C', repository, ...args], {
      encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024,
    });
    if (result.error) throw new RepositoryBaselineError(`Could not execute git: ${result.error.message}`);
    return { status: result.status ?? 1, stdout: result.stdout ?? '' };
  }
}
