import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  PathRendererError,
  PathRendererService,
} from '../src/documentation/path-renderer.service';

const renderer = new PathRendererService();
const bindings = {
  project: { name: 'Example Project', slug: 'example-project' },
  feature: { id: 'IMP-42', slug: 'safe-paths' },
  run: { id: 'run-42' },
};

describe('PathRendererService', () => {
  it('substitutes only the approved fixed bindings into a path below the target root', () => {
    expect(
      renderer.renderOutputPath({
        targetRoot: '/documentation',
        featurePath: 'Projects/{{ project.slug }}/{{ feature.id }} - {{ feature.slug }}',
        filename: '{{ run.id }} - Design.md',
        bindings,
      }),
    ).toBe('/documentation/Projects/example-project/IMP-42 - safe-paths/run-42 - Design.md');
  });

  it('rejects an unknown binding', () => {
    expect(() =>
      renderer.render('{{ environment.home }}/notes', bindings),
    ).toThrow(PathRendererError);
    expect(() =>
      renderer.render('{{ environment.home }}/notes', bindings),
    ).toThrow('Unknown binding: environment.home');
  });

  it('rejects traversal after rendering', () => {
    expect(() =>
      renderer.renderOutputPath({
        targetRoot: '/documentation',
        featurePath: 'Projects/{{ feature.slug }}',
        filename: 'Design.md',
        bindings: {
          ...bindings,
          feature: { ...bindings.feature, slug: '../outside' },
        },
      }),
    ).toThrow('must not contain traversal segments');
  });

  it('rejects an absolute child path and an output outside the target root', () => {
    expect(() =>
      renderer.renderOutputPath({
        targetRoot: '/documentation',
        featurePath: '/tmp/outside',
        filename: 'Design.md',
        bindings,
      }),
    ).toThrow('must be relative');

    expect(() =>
      renderer.renderOutputPath({
        targetRoot: '/documentation',
        featurePath: 'Projects',
        filename: '../../outside.md',
        bindings,
      }),
    ).toThrow('must not contain traversal segments');
  });

  it('rejects a configured target root that traverses an existing symbolic link', () => {
    const temporaryDirectory = mkdtempSync(join(tmpdir(), 'impresairio-path-'));
    const outsideDirectory = join(temporaryDirectory, 'outside');
    const targetRoot = join(temporaryDirectory, 'configured-root');
    mkdirSync(outsideDirectory);
    symlinkSync(outsideDirectory, targetRoot, 'dir');

    try {
      expect(() =>
        renderer.renderOutputPath({
          targetRoot,
          featurePath: 'Features',
          filename: 'Design.md',
          bindings,
        }),
      ).toThrow('must not traverse an existing symbolic link');
    } finally {
      rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  });
});
