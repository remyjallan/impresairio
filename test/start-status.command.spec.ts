import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { StartCommand } from '../src/commands/start.command';
import { StatusCommand } from '../src/commands/status.command';
import { HomeDirectoryResolver } from '../src/config/home-directory.resolver';
import { ConfigService } from '../src/config/config.service';
import { EventLogService } from '../src/runs/event-log.service';
import { FileStateStore } from '../src/runs/file-state.store';
import { RunLockService } from '../src/runs/run-lock.service';
import { RunService } from '../src/runs/run.service';
import { WorkflowRegistryService } from '../src/workflows/workflow-registry.service';
import { WorkflowRunnerService } from '../src/workflows/workflow-runner.service';
import { ArtifactService } from '../src/documentation/artifact.service';
import { FilesystemDocumentationTarget } from '../src/documentation/filesystem-documentation.target';
import { PathRendererService } from '../src/documentation/path-renderer.service';
import { CompletionService } from '../src/runs/completion.service';

const temporaryDirectories: string[] = [];

function configureRepository(home: string, documentationRoot: string): string {
  const repository = realpathSync(mkdtempSync(join(tmpdir(), 'impresairio-repository-')));
  temporaryDirectories.push(repository);
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, 'config.yaml'), `documentationTargets:
  personal-vault:
    kind: filesystem
    root: ${documentationRoot}
    defaultFormat: markdown
agentProfiles: {}
models: {}
`);
  writeFileSync(join(repository, '.impresairio.yaml'), `project:
  name: Example Project
  slug: example-project
documentation:
  target: personal-vault
  featurePath: "Specs/{{ feature.id }} - {{ feature.slug }}"
  format: markdown
`);
  return repository;
}

