import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { StartCommand } from '../src/commands/start.command';
import { StatusCommand } from '../src/commands/status.command';
import { ListCommand } from '../src/commands/list.command';
import { HomeDirectoryResolver } from '../src/config/home-directory.resolver';
import { ConfigService } from '../src/config/config.service';
import { EventLogService } from '../src/runs/event-log.service';
import { FileStateStore } from '../src/runs/file-state.store';
import { RunLockService } from '../src/runs/run-lock.service';
import { RunService } from '../src/runs/run.service';
import { WorkflowRegistryService } from '../src/workflows/workflow-registry.service';
import { WorkflowExpanderService } from '../src/workflows/workflow-expander.service';
import { WorkflowRunnerService } from '../src/workflows/workflow-runner.service';
import { StaleInvalidationService } from '../src/workflows/stale-invalidation.service';
import { ArtifactService } from '../src/documentation/artifact.service';
import { FilesystemDocumentationTarget } from '../src/documentation/filesystem-documentation.target';
import { PathRendererService } from '../src/documentation/path-renderer.service';
import { CompletionService } from '../src/runs/completion.service';
import { AgentProfileService } from '../src/agents/agent-profile.service';
import { CapabilityResolverService } from '../src/agents/capability-resolver.service';

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
agentProfiles:
  claude:
    provider: claude-code
  codex:
    provider: codex
  opencode-glm:
    provider: opencode
    modelAlias: glm-5.2
models:
  glm-5.2: openrouter/z-ai/glm-5.2
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

