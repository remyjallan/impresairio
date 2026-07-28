import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WorkflowsCommand } from '../src/commands/workflows.command';
import { HomeDirectoryResolver } from '../src/config/home-directory.resolver';
import { WorkflowRegistryService } from '../src/workflows/workflow-registry.service';

const temporaryDirectories: string[] = [];

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function workflow(name: string): string {
  return `id: sample\nname: ${name}\nsteps:\n  - id: report\n    type: agent\n    actor: launcher\n    capability: final-report\n    output:\n      id: report\n      filename: report.md\n`;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('workflows command', () => {
  it('lists effective definitions after repository/global/package precedence', async () => {
    const home = temporaryDirectory('impresairio-workflow-command-home-');
    const repository = temporaryDirectory('impresairio-workflow-command-repo-');
    const packageDirectory = temporaryDirectory('impresairio-workflow-command-package-');
    mkdirSync(join(home, 'workflows'), { recursive: true });
    mkdirSync(join(repository, '.impresairio', 'workflows'), { recursive: true });
    writeFileSync(join(home, 'workflows', 'sample.yaml'), workflow('Global sample'));
    writeFileSync(join(repository, '.impresairio', 'workflows', 'sample.yaml'), workflow('Repository sample'));
    writeFileSync(join(packageDirectory, 'package-only.yaml'), workflow('Package only').replace('id: sample', 'id: package-only'));
    const registry = new WorkflowRegistryService(
      new HomeDirectoryResolver({ IMPRESAIRIO_HOME: home }),
      { packageWorkflowsDirectory: packageDirectory, currentDirectory: () => repository },
    );
    const output: string[] = [];

    await new WorkflowsCommand(registry, (line) => output.push(line)).run();

    expect(output.join('')).toContain('ID\tNAME\tSOURCE');
    expect(output.join('')).toContain('sample\tRepository sample\trepository');
    expect(output.join('')).toContain('package-only\tPackage only\tpackage');
    expect(output.join('')).not.toContain('Global sample');
  });

  it('reports an empty registry clearly', async () => {
    const home = temporaryDirectory('impresairio-workflow-empty-home-');
    const repository = temporaryDirectory('impresairio-workflow-empty-repo-');
    const packageDirectory = temporaryDirectory('impresairio-workflow-empty-package-');
    const output: string[] = [];
    const registry = new WorkflowRegistryService(
      new HomeDirectoryResolver({ IMPRESAIRIO_HOME: home }),
      { packageWorkflowsDirectory: packageDirectory, currentDirectory: () => repository },
    );

    await new WorkflowsCommand(registry, (line) => output.push(line)).run();

    expect(output).toEqual(['No workflow definitions found.\n']);
  });

  it('rejects a definition whose file name and workflow ID disagree', () => {
    const home = temporaryDirectory('impresairio-workflow-invalid-home-');
    const repository = temporaryDirectory('impresairio-workflow-invalid-repo-');
    const packageDirectory = temporaryDirectory('impresairio-workflow-invalid-package-');
    writeFileSync(join(packageDirectory, 'wrong.yaml'), workflow('Wrong ID'));
    const registry = new WorkflowRegistryService(
      new HomeDirectoryResolver({ IMPRESAIRIO_HOME: home }),
      { packageWorkflowsDirectory: packageDirectory, currentDirectory: () => repository },
    );
    expect(() => registry.list()).toThrow('does not match filename "wrong.yaml"');
  });
});
