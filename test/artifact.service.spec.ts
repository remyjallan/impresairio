import {
  existsSync,
  lstatSync,
  mkdtempSync,
  realpathSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ArtifactService } from '../src/documentation/artifact.service';
import {
  FilesystemDocumentationTarget,
  FilesystemDocumentationTargetError,
} from '../src/documentation/filesystem-documentation.target';
import { PathRendererService } from '../src/documentation/path-renderer.service';

const directories: string[] = [];

function temporaryDirectory(): string {
  const directory = realpathSync(
    mkdtempSync(join(tmpdir(), 'impresairio-artifact-')),
  );
  directories.push(directory);
  return directory;
}

const bindings = {
  project: { name: 'Example Project', slug: 'example-project' },
  feature: { id: 'IMP-42', slug: 'safe-output' },
  run: { id: 'run-42' },
};

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('ArtifactService', () => {
  it('creates a deterministic Markdown template only when the output does not already exist', () => {
    const root = temporaryDirectory();
    const artifactService = new ArtifactService(
      new PathRendererService(),
      new FilesystemDocumentationTarget(),
    );

    const output = artifactService.prepareOutput({
      target: { kind: 'filesystem', root, defaultFormat: 'markdown' },
      featurePath: 'Features/{{ feature.id }} - {{ feature.slug }}',
      bindings,
      output: {
        id: 'design',
        filename: '01 - Feature Design.md',
        template: 'feature-design',
      },
    });

    expect(output.path).toBe(
      join(root, 'Features', 'IMP-42 - safe-output', '01 - Feature Design.md'),
    );
    expect(readFileSync(output.path, 'utf8')).toContain('# Feature Design');

    writeFileSync(output.path, '# Kept\n', 'utf8');
    artifactService.prepareOutput({
      target: { kind: 'filesystem', root, defaultFormat: 'markdown' },
      featurePath: 'Features/{{ feature.id }} - {{ feature.slug }}',
      bindings,
      output: {
        id: 'design',
        filename: '01 - Feature Design.md',
        template: 'feature-design',
      },
    });
    expect(readFileSync(output.path, 'utf8')).toBe('# Kept\n');
  });

  it('creates the output directory but leaves a no-template Markdown output for the agent', () => {
    const root = temporaryDirectory();
    const artifactService = new ArtifactService(
      new PathRendererService(),
      new FilesystemDocumentationTarget(),
    );

    const output = artifactService.prepareOutput({
      target: { kind: 'filesystem', root, defaultFormat: 'markdown' },
      featurePath: 'Features/{{ feature.id }}',
      bindings,
      output: { id: 'challenge', filename: '02 - Challenge.md' },
    });

    expect(existsSync(output.directory)).toBe(true);
    expect(existsSync(output.path)).toBe(false);
  });

  it('detects a controlled symlink replacement immediately before writing', () => {
    const root = temporaryDirectory();
    const outside = temporaryDirectory();
    const target = new FilesystemDocumentationTarget({
      beforeFileWrite: (outputPath) => {
        const outputDirectory = dirname(outputPath);
        rmSync(outputDirectory, { recursive: true, force: true });
        symlinkSync(outside, outputDirectory, 'dir');
      },
    });
    const artifactService = new ArtifactService(
      new PathRendererService(),
      target,
    );

    expect(() =>
      artifactService.prepareOutput({
        target: { kind: 'filesystem', root, defaultFormat: 'markdown' },
        featurePath: 'Features/{{ feature.id }}',
        bindings,
        output: {
          id: 'design',
          filename: '01 - Feature Design.md',
          template: 'feature-design',
        },
      }),
    ).toThrow(FilesystemDocumentationTargetError);

    const substitutedDirectory = join(root, 'Features', 'IMP-42');
    expect(lstatSync(substitutedDirectory).isSymbolicLink()).toBe(true);
    expect(existsSync(join(outside, '01 - Feature Design.md'))).toBe(false);
  });

  it('revalidates containment when advance publishes returned Markdown', () => {
    const root = temporaryDirectory();
    const outside = temporaryDirectory();
    let replaceOnWrite = false;
    const artifactService = new ArtifactService(
      new PathRendererService(),
      new FilesystemDocumentationTarget({
        beforeFileWrite: (outputPath) => {
          if (!replaceOnWrite) return;
          const outputDirectory = dirname(outputPath);
          rmSync(outputDirectory, { recursive: true, force: true });
          symlinkSync(outside, outputDirectory, 'dir');
        },
      }),
    );
    const prepared = artifactService.prepareOutput({
      target: { kind: 'filesystem', root, defaultFormat: 'markdown' },
      featurePath: 'Features/{{ feature.id }}', bindings,
      output: { id: 'report', filename: 'Report.md' },
    });
    replaceOnWrite = true;

    expect(() => artifactService.publishMarkdown(prepared, '# Report\n')).toThrow(FilesystemDocumentationTargetError);
    expect(existsSync(join(outside, 'Report.md'))).toBe(false);
  });

  it('detects a controlled symlink replacement immediately before directory creation', () => {
    const root = temporaryDirectory();
    const outside = temporaryDirectory();
    const target = new FilesystemDocumentationTarget({
      beforeDirectoryCreate: (directory) => {
        if (directory === join(root, 'Features')) {
          symlinkSync(outside, directory, 'dir');
        }
      },
    });
    const artifactService = new ArtifactService(
      new PathRendererService(),
      target,
    );

    expect(() =>
      artifactService.prepareOutput({
        target: { kind: 'filesystem', root, defaultFormat: 'markdown' },
        featurePath: 'Features/{{ feature.id }}',
        bindings,
        output: { id: 'challenge', filename: '02 - Challenge.md' },
      }),
    ).toThrow(FilesystemDocumentationTargetError);

    expect(lstatSync(join(root, 'Features')).isSymbolicLink()).toBe(true);
    expect(existsSync(join(outside, 'IMP-42', '02 - Challenge.md'))).toBe(false);
  });

  it('verifies a completed Markdown output and records its SHA-256 metadata', () => {
    const root = temporaryDirectory();
    const artifactService = new ArtifactService(
      new PathRendererService(),
      new FilesystemDocumentationTarget(),
    );
    const prepared = artifactService.prepareOutput({
      target: { kind: 'filesystem', root, defaultFormat: 'markdown' },
      featurePath: 'Features/{{ feature.id }}',
      bindings,
      output: { id: 'challenge', filename: '02 - Challenge.md' },
    });
    writeFileSync(prepared.path, '# Challenge\n\nA useful review.\n', 'utf8');

    const completed = artifactService.completeOutput(prepared);

    expect(completed.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(completed.path).toBe(prepared.path);
    expect(completed.format).toBe('markdown');
  });

  it('rejects a missing or empty output during completion', () => {
    const root = temporaryDirectory();
    const artifactService = new ArtifactService(
      new PathRendererService(),
      new FilesystemDocumentationTarget(),
    );
    const prepared = artifactService.prepareOutput({
      target: { kind: 'filesystem', root, defaultFormat: 'markdown' },
      featurePath: 'Features',
      bindings,
      output: { id: 'challenge', filename: '02 - Challenge.md' },
    });

    expect(() => artifactService.completeOutput(prepared)).toThrow('does not exist');
    writeFileSync(prepared.path, '   \n', 'utf8');
    expect(() => artifactService.completeOutput(prepared)).toThrow('must not be empty');
  });

  it('reads and discards a resolved expected output', () => {
    const root = temporaryDirectory();
    const artifactService = new ArtifactService(
      new PathRendererService(),
      new FilesystemDocumentationTarget(),
    );
    const prepared = artifactService.prepareOutput({
      target: { kind: 'filesystem', root, defaultFormat: 'markdown' },
      featurePath: 'Features',
      bindings,
      output: { id: 'challenge', filename: '02 - Challenge.md' },
    });
    writeFileSync(prepared.path, '# Challenge\n', 'utf8');

    expect(artifactService.readExpectedOutput({} as never, {
      id: 'challenge', kind: 'agent', status: 'complete', output: prepared,
    })).toBe('# Challenge\n');
    artifactService.discardExpectedOutput({
      id: 'challenge', kind: 'agent', status: 'complete', output: prepared,
    });
    expect(existsSync(prepared.path)).toBe(false);
    expect(() => artifactService.discardExpectedOutput({
      id: 'missing', kind: 'agent', status: 'complete',
    })).toThrow('does not declare a resolved documentation output');
  });
});
