import { cpSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HomeDirectoryResolver } from '../src/config/home-directory.resolver';
import {
  WorkflowError,
  WorkflowRegistryService,
} from '../src/workflows/workflow-registry.service';

const fixtureDirectory = join(__dirname, 'fixtures', 'workflows');
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

describe('WorkflowRegistryService', () => {
  it('uses repository, then global, then package workflow precedence', () => {
    const home = temporaryDirectory('impresairio-workflow-home-');
    const repository = temporaryDirectory('impresairio-workflow-repo-');
    const packageDirectory = temporaryDirectory('impresairio-workflow-package-');
    cpSync(join(fixtureDirectory, 'repository'), repository, { recursive: true });
    mkdirSync(join(home, 'workflows'), { recursive: true });
    cpSync(join(fixtureDirectory, 'global', 'custom.yaml'), join(home, 'workflows', 'custom.yaml'));
    cpSync(join(fixtureDirectory, 'package', 'custom.yaml'), join(packageDirectory, 'custom.yaml'));
    const registry = createRegistry(home, packageDirectory);

    expect(registry.resolve('custom', repository)).toMatchObject({
      source: 'repository',
      workflow: { name: 'Repository custom' },
    });

    rmSync(join(repository, '.impresairio'), { recursive: true });
    expect(registry.resolve('custom', repository)).toMatchObject({
      source: 'global',
      workflow: { name: 'Global custom' },
    });

    rmSync(join(home, 'workflows'), { recursive: true });
    expect(registry.resolve('custom', repository)).toMatchObject({
      source: 'package',
      workflow: { name: 'Package custom' },
    });
  });

  it('locks the exact resolved YAML content through its SHA-256', () => {
    const home = temporaryDirectory('impresairio-workflow-home-');
    const packageDirectory = temporaryDirectory('impresairio-workflow-package-');
    writeFileSync(join(packageDirectory, 'custom.yaml'), [
      'id: custom', 'name: Custom', 'steps:', '  - id: write', '    type: agent',
      '    actor: launcher', '    action: final-report', '    output:',
      '      id: report', '      filename: "01 - Report.md"', '',
    ].join('\n'));
    const registry = createRegistry(home, packageDirectory);
    const first = registry.resolve('custom', temporaryDirectory('impresairio-workflow-repo-'));
    writeFileSync(join(packageDirectory, 'custom.yaml'), 'id: custom\nname: Changed\nsteps:\n  - id: write\n    type: agent\n    actor: launcher\n    action: final-report\n    output:\n      id: report\n      filename: "01 - Report.md"\n');
    const second = registry.resolve('custom', temporaryDirectory('impresairio-workflow-repo-'));

    expect(first.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(second.sha256).not.toBe(first.sha256);
  });

  it.each([
    ['both action and promptFile', '    action: final-report\n    promptFile: prompts/report.md\n'],
    ['missing agent output', '    action: final-report\n'],
    ['an unsupported field', '    action: final-report\n    shell: npm test\n    output:\n      id: report\n      filename: "01 - Report.md"\n'],
    ['an unsafe prompt reference', '    promptFile: ../outside.md\n    output:\n      id: report\n      filename: "01 - Report.md"\n'],
    ['a dynamic expression', '    action: final-report\n    output:\n      id: report\n      filename: "{{ env.HOME }}.md"\n'],
    ['an unknown documentation template', '    action: final-report\n    output:\n      id: report\n      filename: "01 - Report.md"\n      template: unknown-template\n'],
  ])('rejects %s', (_label, body) => {
    const home = temporaryDirectory('impresairio-workflow-home-');
    const packageDirectory = temporaryDirectory('impresairio-workflow-package-');
    writeFileSync(join(packageDirectory, 'custom.yaml'), [
      'id: custom', 'name: Custom', 'steps:', '  - id: write', '    type: agent',
      '    actor: launcher', body,
    ].join('\n'));

    expect(() => createRegistry(home, packageDirectory).resolve('custom', home)).toThrow(WorkflowError);
  });

  it('rejects duplicate step IDs, unsafe gate references and unknown roles', () => {
    const home = temporaryDirectory('impresairio-workflow-home-');
    const packageDirectory = temporaryDirectory('impresairio-workflow-package-');
    writeFileSync(join(packageDirectory, 'custom.yaml'), `id: custom
name: Custom
steps:
  - id: write
    type: agent
    actor: reviewer
    action: final-report
    output:
      id: report
      filename: "01 - Report.md"
  - id: write
    type: gate
    artifact: missing
`);

    expect(() => createRegistry(home, packageDirectory).resolve('custom', home)).toThrow(WorkflowError);
  });
});