function createRunService() {
  const home = mkdtempSync(join(tmpdir(), 'impresairio-run-'));
  temporaryDirectories.push(home);
  const resolver = new HomeDirectoryResolver({ IMPRESAIRIO_HOME: home });
  const store = new FileStateStore(resolver);
  const events = new EventLogService(resolver);
  const locks = new RunLockService(store, events, {
    hostname: 'local-machine', pid: 4242, isPidActive: () => false,
    now: () => new Date('2026-07-20T10:00:00.000Z'),
  });
  const workflows = new WorkflowRegistryService(resolver, {
    packageWorkflowsDirectory: join(__dirname, '..', 'src', 'workflows', 'builtins'),
    currentDirectory: () => home,
  });
  const artifactService = new ArtifactService(
    new PathRendererService(),
    new FilesystemDocumentationTarget(),
  );
  return {
    home,
    store,
    events,
    locks,
    artifactService,
    service: new RunService(
      store,
      events,
      locks,
      workflows,
      new ConfigService(resolver),
      () => new Date('2026-07-20T10:00:00.000Z'),
    ),
    runner: new WorkflowRunnerService(
      store,
      events,
      locks,
      artifactService,
      () => new Date('2026-07-20T10:01:00.000Z'),
    ),
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('start and status commands', () => {
  it('creates a run state and renders its workflow and step status', async () => {
    const { home, store, service } = createRunService();
    const documentationRoot = realpathSync(mkdtempSync(join(tmpdir(), 'impresairio-output-')));
    temporaryDirectories.push(documentationRoot);
    const repository = configureRepository(home, documentationRoot);
    const start = new StartCommand(service, () => undefined);
    const output: string[] = [];
    const status = new StatusCommand(store, (line) => output.push(line));

    await start.run(['quick-fix'], {
      launcher: 'claude', adversary: 'codex', implementer: 'opencode-glm',
      runId: 'run-quick-fix',
      repository,
      featureId: 'IMP-42',
      featureSlug: 'workflow-test',
    });
    await status.run(['run-quick-fix']);

    expect(store.findState('run-quick-fix')).toEqual(expect.objectContaining({
      workflow: expect.objectContaining({ id: 'quick-fix' }),
      roles: { launcher: 'claude', adversary: 'codex', implementer: 'opencode-glm' },
      documentation: expect.objectContaining({
        target: expect.objectContaining({ root: documentationRoot }),
        featurePath: 'Specs/{{ feature.id }} - {{ feature.slug }}',
        bindings: expect.objectContaining({
          feature: { id: 'IMP-42', slug: 'workflow-test' },
        }),
      }),
      steps: expect.arrayContaining([
        expect.objectContaining({ id: 'investigate', status: 'pending' }),
      ]),
    }));
    expect(output.join('')).toContain('run-quick-fix');
    expect(output.join('')).toContain('workflow: quick-fix');
    expect(output.join('')).toContain('steps: 3');
  });

  it('keeps the resolved step contract through start, next and completion', () => {
    const { home, store, locks, artifactService, service, runner } = createRunService();
    const documentationRoot = realpathSync(mkdtempSync(join(tmpdir(), 'impresairio-output-')));
    temporaryDirectories.push(documentationRoot);
    const repository = configureRepository(home, documentationRoot);
    service.start({
      id: 'run-completion',
      workflowId: 'quick-fix',
      roles: { launcher: 'claude' },
      feature: { id: 'IMP-43', slug: 'completion-test' },
      repositoryDirectory: repository,
    });

    expect(runner.next('run-completion')).toEqual({ kind: 'agent', stepId: 'investigate' });
    const started = store.findState('run-completion');
    const step = started?.steps[0];
    expect(step).toMatchObject({
      kind: 'agent',
      actor: 'launcher',
      method: { action: 'investigate' },
      declaredOutput: { id: 'investigation', filename: '01 - Investigation.md' },
      expectedOutput: { format: 'markdown' },
      status: 'in_progress',
    });
    if (!step || step.kind !== 'agent' || !step.expectedOutput) {
      throw new Error('missing prepared output');
    }
    expect(step.expectedOutput.path).toBe(
      join(documentationRoot, 'Specs', 'IMP-43 - completion-test', '01 - Investigation.md'),
    );
    writeFileSync(step.expectedOutput.path, '# Investigation\n', 'utf8');

    new CompletionService(
      store,
      artifactService,
      () => new Date('2026-07-20T10:02:00.000Z'),
      locks,
    ).complete('run-completion', 'investigate');

    expect(store.findState('run-completion')?.steps[0]).toMatchObject({
      status: 'complete',
      output: { id: 'investigation', sha256: expect.stringMatching(/^[a-f0-9]{64}$/) },
    });
  });

  it('does not read mutable workflow YAML after a run starts', () => {
    const { home, store, service, runner } = createRunService();
    const documentationRoot = realpathSync(mkdtempSync(join(tmpdir(), 'impresairio-output-')));
    temporaryDirectories.push(documentationRoot);
    const repository = configureRepository(home, documentationRoot);
    const workflows = join(repository, '.impresairio', 'workflows');
    store.fileOperations.mkdirSync(workflows, { recursive: true });
    const workflowPath = join(workflows, 'custom.yaml');
    writeFileSync(workflowPath, `id: custom
name: Custom
steps:
  - id: draft
    type: agent
    actor: launcher
    action: final-report
    output:
      id: draft
      filename: "01 - Draft.md"
`);
    service.start({
      id: 'run-snapshot', workflowId: 'custom', roles: { launcher: 'claude' },
      feature: { id: 'IMP-44', slug: 'snapshot-test' }, repositoryDirectory: repository,
    });
    writeFileSync(join(repository, '.impresairio.yaml'), `project:
  name: Changed Project
  slug: changed-project
documentation:
  target: personal-vault
  featurePath: "Changed/{{ feature.slug }}"
  format: markdown
`);
    writeFileSync(workflowPath, `id: custom
name: Edited
steps:
  - id: draft
    type: agent
    actor: adversary
    action: investigate
    output:
      id: edited
      filename: "99 - Edited.md"
`);

    runner.next('run-snapshot');

    const snapshot = store.findState('run-snapshot');
    expect(snapshot?.steps[0]).toMatchObject({
      actor: 'launcher',
      method: { action: 'final-report' },
      declaredOutput: { id: 'draft', filename: '01 - Draft.md' },
    });
    expect(snapshot?.documentation).toMatchObject({
      featurePath: 'Specs/{{ feature.id }} - {{ feature.slug }}',
      bindings: {
        project: { name: 'Example Project', slug: 'example-project' },
        feature: { id: 'IMP-44', slug: 'snapshot-test' },
      },
    });
    const step = snapshot?.steps[0];
    expect(step).toMatchObject({
      expectedOutput: {
        path: join(documentationRoot, 'Specs', 'IMP-44 - snapshot-test', '01 - Draft.md'),
      },
    });
  });
});
