import { createHash } from 'node:crypto';
import { dirname, extname, join } from 'node:path';
import { Injectable } from '@nestjs/common';
import type { ResolvedDocumentationTarget } from '../config/config.service';
import type {
  CompletionRun,
  CompletionStep,
  OutputVerifier,
} from '../runs/completion.service';
import {
  type CompletedDocumentationOutput,
  type PreparedDocumentationOutput,
} from './documentation-target';
import { FilesystemDocumentationTarget } from './filesystem-documentation.target';
import {
  type FixedBindings,
  PathRendererService,
} from './path-renderer.service';
import { resolveDocumentationTemplate } from './templates';

export class ArtifactError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArtifactError';
  }
}

export interface DeclaredOutput {
  readonly id: string;
  readonly filename: string;
  readonly template?: string;
}

export interface PrepareOutputInput {
  readonly target: Pick<
    ResolvedDocumentationTarget,
    'kind' | 'root' | 'defaultFormat'
  >;
  readonly featurePath: string;
  readonly bindings: FixedBindings;
  readonly output: DeclaredOutput;
}

export interface CompletionOutputStep extends CompletionStep {
  readonly output?: PreparedDocumentationOutput;
}

@Injectable()
export class ArtifactService implements OutputVerifier {
  constructor(
    private readonly pathRenderer: PathRendererService,
    private readonly filesystemTarget: FilesystemDocumentationTarget,
  ) {}

  prepareOutput(input: PrepareOutputInput): PreparedDocumentationOutput {
    const path = this.resolveOutputPath(input);
    const prepared: PreparedDocumentationOutput = {
      id: input.output.id,
      targetRoot: input.target.root,
      directory: dirname(path),
      path,
      format: 'markdown',
    };

    if (input.output.template) {
      this.filesystemTarget.initializeIfAbsent(
        prepared,
        resolveDocumentationTemplate(input.output.template),
      );
    } else {
      this.filesystemTarget.ensureDirectory(prepared);
    }
    return prepared;
  }

  resolveOutputPath(input: PrepareOutputInput): string {
    if (input.target.kind !== 'filesystem' || input.target.defaultFormat !== 'markdown') {
      throw new ArtifactError('Only filesystem Markdown documentation targets are supported');
    }
    if (extname(input.output.filename).toLowerCase() !== '.md') {
      throw new ArtifactError('Documentation output filename must end in .md');
    }

    return this.pathRenderer.renderOutputPath({
      targetRoot: input.target.root,
      featurePath: input.featurePath,
      filename: input.output.filename,
      bindings: input.bindings,
    });
  }

  prepareInternalOutput(runDirectory: string, output: DeclaredOutput): PreparedDocumentationOutput {
    const path = this.resolveInternalOutputPath(runDirectory, output);
    const prepared: PreparedDocumentationOutput = {
      id: output.id, targetRoot: runDirectory, directory: dirname(path),
      path, format: 'markdown',
    };
    this.filesystemTarget.ensureDirectory(prepared);
    return prepared;
  }

  resolveInternalOutputPath(runDirectory: string, output: DeclaredOutput): string {
    if (extname(output.filename).toLowerCase() !== '.md') {
      throw new ArtifactError('Internal output filename must end in .md');
    }
    return join(runDirectory, 'artifacts', output.filename);
  }

  completeOutput(
    output: PreparedDocumentationOutput,
  ): CompletedDocumentationOutput {
    const content = this.filesystemTarget.readVerifiedMarkdown(output);
    return {
      id: output.id,
      path: output.path,
      format: output.format,
      sha256: createHash('sha256').update(content, 'utf8').digest('hex'),
    };
  }

  publishMarkdown(output: PreparedDocumentationOutput, content: string): void {
    this.filesystemTarget.writeVerifiedMarkdown(output, content);
  }

  discardOutput(output: PreparedDocumentationOutput): void {
    this.filesystemTarget.removeVerifiedMarkdown(output);
  }

  currentHash(
    output: Pick<CompletedDocumentationOutput, 'id' | 'path' | 'format'>,
    targetRoot: string,
  ): string {
    return this.completeOutput({
      ...output,
      targetRoot,
      directory: dirname(output.path),
    }).sha256;
  }

  completeExpectedOutput(
    _run: CompletionRun,
    step: CompletionOutputStep,
  ): CompletedDocumentationOutput {
    if (!step.output) {
      throw new ArtifactError(
        `Step ${step.id} does not declare a resolved documentation output`,
      );
    }
    return this.completeOutput(step.output);
  }

  readExpectedOutput(
    _run: CompletionRun,
    step: CompletionOutputStep,
  ): string {
    if (!step.output) {
      throw new ArtifactError(`Step ${step.id} does not declare a resolved documentation output`);
    }
    return this.filesystemTarget.readVerifiedMarkdown(step.output);
  }

  discardExpectedOutput(step: CompletionOutputStep): void {
    if (!step.output) {
      throw new ArtifactError(`Step ${step.id} does not declare a resolved documentation output`);
    }
    this.discardOutput(step.output);
  }
}