function createRunService(agentProfiles: AgentProfileService = new AgentProfileService()) {
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
      new WorkflowExpanderService(workflows),
      new ConfigService(resolver),
      agentProfiles,
      new CapabilityResolverService(resolver),
      artifactService,
      () => new Date('2026-07-20T10:00:00.000Z'),
    ),
    runner: new WorkflowRunnerService(
      store,
      events,
      locks,
      artifactService,
      new StaleInvalidationService(
        store,
        events,
        artifactService,
        () => new Date('2026-07-20T10:01:00.000Z'),
      ),
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
    const { home, store, events, service } = createRunService();
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
      request: '  Investigate and correct the sample workflow behavior.  ',
    });
    await status.run(['run-quick-fix']);

    expect(store.findState('run-quick-fix')).toEqual(expect.objectContaining({
      workflow: expect.objectContaining({ id: 'quick-fix' }),
      request: 'Investigate and correct the sample workflow behavior.',
      repositoryDirectory: repository,
      execution: { agentTimeoutSeconds: 1_800 },
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
        expect.objectContaining({ id: 'implement', patch: 'apply-unified-diff' }),
        expect.objectContaining({ id: 'approve-fix', kind: 'gate', status: 'pending' }),
      ]),
    }));
    expect(output.join('')).toContain('run-quick-fix');
    expect(output.join('')).toContain('workflow: quick-fix');
    expect(output.join('')).toContain('steps: 4');
    expect(output.join('')).toContain('investigate: pending');
    expect(output.join('')).toContain('verify: pending');
    expect(events.read('run-quick-fix')).toContainEqual(expect.objectContaining({
      type: 'run.started',
      repositoryDirectory: repository,
    }));
  });

  it('freezes a declared verdictPolicy into the run state', () => {
    const { home, store, service } = createRunService();
    const documentationRoot = realpathSync(mkdtempSync(join(tmpdir(), 'impresairio-output-')));
    temporaryDirectories.push(documentationRoot);
    const repository = configureRepository(home, documentationRoot);
    mkdirSync(join(repository, '.impresairio', 'workflows'), { recursive: true });
    writeFileSync(join(repository, '.impresairio', 'workflows', 'verdicted.yaml'), `id: verdicted
name: Verdicted
steps:
  - id: implement
    type: agent
    actor: implementer
    capability: implement
    output:
      id: implementation-report
      filename: "01 - Implementation Report.md"
  - id: verify
    type: agent
    actor: adversary
    capability: verification
    output:
      id: verification
      filename: "02 - Verification.md"
    verdictPolicy:
      changesRequested:
        retryFrom: implement
        maxIterations: 2
      blocked: stop
`);
    const state = service.start({
      workflowId: 'verdicted', repositoryDirectory: repository,
      roles: { implementer: 'opencode-glm', adversary: 'codex' },
      feature: { id: 'VP-1', slug: 'verdict' }, id: 'run-verdict-freeze',
      request: 'Freeze the verdict policy.',
    });
    const verify = store.findState(state.id)?.steps.find((step) => step.id === 'verify');
    expect(verify?.kind === 'agent' ? verify.verdictPolicy : undefined).toEqual({
      changesRequested: { retryFrom: 'implement', maxIterations: 2 },
      blocked: 'stop',
    });
  });

  it('freezes configured fallback candidates into the actor snapshot at start', () => {
    const { home, store, service } = createRunService();
    const documentationRoot = realpathSync(mkdtempSync(join(tmpdir(), 'impresairio-output-')));
    temporaryDirectories.push(documentationRoot);
    const repository = configureRepository(home, documentationRoot);
    const configPath = join(home, 'config.yaml');
    writeFileSync(
      configPath,
      readFileSync(configPath, 'utf8').replace('modelAlias: glm-5.2', 'modelAlias: glm-5.2\n    fallbackProfiles: [codex]'),
      'utf8',
    );

    service.start({
      workflowId: 'quick-fix', repositoryDirectory: repository,
      roles: { launcher: 'claude', adversary: 'codex', implementer: 'opencode-glm' },
      feature: { id: 'FB-1', slug: 'frozen-fallback' }, id: 'run-frozen-fallback',
      request: 'Freeze the configured fallback.',
    });

    expect(store.findState('run-frozen-fallback')?.resolvedActors.implementer).toMatchObject({
      profile: 'opencode-glm',
      fallbacks: [{ profile: 'codex', provider: 'codex' }],
    });
  });

  it('freezes configured Claude Code and Codex model settings into state and run.started', () => {
    const { home, store, events, service } = createRunService();
    const documentationRoot = realpathSync(mkdtempSync(join(tmpdir(), 'impresairio-output-')));
    temporaryDirectories.push(documentationRoot);
    const repository = configureRepository(home, documentationRoot);
    const configPath = join(home, 'config.yaml');
    writeFileSync(
      configPath,
      readFileSync(configPath, 'utf8').replace(
        '  claude:\n    provider: claude-code',
        '  claude:\n    provider: claude-code\n    model: sonnet\n    reasoningEffort: medium',
      ).replace(
        '  codex:\n    provider: codex',
        '  codex:\n    provider: codex\n    model: gpt-5.6-sol\n    reasoningEffort: xhigh',
      ),
      'utf8',
    );

    service.start({
      workflowId: 'quick-fix', repositoryDirectory: repository,
      roles: { launcher: 'claude', adversary: 'codex', implementer: 'opencode-glm' },
      feature: { id: 'SET-1', slug: 'frozen-settings' }, id: 'run-frozen-settings',
      request: 'Freeze provider settings.',
    });

    expect(store.findState('run-frozen-settings')?.resolvedActors).toMatchObject({
      launcher: { profile: 'claude', provider: 'claude-code', model: 'sonnet', reasoningEffort: 'medium' },
      adversary: { profile: 'codex', provider: 'codex', model: 'gpt-5.6-sol', reasoningEffort: 'xhigh' },
    });
    expect(events.read('run-frozen-settings')).toContainEqual(expect.objectContaining({
      type: 'run.started',
      resolvedActors: expect.objectContaining({
        launcher: expect.objectContaining({ model: 'sonnet', reasoningEffort: 'medium' }),
        adversary: expect.objectContaining({ model: 'gpt-5.6-sol', reasoningEffort: 'xhigh' }),
      }),
    }));
  });

  it('binds a custom workflow role with repeatable --actor <role>=<profile>', async () => {
    const { home, store, service } = createRunService();
    const documentationRoot = realpathSync(mkdtempSync(join(tmpdir(), 'impresairio-output-')));
    temporaryDirectories.push(documentationRoot);
    const repository = configureRepository(home, documentationRoot);
    mkdirSync(join(repository, '.impresairio', 'workflows'), { recursive: true });
    writeFileSync(join(repository, '.impresairio', 'workflows', 'authored.yaml'), `id: authored
name: Authored
steps:
  - id: draft
    type: agent
    actor: product-author
    capability: final-report
    output:
      id: draft
      filename: "01 - Draft.md"
`);
    const start = new StartCommand(service, () => undefined);

    await start.run(['authored'], {
      actor: ['product-author=claude'],
      runId: 'run-custom-actor',
      repository,
      featureId: 'IMP-50',
      featureSlug: 'custom-actor',
      request: 'Draft with a free actor role.',
    });

    expect(store.findState('run-custom-actor')).toMatchObject({
      roles: { 'product-author': 'claude' },
    });
  });

  it('rejects a role bound twice with conflicting profiles across --actor and a legacy flag', async () => {
    const { service } = createRunService();
    const start = new StartCommand(service, () => undefined);

    await expect(start.run(['quick-fix'], {
      actor: ['launcher=codex'],
      launcher: 'claude',
      featureId: 'IMP-51', featureSlug: 'duplicate-binding',
      request: 'Attempt a conflicting binding.',
    })).rejects.toThrow('Role "launcher" is bound twice (--launcher); use a single binding');
  });

  it('rejects a malformed --actor binding', async () => {
    const { service } = createRunService();
    const start = new StartCommand(service, () => undefined);

    await expect(start.run(['quick-fix'], {
      actor: ['launcher'],
      featureId: 'IMP-52', featureSlug: 'malformed-binding',
      request: 'Attempt a malformed binding.',
    })).rejects.toThrow('--actor expects <role>=<profile>, received "launcher"');
  });

  it('rejects an --actor binding for a role the workflow does not declare', async () => {
    const { home, service } = createRunService();
    const documentationRoot = realpathSync(mkdtempSync(join(tmpdir(), 'impresairio-output-')));
    temporaryDirectories.push(documentationRoot);
    const repository = configureRepository(home, documentationRoot);
    mkdirSync(join(repository, '.impresairio', 'workflows'), { recursive: true });
    writeFileSync(join(repository, '.impresairio', 'workflows', 'authored.yaml'), `id: authored
name: Authored
steps:
  - id: draft
    type: agent
    actor: product-author
    capability: final-report
    output:
      id: draft
      filename: "01 - Draft.md"
`);
    const start = new StartCommand(service, () => undefined);

    await expect(start.run(['authored'], {
      actor: ['product-author=claude', 'skeptic=claude'],
      repository,
      featureId: 'IMP-53', featureSlug: 'unknown-role',
      request: 'Bind an undeclared role.',
    })).rejects.toThrow('Unknown workflow roles: skeptic; this workflow declares: product-author');
  });

  it('requires a non-empty work request for new runs', async () => {
    const { service } = createRunService();
    const start = new StartCommand(service, () => undefined);

    await expect(start.run(['quick-fix'], {
      launcher: 'claude', adversary: 'codex', implementer: 'opencode-glm',
      featureId: 'IMP-42', featureSlug: 'missing-request',
    })).rejects.toThrow('start requires --request');
  });

  it('rejects a work request beyond the persisted prompt limit', () => {
    const { service } = createRunService();

    expect(() => service.start({
      workflowId: 'quick-fix',
      roles: { launcher: 'claude', adversary: 'codex', implementer: 'opencode-glm' },
      feature: { id: 'IMP-42', slug: 'oversized-request' },
      request: 'x'.repeat(20_001),
    })).toThrow('Work request must not exceed 20000 characters');
  });

  it('fails descriptively if profile resolution does not freeze a workflow actor', () => {
    const agentProfiles = {
      resolveForActors: () => ({}),
    } as unknown as AgentProfileService;
    const { home, service } = createRunService(agentProfiles);
    const documentationRoot = realpathSync(mkdtempSync(join(tmpdir(), 'impresairio-output-')));
    temporaryDirectories.push(documentationRoot);
    const repository = configureRepository(home, documentationRoot);

    expect(() => service.start({
      workflowId: 'quick-fix',
      roles: { launcher: 'claude', adversary: 'codex', implementer: 'opencode-glm' },
      feature: { id: 'IMP-58', slug: 'missing-resolved-actor' },
      request: 'Exercise the defensive actor snapshot check.',
      repositoryDirectory: repository,
    })).toThrow('Agent profile is not frozen for actor launcher');
  });

  it('lists resumable runs newest first', async () => {
    const { home, store, service } = createRunService();
    const documentationRoot = realpathSync(mkdtempSync(join(tmpdir(), 'impresairio-output-')));
    temporaryDirectories.push(documentationRoot);
    const repository = configureRepository(home, documentationRoot);
    service.start({
      id: 'run-first', workflowId: 'quick-fix', roles: { launcher: 'claude', adversary: 'codex', implementer: 'opencode-glm' },
      request: 'Fix the first issue.',
      feature: { id: 'IMP-45', slug: 'first' }, repositoryDirectory: repository,
    });
    service.start({
      id: 'run-second', workflowId: 'quick-fix', roles: { launcher: 'claude', adversary: 'codex', implementer: 'opencode-glm' },
      request: 'Fix the second issue.',
      feature: { id: 'IMP-46', slug: 'second' }, repositoryDirectory: repository,
    });
    const output: string[] = [];
    await new ListCommand(store, (line) => output.push(line)).run();

    expect(output.join('')).toContain('RUN ID\tWORKFLOW\tCURRENT STEP\tUPDATED');
    expect(output.join('')).toContain('run-first\tquick-fix\tnot-started');
    expect(output.join('')).toContain('run-second\tquick-fix\tnot-started');
  });

  it('keeps the resolved step contract through start, next and completion', () => {
    const { home, store, locks, artifactService, service, runner } = createRunService();
    const documentationRoot = realpathSync(mkdtempSync(join(tmpdir(), 'impresairio-output-')));
    temporaryDirectories.push(documentationRoot);
    const repository = configureRepository(home, documentationRoot);
    service.start({
      id: 'run-completion',
      workflowId: 'quick-fix',
      request: 'Investigate a completion failure.',
      roles: { launcher: 'claude', adversary: 'codex', implementer: 'opencode-glm' },
      feature: { id: 'IMP-43', slug: 'completion-test' },
      repositoryDirectory: repository,
    });

    expect(runner.next('run-completion')).toEqual({ kind: 'agent', stepId: 'investigate' });
    const started = store.findState('run-completion');
    const step = started?.steps[0];
    expect(step).toMatchObject({
      kind: 'agent',
      actor: 'launcher',
      method: { capability: 'investigate', promptSource: 'package' },
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
    capability: final-report
    output:
      id: draft
      filename: "01 - Draft.md"
`);
    service.start({
      id: 'run-snapshot', workflowId: 'custom', roles: { launcher: 'claude' },
      request: 'Write a stable snapshot report.',
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
    capability: investigate
    output:
      id: edited
      filename: "99 - Edited.md"
`);

    runner.next('run-snapshot');

    const snapshot = store.findState('run-snapshot');
    expect(snapshot?.steps[0]).toMatchObject({
      actor: 'launcher',
      method: { capability: 'final-report', promptSource: 'package' },
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

  it('freezes promptFile content at run start', () => {
    const { home, store, service } = createRunService();
    const documentationRoot = realpathSync(mkdtempSync(join(tmpdir(), 'impresairio-output-')));
    temporaryDirectories.push(documentationRoot);
    const repository = configureRepository(home, documentationRoot);
    const workflows = join(repository, '.impresairio', 'workflows');
    mkdirSync(join(workflows, 'prompts'), { recursive: true });
    writeFileSync(join(workflows, 'prompted.yaml'), `id: prompted
name: Prompted
steps:
  - id: draft
    type: agent
    actor: launcher
    promptFile: prompts/draft.md
    output:
      id: draft
      filename: "01 - Draft.md"
`);
    const promptPath = join(workflows, 'prompts', 'draft.md');
    writeFileSync(promptPath, 'Write the first draft.\n');

    service.start({
      id: 'run-prompt-snapshot', workflowId: 'prompted', roles: { launcher: 'claude' },
      request: 'Write a report using the frozen prompt.',
      feature: { id: 'IMP-45', slug: 'prompt-snapshot' }, repositoryDirectory: repository,
    });
    writeFileSync(promptPath, 'This change must not affect the run.\n');

    expect(store.findState('run-prompt-snapshot')?.steps[0]).toMatchObject({
      method: { promptFile: 'prompts/draft.md', content: 'Write the first draft.\n' },
    });
  });

  it('freezes a host handoff prompt and contract at run start', () => {
    const { home, store, service } = createRunService();
    const documentationRoot = realpathSync(mkdtempSync(join(tmpdir(), 'impresairio-output-')));
    temporaryDirectories.push(documentationRoot);
    const repository = configureRepository(home, documentationRoot);
    const workflows = join(repository, '.impresairio', 'workflows');
    mkdirSync(join(workflows, 'prompts'), { recursive: true });
    writeFileSync(join(workflows, 'host-handoff.yaml'), `id: host-handoff
name: Host handoff
steps:
  - id: draft
    type: agent
    actor: launcher
    capability: feature-design
    output:
      id: draft
      filename: "01 - Draft.md"
  - id: review
    type: host-handoff
    promptFile: prompts/review.md
    inputs: [draft]
    output:
      id: review
      filename: "02 - Review.md"
    sideEffects: none
`);
    writeFileSync(join(workflows, 'prompts', 'review.md'), 'Review the draft.\n');

    service.start({
      id: 'run-host-contract', workflowId: 'host-handoff', roles: { launcher: 'claude' },
      request: 'Review a frozen host handoff.',
      feature: { id: 'IMP-56', slug: 'host-contract' }, repositoryDirectory: repository,
    });

    expect(store.findState('run-host-contract')?.steps[1]).toMatchObject({
      kind: 'host-handoff', promptFile: 'prompts/review.md', prompt: 'Review the draft.\n',
      inputArtifactIds: ['draft'], declaredOutput: { id: 'review', filename: '02 - Review.md' },
      sideEffects: 'none',
    });
  });

  it('freezes an interactive host capability and allows its artifact at a gate', () => {
    const { home, store, service } = createRunService();
    const documentationRoot = realpathSync(mkdtempSync(join(tmpdir(), 'impresairio-output-')));
    temporaryDirectories.push(documentationRoot);
    const repository = configureRepository(home, documentationRoot);
    const workflows = join(repository, '.impresairio', 'workflows');
    mkdirSync(workflows, { recursive: true });
    writeFileSync(join(workflows, 'interactive-host.yaml'), `id: interactive-host
name: Interactive host
steps:
  - id: brainstorm
    type: host-handoff
    actor: launcher
    capability: feature-design
    interaction: user-dialog
    inputs: []
    output:
      id: brainstorm
      filename: "01 - Brainstorm.md"
    sideEffects: none
  - id: approve-brainstorm
    type: gate
    artifact: brainstorm
`);

    service.start({
      id: 'run-interactive-host', workflowId: 'interactive-host', roles: { launcher: 'claude' },
      request: 'Clarify the user request before drafting.',
      feature: { id: 'IMP-57', slug: 'interactive-host' }, repositoryDirectory: repository,
    });

    const steps = store.findState('run-interactive-host')?.steps;
    expect(steps?.find((step) => step.id === 'brainstorm')).toMatchObject({
      kind: 'host-handoff', actor: 'launcher', interaction: 'user-dialog',
      method: { capability: 'feature-design', promptSource: 'package' },
    });
    expect(steps?.find((step) => step.id === 'approve-brainstorm')).toMatchObject({
      kind: 'gate', artifact: 'brainstorm',
    });
  });
});
