import { Injectable } from '@nestjs/common';
import { existsSync, lstatSync } from 'node:fs';
import { isAbsolute, join, parse, relative, resolve, sep, win32 } from 'node:path';

export class PathRendererError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PathRendererError';
  }
}

export interface FixedBindings {
  readonly project: {
    readonly name: string;
    readonly slug: string;
  };
  readonly feature: {
    readonly id: string;
    readonly slug: string;
  };
  readonly run: {
    readonly id: string;
  };
}

export interface RenderOutputPathInput {
  readonly targetRoot: string;
  readonly featurePath: string;
  readonly filename: string;
  readonly bindings: FixedBindings;
}

const bindingPattern = /{{\s*([^{}]+?)\s*}}/g;
const approvedBindings = new Set([
  'project.name',
  'project.slug',
  'feature.id',
  'feature.slug',
  'run.id',
]);

@Injectable()
export class PathRendererService {
  render(template: string, bindings: FixedBindings): string {
    return template.replace(bindingPattern, (_match, binding: string) => {
      const key = binding.trim();
      if (!approvedBindings.has(key)) {
        throw new PathRendererError(`Unknown binding: ${key}`);
      }

      return this.resolveBinding(key, bindings);
    });
  }

  renderOutputPath(input: RenderOutputPathInput): string {
    const featurePath = this.render(input.featurePath, input.bindings);
    const filename = this.render(input.filename, input.bindings);
    this.assertSafeRelativePath(featurePath, 'featurePath');
    this.assertSafeRelativePath(filename, 'filename');

    const targetRoot = resolve(input.targetRoot);
    const outputPath = resolve(targetRoot, featurePath, filename);
    const relativeOutputPath = relative(targetRoot, outputPath);

    if (
      relativeOutputPath === '..' ||
      relativeOutputPath.startsWith(`..${sep}`) ||
      isAbsolute(relativeOutputPath)
    ) {
      throw new PathRendererError('Rendered output path must remain inside target root');
    }

    this.assertNoSymbolicLinkInExistingAncestors(targetRoot);
    this.assertNoSymbolicLinkInExistingAncestors(outputPath);

    return outputPath;
  }

  private resolveBinding(key: string, bindings: FixedBindings): string {
    switch (key) {
      case 'project.name':
        return bindings.project.name;
      case 'project.slug':
        return bindings.project.slug;
      case 'feature.id':
        return bindings.feature.id;
      case 'feature.slug':
        return bindings.feature.slug;
      case 'run.id':
        return bindings.run.id;
      default:
        throw new PathRendererError(`Unknown binding: ${key}`);
    }
  }

  private assertSafeRelativePath(value: string, field: string): void {
    if (isAbsolute(value) || win32.isAbsolute(value)) {
      throw new PathRendererError(`${field} must be relative`);
    }

    if (value.split(/[\\/]+/).includes('..')) {
      throw new PathRendererError(
        `${field} must not contain traversal segments`,
      );
    }
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
        throw new PathRendererError(
          'Rendered output path must not traverse an existing symbolic link',
        );
      }
    }
  }
}
