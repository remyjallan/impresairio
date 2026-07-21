import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import {
  type DocumentationTarget,
  type PreparedDocumentationOutput,
} from './documentation-target';

export class FilesystemDocumentationTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FilesystemDocumentationTargetError';
  }
}

export interface FilesystemDocumentationTargetHooks {
  readonly beforeDirectoryCreate?: (directory: string) => void;
  readonly beforeFileWrite?: (path: string) => void;
}

/**
 * V0's sole documentation target. Every mutating operation repeats its
 * containment check directly before the filesystem operation, so it rejects
 * symlinks observed after rendering and before a write. This is a best-effort
 * safeguard for a trusted local filesystem, not an atomic TOCTOU defence
 * against a hostile concurrent filesystem actor.
 */
export class FilesystemDocumentationTarget implements DocumentationTarget {
  constructor(private readonly hooks: FilesystemDocumentationTargetHooks = {}) {}

  ensureDirectory(output: PreparedDocumentationOutput): void {
    this.assertSafeLocation(output);
    this.ensureTargetRoot(output);

    const relativeDirectory = relative(output.targetRoot, output.directory);
    let currentDirectory = resolve(output.targetRoot);
    for (const segment of relativeDirectory.split(sep).filter(Boolean)) {
      currentDirectory = join(currentDirectory, segment);
      if (existsSync(currentDirectory)) {
        this.assertDirectory(currentDirectory);
        continue;
      }

      this.hooks.beforeDirectoryCreate?.(currentDirectory);
      this.assertSafeLocation(output);
      mkdirSync(currentDirectory);
    }
  }

  initializeIfAbsent(output: PreparedDocumentationOutput, content: string): void {
    this.ensureDirectory(output);
    if (existsSync(output.path)) {
      return;
    }

    this.hooks.beforeFileWrite?.(output.path);
    this.assertSafeLocation(output);

    try {
      writeFileSync(output.path, content, { encoding: 'utf8', flag: 'wx' });
    } catch (error) {
      if (this.isAlreadyExistsError(error)) {
        return;
      }
      throw error;
    }
  }

  writeVerifiedMarkdown(output: PreparedDocumentationOutput, content: string): void {
    if (content.trim().length === 0) {
      throw new FilesystemDocumentationTargetError('Documentation output must not be empty');
    }
    this.ensureDirectory(output);
    this.hooks.beforeFileWrite?.(output.path);
    this.assertSafeLocation(output);
    writeFileSync(output.path, content, 'utf8');
  }

  readVerifiedMarkdown(output: PreparedDocumentationOutput): string {
    this.assertSafeLocation(output);
    if (!existsSync(output.path)) {
      throw new FilesystemDocumentationTargetError(
        `Expected output does not exist: ${output.path}`,
      );
    }

    const stat = lstatSync(output.path);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new FilesystemDocumentationTargetError(
        `Expected output must be a regular file: ${output.path}`,
      );
    }

    const content = readFileSync(output.path, 'utf8');
    if (content.trim().length === 0) {
      throw new FilesystemDocumentationTargetError(
        `Expected output must not be empty: ${output.path}`,
      );
    }
    return content;
  }

  removeVerifiedMarkdown(output: PreparedDocumentationOutput): void {
    this.assertSafeLocation(output);
    if (!existsSync(output.path)) return;
    const stat = lstatSync(output.path);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new FilesystemDocumentationTargetError(`Expected output must be a regular file: ${output.path}`);
    }
    rmSync(output.path);
  }

  private ensureTargetRoot(output: PreparedDocumentationOutput): void {
    const targetRoot = resolve(output.targetRoot);
    if (existsSync(targetRoot)) {
      this.assertDirectory(targetRoot);
      return;
    }

    this.hooks.beforeDirectoryCreate?.(targetRoot);
    this.assertSafeLocation(output);
    mkdirSync(targetRoot);
  }

  private assertSafeLocation(output: PreparedDocumentationOutput): void {
    const targetRoot = resolve(output.targetRoot);
    const outputPath = resolve(output.path);
    const outputDirectory = resolve(output.directory);

    if (!isAbsolute(targetRoot) || !this.isContainedBy(targetRoot, outputPath)) {
      throw new FilesystemDocumentationTargetError(
        'Documentation output must remain inside its filesystem target',
      );
    }
    if (!this.isContainedBy(targetRoot, outputDirectory)) {
      throw new FilesystemDocumentationTargetError(
        'Documentation output directory must remain inside its filesystem target',
      );
    }

    this.assertNoSymbolicLinkInExistingAncestors(targetRoot);
    this.assertNoSymbolicLinkInExistingAncestors(outputPath);
  }

  private isContainedBy(root: string, candidate: string): boolean {
    const relativeCandidate = relative(root, candidate);
    return (
      relativeCandidate === '' ||
      (!relativeCandidate.startsWith(`..${sep}`) &&
        relativeCandidate !== '..' &&
        !isAbsolute(relativeCandidate))
    );
  }

  private assertNoSymbolicLinkInExistingAncestors(absolutePath: string): void {
    const parsedPath = parse(absolutePath);
    const segments = absolutePath
      .slice(parsedPath.root.length)
      .split(sep)
      .filter(Boolean);
    let ancestor = parsedPath.root;

    for (const segment of segments) {
      ancestor = join(ancestor, segment);
      if (!existsSync(ancestor)) {
        return;
      }
      if (lstatSync(ancestor).isSymbolicLink()) {
        throw new FilesystemDocumentationTargetError(
          `Documentation output must not traverse a symbolic link: ${ancestor}`,
        );
      }
    }
  }

  private assertDirectory(path: string): void {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new FilesystemDocumentationTargetError(
        `Documentation directory must be a non-symbolic-link directory: ${path}`,
      );
    }
  }

  private isAlreadyExistsError(error: unknown): boolean {
    return (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'EEXIST'
    );
  }
}
