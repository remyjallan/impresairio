import { Inject, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { parseDocument, YAMLParseError } from 'yaml';
import { HomeDirectoryResolver } from '../config/home-directory.resolver';
import { workflowSchema, type Workflow } from './workflow.schema';

const workflowIdPattern = /^[a-z][a-z0-9-]*$/;

export type WorkflowSource = 'repository' | 'global' | 'package';

export interface ResolvedWorkflow {
  readonly workflow: Workflow;
  readonly source: WorkflowSource;
  readonly path: string;
  readonly sha256: string;
}

export class WorkflowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkflowError';
  }
}

export interface WorkflowRegistryRuntime {
  readonly packageWorkflowsDirectory: string;
  readonly currentDirectory: () => string;
}

export const WORKFLOW_REGISTRY_RUNTIME = Symbol('WORKFLOW_REGISTRY_RUNTIME');

const nativeRuntime: WorkflowRegistryRuntime = {
  packageWorkflowsDirectory: join(__dirname, 'builtins'),
  currentDirectory: () => process.cwd(),
};

@Injectable()
export class WorkflowRegistryService {
  private readonly runtime: WorkflowRegistryRuntime;

  constructor(
    private readonly homeDirectoryResolver: HomeDirectoryResolver,
    @Inject(WORKFLOW_REGISTRY_RUNTIME)
    runtime: Partial<WorkflowRegistryRuntime> = {},
  ) {
    this.runtime = { ...nativeRuntime, ...runtime };
  }

  resolve(workflowId: string, repositoryDirectory = this.runtime.currentDirectory()): ResolvedWorkflow {
    if (!workflowIdPattern.test(workflowId)) {
      throw new WorkflowError(`Invalid workflow ID: ${workflowId}`);
    }

    const sourceCandidates: readonly { readonly source: WorkflowSource; readonly path: string }[] = [
      {
        source: 'repository',
        path: join(resolve(repositoryDirectory), '.impresairio', 'workflows', `${workflowId}.yaml`),
      },
      {
        source: 'global',
        path: join(this.homeDirectoryResolver.resolve(), 'workflows', `${workflowId}.yaml`),
      },
      {
        source: 'package',
        path: join(this.runtime.packageWorkflowsDirectory, `${workflowId}.yaml`),
      },
    ];
    const selected = sourceCandidates.find((candidate) => existsSync(candidate.path));
    if (!selected) {
      throw new WorkflowError(`Workflow not found: ${workflowId}`);
    }

    const source = this.read(selected.path);
    const workflow = this.parse(source, selected.path);
    if (workflow.id !== workflowId) {
      throw new WorkflowError(
        `${selected.path}: workflow id "${workflow.id}" does not match requested ID "${workflowId}"`,
      );
    }
    return {
      workflow,
      source: selected.source,
      path: selected.path,
      sha256: createHash('sha256').update(source).digest('hex'),
    };
  }

  readPromptFile(resolvedWorkflow: ResolvedWorkflow, promptFile: string): string {
    const workflowDirectory = dirname(resolvedWorkflow.path);
    const candidate = resolve(workflowDirectory, promptFile);
    const containment = relative(workflowDirectory, candidate);
    if (containment === '' || containment.startsWith('..') || containment.includes('..\\')) {
      throw new WorkflowError(`Prompt file escapes workflow directory: ${promptFile}`);
    }
    const content = this.read(candidate);
    if (content.trim().length === 0) {
      throw new WorkflowError(`${candidate}: prompt file must not be empty`);
    }
    return content;
  }

  private read(path: string): string {
    try {
      return readFileSync(path, 'utf8');
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'could not read workflow';
      throw new WorkflowError(`${path}: ${detail}`);
    }
  }

  private parse(source: string, path: string): Workflow {
    let document: ReturnType<typeof parseDocument>;
    try {
      document = parseDocument(source, { uniqueKeys: true, merge: false });
    } catch (error) {
      const detail = error instanceof YAMLParseError ? error.message : String(error);
      throw new WorkflowError(`${path}: invalid YAML: ${detail}`);
    }
    if (document.errors.length > 0) {
      throw new WorkflowError(`${path}: invalid YAML: ${document.errors[0].message}`);
    }
    if (document.warnings.length > 0) {
      throw new WorkflowError(`${path}: unsupported YAML: ${document.warnings[0].message}`);
    }

    const raw = document.toJS({ maxAliasCount: 0 }) as { steps?: unknown };
    const result = workflowSchema.safeParse(raw);
    if (!result.success) {
      if (Array.isArray((raw as { steps?: unknown[] }).steps)) {
        for (const candidate of (raw as { steps: unknown[] }).steps) {
          if (candidate && typeof candidate === 'object' && 'action' in candidate) {
            throw new WorkflowError(`${path}: "action" was renamed to "capability"; update the workflow step`);
          }
          if (candidate && typeof candidate === 'object' && 'reviewAction' in candidate) {
            throw new WorkflowError(`${path}: "reviewAction" was renamed to "reviewCapability"; update the workflow step`);
          }
        }
      }
      const issue = result.error.issues[0];
      const field = issue.path.length > 0 ? issue.path.join('.') : '(root)';
      throw new WorkflowError(`${path}: ${field}: ${issue.message}`);
    }

    return result.data;
  }
}

export function workflowPromptDirectory(resolved: ResolvedWorkflow): string {
  return dirname(resolved.path);
}
