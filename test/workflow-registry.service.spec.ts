import { cpSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
      '    actor: launcher', '    capability: final-report', '    output:',
      '      id: report', '      filename: "01 - Report.md"', '',
    ].join('\n'));
    const registry = createRegistry(home, packageDirectory);
    const first = registry.resolve('custom', temporaryDirectory('impresairio-workflow-repo-'));
    writeFileSync(join(packageDirectory, 'custom.yaml'), 'id: custom\nname: Changed\nsteps:\n  - id: write\n    type: agent\n    actor: launcher\n    capability: final-report\n    output:\n      id: report\n      filename: "01 - Report.md"\n');
    const second = registry.resolve('custom', temporaryDirectory('impresairio-workflow-repo-'));

    expect(first.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(second.sha256).not.toBe(first.sha256);
  });

  it('rejects prompt files whose symlink target escapes the workflow directory', () => {
    const home = temporaryDirectory('impresairio-workflow-home-');
    const packageDirectory = temporaryDirectory('impresairio-workflow-package-');
    const prompts = join(packageDirectory, 'prompts');
    mkdirSync(prompts);
    writeFileSync(join(packageDirectory, 'custom.yaml'), `id: custom
name: Custom
steps:
  - id: write
    type: agent
    actor: launcher
    promptFile: prompts/leak.md
    output:
      id: report
      filename: "01 - Report.md"
`);
    const secret = join(temporaryDirectory('impresairio-workflow-secret-'), 'secret.txt');
    writeFileSync(secret, 'must not enter the prompt');
    symlinkSync(secret, join(prompts, 'leak.md'));
    const registry = createRegistry(home, packageDirectory);
    const resolved = registry.resolve('custom', home);

    expect(() => registry.readPromptFile(resolved, 'prompts/leak.md'))
      .toThrow('Prompt file escapes workflow directory');
  });

  it('loads a prompt whose real path remains inside the workflow directory', () => {
    const home = temporaryDirectory('impresairio-workflow-home-');
    const packageDirectory = temporaryDirectory('impresairio-workflow-package-');
    const prompts = join(packageDirectory, 'prompts');
    mkdirSync(prompts);
    writeFileSync(join(packageDirectory, 'custom.yaml'), `id: custom
name: Custom
steps:
  - id: write
    type: agent
    actor: launcher
    promptFile: prompts/report.md
    output:
      id: report
      filename: "01 - Report.md"
`);
    writeFileSync(join(prompts, 'report.md'), '# Report\n', 'utf8');
    const registry = createRegistry(home, packageDirectory);
    const resolved = registry.resolve('custom', home);

    expect(registry.readPromptFile(resolved, 'prompts/report.md')).toBe('# Report\n');
  });

  it.each([
    ['both action and promptFile', '    capability: final-report\n    promptFile: prompts/report.md\n'],
    ['missing agent output', '    capability: final-report\n'],
    ['an unsupported field', '    capability: final-report\n    shell: npm test\n    output:\n      id: report\n      filename: "01 - Report.md"\n'],
    ['an unsafe prompt reference', '    promptFile: ../outside.md\n    output:\n      id: report\n      filename: "01 - Report.md"\n'],
    ['a dynamic expression', '    capability: final-report\n    output:\n      id: report\n      filename: "{{ env.HOME }}.md"\n'],
    ['an unknown documentation template', '    capability: final-report\n    output:\n      id: report\n      filename: "01 - Report.md"\n      template: unknown-template\n'],
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
    capability: final-report
    output:
      id: report
      filename: "01 - Report.md"
  - id: write
    type: gate
    artifact: missing
`);

    expect(() => createRegistry(home, packageDirectory).resolve('custom', home)).toThrow(WorkflowError);
  });

  it('rejects explicit step IDs reserved by review-cycle expansion', () => {
    const home = temporaryDirectory('impresairio-workflow-home-');
    const packageDirectory = temporaryDirectory('impresairio-workflow-package-');
    writeFileSync(join(packageDirectory, 'custom.yaml'), `id: custom
name: Custom
steps:
  - id: design
    type: review-cycle
    actor: launcher
    reviewer: adversary
    capability: feature-design
    reviewCapability: adversarial-review
    maxIterations: 2
    output:
      id: design
      filename: "01 - Design.md"
    gateId: approve-design
  - id: design-review-1
    type: agent
    actor: launcher
    capability: final-report
    output:
      id: report
      filename: "02 - Report.md"
`);

    expect(() => createRegistry(home, packageDirectory).resolve('custom', home))
      .toThrow('collides with review-cycle generated step ID');
  });

  it('rejects explicit output IDs reserved by review-cycle expansion', () => {
    const home = temporaryDirectory('impresairio-workflow-home-');
    const packageDirectory = temporaryDirectory('impresairio-workflow-package-');
    writeFileSync(join(packageDirectory, 'custom.yaml'), `id: custom
name: Custom
steps:
  - id: report
    type: agent
    actor: launcher
    capability: final-report
    output:
      id: design-review-1
      filename: "01 - Report.md"
  - id: design
    type: review-cycle
    actor: launcher
    reviewer: adversary
    capability: feature-design
    reviewCapability: adversarial-review
    maxIterations: 2
    output:
      id: design
      filename: "02 - Design.md"
    gateId: approve-design
`);

    expect(() => createRegistry(home, packageDirectory).resolve('custom', home))
      .toThrow('generated review output ID "design-review-1" collides with an explicit workflow output ID');
  });

  it('accepts workflow composition with a partial actor mapping', () => {
    const home = temporaryDirectory('impresairio-workflow-home-');
    const packageDirectory = temporaryDirectory('impresairio-workflow-package-');
    writeFileSync(join(packageDirectory, 'custom.yaml'), `id: custom
name: Custom
steps:
  - id: implementation
    uses: workflow:implementation
    actors:
      reviewer: adversary
`);

    expect(createRegistry(home, packageDirectory).resolve('custom', home).workflow.steps[0])
      .toEqual({
        id: 'implementation',
        uses: 'workflow:implementation',
        actors: { reviewer: 'adversary' },
      });
  });

  it.each([
    ['an unsupported workflow provider', 'uses: crew:implementation'],
    ['a malformed workflow reference', 'uses: workflow:Implementation'],
    ['agent fields on a composition step', 'uses: workflow:implementation\n    capability: implementation'],
  ])('rejects composition with %s', (_label, body) => {
    const home = temporaryDirectory('impresairio-workflow-home-');
    const packageDirectory = temporaryDirectory('impresairio-workflow-package-');
    writeFileSync(join(packageDirectory, 'custom.yaml'), `id: custom
name: Custom
steps:
  - id: implementation
    ${body}
`);

    expect(() => createRegistry(home, packageDirectory).resolve('custom', home))
      .toThrow(WorkflowError);
  });

  it('accepts typed literal and parent-parameter composition mappings', () => {
    const home = temporaryDirectory('impresairio-workflow-home-');
    const packageDirectory = temporaryDirectory('impresairio-workflow-package-');
    writeFileSync(join(packageDirectory, 'custom.yaml'), `id: custom
name: Custom
steps:
  - id: implementation
    uses: workflow:implementation
    with:
      quality-mode: strict
      isolate-worktree:
        fromParameter: isolate-worktree
`);

    expect(createRegistry(home, packageDirectory).resolve('custom', home).workflow.steps[0])
      .toMatchObject({
        with: {
          'quality-mode': 'strict',
          'isolate-worktree': { fromParameter: 'isolate-worktree' },
        },
      });
  });
});
