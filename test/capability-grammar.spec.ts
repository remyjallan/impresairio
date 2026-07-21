import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HomeDirectoryResolver } from '../src/config/home-directory.resolver';
import { workflowSchema } from '../src/workflows/workflow.schema';
import { WorkflowError, WorkflowRegistryService } from '../src/workflows/workflow-registry.service';

function workflowWith(steps: Record<string, unknown>[]): unknown {
  return { id: 'sample', name: 'Sample', steps };
}

const temporaryDirectories: string[] = [];

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function createRegistry(home: string, packageDirectory: string): WorkflowRegistryService {
  return new WorkflowRegistryService(
    new HomeDirectoryResolver({ IMPRESAIRIO_HOME: home }),
    { packageWorkflowsDirectory: packageDirectory },
  );
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('workflow grammar: free capabilities and actors', () => {
  it('accepts a free capability identifier on an agent step', () => {
    const result = workflowSchema.safeParse(workflowWith([{
      id: 'model', type: 'agent', actor: 'product-author', capability: 'threat-model',
      output: { id: 'threat-model', filename: '01 - Threat Model.md' },
    }]));

    expect(result.success).toBe(true);
  });

  it('accepts a free actor identifier', () => {
    const result = workflowSchema.safeParse(workflowWith([{
      id: 'model', type: 'agent', actor: 'product-author', capability: 'threat-model',
      output: { id: 'threat-model', filename: '01 - Threat Model.md' },
    }]));

    expect(result.success).toBe(true);
  });

  it('accepts the explicit controlled patch contract on an agent step', () => {
    const result = workflowSchema.safeParse(workflowWith([{
      id: 'implement', type: 'agent', actor: 'implementer', capability: 'implement',
      output: { id: 'implementation', filename: '01 - Implementation.md' },
      patch: 'apply-unified-diff',
    }]));

    expect(result.success).toBe(true);
  });

  it('rejects an unknown patch contract', () => {
    const result = workflowSchema.safeParse(workflowWith([{
      id: 'implement', type: 'agent', actor: 'implementer', capability: 'implement',
      output: { id: 'implementation', filename: '01 - Implementation.md' },
      patch: 'write-anything',
    }]));

    expect(result.success).toBe(false);
  });

  it('rejects an invalid capability identifier', () => {
    const result = workflowSchema.safeParse(workflowWith([{
      id: 'model', type: 'agent', actor: 'product-author', capability: 'Threat Model',
      output: { id: 'threat-model', filename: '01 - Threat Model.md' },
    }]));

    expect(result.success).toBe(false);
  });

  it('rejects an invalid actor identifier', () => {
    const result = workflowSchema.safeParse(workflowWith([{
      id: 'model', type: 'agent', actor: 'Product Author', capability: 'threat-model',
      output: { id: 'threat-model', filename: '01 - Threat Model.md' },
    }]));

    expect(result.success).toBe(false);
  });

  it('requires reviewCapability on a review-cycle step', () => {
    const result = workflowSchema.safeParse(workflowWith([{
      id: 'design', type: 'review-cycle', actor: 'product-author', reviewer: 'skeptic',
      capability: 'feature-design', maxIterations: 2,
      output: { id: 'design', filename: '01 - Design.md' }, gateId: 'approve-design',
    }]));

    expect(result.success).toBe(false);
  });

  it('accepts a review-cycle step with free capability and reviewCapability identifiers', () => {
    const result = workflowSchema.safeParse(workflowWith([{
      id: 'design', type: 'review-cycle', actor: 'product-author', reviewer: 'skeptic',
      capability: 'feature-design', reviewCapability: 'adversarial-review', maxIterations: 2,
      output: { id: 'design', filename: '01 - Design.md' }, gateId: 'approve-design',
    }]));

    expect(result.success).toBe(true);
  });

  it('produces a dedicated rename error for legacy "action" workflow steps', () => {
    const home = temporaryDirectory('impresairio-grammar-home-');
    const packageDirectory = temporaryDirectory('impresairio-grammar-package-');
    writeFileSync(join(packageDirectory, 'legacy.yaml'), [
      'id: legacy', 'name: Legacy', 'steps:', '  - id: write', '    type: agent',
      '    actor: launcher', '    action: final-report', '    output:',
      '      id: report', '      filename: "01 - Report.md"', '',
    ].join('\n'));

    expect(() => createRegistry(home, packageDirectory).resolve('legacy', home))
      .toThrow(WorkflowError);
    expect(() => createRegistry(home, packageDirectory).resolve('legacy', home))
      .toThrow('"action" was renamed to "capability"; update the workflow step');
  });

  it('produces a dedicated rename error for legacy "reviewAction" workflow steps', () => {
    const home = temporaryDirectory('impresairio-grammar-home-');
    const packageDirectory = temporaryDirectory('impresairio-grammar-package-');
    writeFileSync(join(packageDirectory, 'legacy-review.yaml'), `id: legacy-review
name: Legacy Review
steps:
  - id: design
    type: review-cycle
    actor: launcher
    reviewer: adversary
    capability: feature-design
    reviewAction: adversarial-review
    maxIterations: 2
    output:
      id: design
      filename: "01 - Design.md"
    gateId: approve-design
`);

    expect(() => createRegistry(home, packageDirectory).resolve('legacy-review', home))
      .toThrow('"reviewAction" was renamed to "reviewCapability"; update the workflow step');
  });
});
