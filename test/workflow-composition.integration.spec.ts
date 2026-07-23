import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentProfileService } from '../src/agents/agent-profile.service';
import { CapabilityResolverService } from '../src/agents/capability-resolver.service';
import { ConfigService } from '../src/config/config.service';
import { HomeDirectoryResolver } from '../src/config/home-directory.resolver';
import { ArtifactService } from '../src/documentation/artifact.service';
import { FilesystemDocumentationTarget } from '../src/documentation/filesystem-documentation.target';
import { PathRendererService } from '../src/documentation/path-renderer.service';
import { CompletionService } from '../src/runs/completion.service';
import { EventLogService } from '../src/runs/event-log.service';
import { FileStateStore } from '../src/runs/file-state.store';
import { RunLockService } from '../src/runs/run-lock.service';
import { RunService } from '../src/runs/run.service';
import { GateService } from '../src/workflows/gate.service';
import { StaleInvalidationService } from '../src/workflows/stale-invalidation.service';
import { VerdictCompletionPolicy } from '../src/workflows/verdict-completion.policy';
import { WorkflowExpanderService } from '../src/workflows/workflow-expander.service';
import { WorkflowRegistryService } from '../src/workflows/workflow-registry.service';
import { WorkflowRunnerService } from '../src/workflows/workflow-runner.service';

const temporaryDirectories: string[] = [];

function createHarness() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'impresairio-composition-home-')));
  const documentationRoot = realpathSync(mkdtempSync(join(tmpdir(), 'impresairio-composition-docs-')));
  const repository = realpathSync(mkdtempSync(join(tmpdir(), 'impresairio-composition-repo-')));
  const packageWorkflows = realpathSync(mkdtempSync(join(tmpdir(), 'impresairio-composition-package-')));
  temporaryDirectories.push(home, documentationRoot, repository, packageWorkflows);

  writeFileSync(join(home, 'config.yaml'), `documentationTargets:
  vault:
    kind: filesystem
    root: ${documentationRoot}
    defaultFormat: markdown
agentProfiles:
  codex:
    provider: codex
models: {}
`);
  writeFileSync(join(repository, '.impresairio.yaml'), `project:
  name: Composition Project
  slug: composition-project
documentation:
  target: vault
  featurePath: "Specs/{{ feature.id }} - {{ feature.slug }}"
  format: markdown
`);
  mkdirSync(join(home, 'workflows', 'prompts'), { recursive: true });
  mkdirSync(join(repository, '.impresairio', 'workflows'), { recursive: true });

  const resolver = new HomeDirectoryResolver({ IMPRESAIRIO_HOME: home });
  const store = new FileStateStore(resolver);
  const events = new EventLogService(resolver);
  const locks = new RunLockService(store, events, {
    hostname: 'local-machine', pid: 4242, isPidActive: () => false,
    now: () => new Date('2026-07-21T12:00:00.000Z'),
  });
  const registry = new WorkflowRegistryService(resolver, {
    packageWorkflowsDirectory: packageWorkflows,
    currentDirectory: () => repository,
  });
  const artifacts = new ArtifactService(new PathRendererService(), new FilesystemDocumentationTarget());
  const stale = new StaleInvalidationService(store, events, artifacts, () => new Date('2026-07-21T12:01:00.000Z'));
  const runner = new WorkflowRunnerService(store, events, locks, artifacts, stale, () => new Date('2026-07-21T12:01:00.000Z'));
  const completion = new CompletionService(store, artifacts, undefined, undefined, new VerdictCompletionPolicy(store));
  const gates = new GateService(store, locks, stale);
  const runService = new RunService(
    store,
    events,
    locks,
    registry,
    new WorkflowExpanderService(registry),
    new ConfigService(resolver),
    new AgentProfileService(),
    new CapabilityResolverService(resolver),
    artifacts,
    () => new Date('2026-07-21T12:00:00.000Z'),
  );

  function completeWith(runId: string, stepId: string, content: string): void {
    expect(runner.next(runId)).toEqual({ kind: 'agent', stepId });
    const step = store.findState(runId)?.steps.find((candidate) => candidate.id === stepId);
    if (!step || step.kind !== 'agent' || !step.expectedOutput) {
      throw new Error(`step ${stepId} has no prepared output`);
    }
    writeFileSync(step.expectedOutput.path, content, 'utf8');
    completion.complete(runId, stepId);
  }

  return {
    home,
    documentationRoot,
    repository,
    packageWorkflows,
    store,
    events,
    runner,
    gates,
    runService,
    completeWith,
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('workflow composition (integration)', () => {
  it('freezes repository, global and package definitions and runs child gates in sequence', () => {
    const harness = createHarness();
    const childPrompt = join(harness.home, 'workflows', 'prompts', 'draft.md');
    writeFileSync(childPrompt, 'Draft the composed analysis.\n', 'utf8');
    writeFileSync(join(harness.home, 'workflows', 'analysis.yaml'), `id: analysis
name: Analysis
steps:
  - id: draft
    type: agent
    actor: author
    promptFile: prompts/draft.md
    output:
      id: analysis
      filename: "01 - Analysis.md"
  - id: approve
    type: gate
    artifact: analysis
`, 'utf8');
    writeFileSync(join(harness.packageWorkflows, 'report.yaml'), `id: report
name: Report
steps:
  - id: write
    type: agent
    actor: reporter
    capability: final-report
    output:
      id: report
      filename: "02 - Report.md"
`, 'utf8');
    const rootWorkflow = join(harness.repository, '.impresairio', 'workflows', 'composed.yaml');
    writeFileSync(rootWorkflow, `id: composed
name: Composed
steps:
  - id: analysis
    uses: workflow:analysis
    actors:
      author: launcher
  - id: reporting
    uses: workflow:report
    actors:
      reporter: launcher
`, 'utf8');

    const state = harness.runService.start({
      id: 'run-composed',
      workflowId: 'composed',
      repositoryDirectory: harness.repository,
      roles: { launcher: 'codex' },
      feature: { id: 'COMP-1', slug: 'composition' },
      request: 'Exercise a composed workflow.',
    });

    expect(state.steps.map((step) => step.id)).toEqual([
      'analysis--draft',
      'analysis--approve',
      'reporting--write',
    ]);
    expect(state.workflow.definitions).toEqual([
      expect.objectContaining({ instanceId: 'root', workflowId: 'composed', source: 'repository' }),
      expect.objectContaining({ instanceId: 'mount:analysis', workflowId: 'analysis', source: 'global' }),
      expect.objectContaining({ instanceId: 'mount:reporting', workflowId: 'report', source: 'package' }),
    ]);
    const draft = state.steps[0];
    expect(draft.kind === 'agent' ? draft.method : undefined).toEqual({
      promptFile: 'prompts/draft.md',
      content: 'Draft the composed analysis.\n',
    });
    const started = harness.events.read('run-composed').find((event) => event.type === 'run.started');
    expect(started?.workflowDefinitions).toEqual(state.workflow.definitions);

    writeFileSync(childPrompt, 'This later edit must not affect the run.\n', 'utf8');
    writeFileSync(rootWorkflow, 'invalid after start\n', 'utf8');
    expect(harness.store.findState('run-composed')?.steps[0]).toEqual(draft);

    harness.completeWith('run-composed', 'analysis--draft', 'analysis body\n');
    expect(harness.runner.next('run-composed')).toEqual({ kind: 'gate', stepId: 'analysis--approve' });
    harness.gates.approve('run-composed', 'analysis--approve');
    harness.completeWith('run-composed', 'reporting--write', 'report body\n');
    expect(harness.runner.next('run-composed')).toEqual({ kind: 'complete' });
  });

  it('rejects cross-workflow artifact collisions before creating run state or documentation', () => {
    const harness = createHarness();
    writeFileSync(join(harness.packageWorkflows, 'first.yaml'), `id: first
name: First
steps:
  - id: write
    type: agent
    actor: launcher
    capability: final-report
    output: { id: first, filename: "Shared.md" }
`, 'utf8');
    writeFileSync(join(harness.packageWorkflows, 'second.yaml'), `id: second
name: Second
steps:
  - id: write
    type: agent
    actor: launcher
    capability: final-report
    output: { id: second, filename: "shared.md" }
`, 'utf8');
    writeFileSync(join(harness.repository, '.impresairio', 'workflows', 'collision.yaml'), `id: collision
name: Collision
steps:
  - id: first
    uses: workflow:first
  - id: second
    uses: workflow:second
`, 'utf8');

    expect(() => harness.runService.start({
      id: 'run-collision',
      workflowId: 'collision',
      repositoryDirectory: harness.repository,
      roles: { launcher: 'codex' },
      feature: { id: 'COMP-2', slug: 'collision' },
      request: 'Detect a collision.',
    })).toThrow(/Artifact destination collision.*first--write.*second--write/);
    expect(harness.store.findState('run-collision')).toBeUndefined();
    expect(harness.events.read('run-collision')).toEqual([]);
    expect(existsSync(join(harness.documentationRoot, 'Specs', 'COMP-2 - collision'))).toBe(false);
  });

  it('rejects mounting the same publishing workflow twice when filenames are unchanged', () => {
    const harness = createHarness();
    writeFileSync(join(harness.packageWorkflows, 'publisher.yaml'), `id: publisher
name: Publisher
steps:
  - id: write
    type: agent
    actor: launcher
    capability: final-report
    output: { id: report, filename: "Report.md" }
`, 'utf8');
    writeFileSync(join(harness.repository, '.impresairio', 'workflows', 'repeated.yaml'), `id: repeated
name: Repeated
steps:
  - id: first
    uses: workflow:publisher
  - id: second
    uses: workflow:publisher
`, 'utf8');

    expect(() => harness.runService.start({
      id: 'run-repeated',
      workflowId: 'repeated',
      repositoryDirectory: harness.repository,
      roles: { launcher: 'codex' },
      feature: { id: 'COMP-4', slug: 'repeated' },
      request: 'Detect repeated publisher destinations.',
    })).toThrow(/Artifact destination collision.*first--write.*second--write/);
    expect(harness.store.findState('run-repeated')).toBeUndefined();
    expect(harness.events.read('run-repeated')).toEqual([]);
  });

  it('reopens namespaced child work and stales its gate after a negative terminal verdict', () => {
    const harness = createHarness();
    writeFileSync(join(harness.packageWorkflows, 'delivery.yaml'), `id: delivery
name: Delivery
steps:
  - id: implement
    type: agent
    actor: builder
    capability: implement
    output: { id: implementation, filename: "07 - Implementation.md" }
  - id: approve-implementation
    type: gate
    artifact: implementation
  - id: verify
    type: agent
    actor: reviewer
    capability: verification
    output: { id: verification, filename: "08 - Verification.md" }
    verdictPolicy:
      changesRequested:
        retryFrom: implement
        maxIterations: 2
      blocked: stop
`, 'utf8');
    writeFileSync(join(harness.repository, '.impresairio', 'workflows', 'retry-composed.yaml'), `id: retry-composed
name: Retry composed
steps:
  - id: delivery
    uses: workflow:delivery
    actors:
      builder: implementer
      reviewer: adversary
`, 'utf8');

    harness.runService.start({
      id: 'run-composed-retry',
      workflowId: 'retry-composed',
      repositoryDirectory: harness.repository,
      roles: { implementer: 'codex', adversary: 'codex' },
      feature: { id: 'COMP-3', slug: 'retry' },
      request: 'Exercise namespaced verdict recovery.',
    });
    harness.completeWith('run-composed-retry', 'delivery--implement', 'first implementation\n');
    expect(harness.runner.next('run-composed-retry')).toEqual({
      kind: 'gate',
      stepId: 'delivery--approve-implementation',
    });
    harness.gates.approve('run-composed-retry', 'delivery--approve-implementation');
    harness.completeWith(
      'run-composed-retry',
      'delivery--verify',
      'The implementation needs correction.\n\nVERDICT: CHANGES_REQUESTED\n',
    );

    const retried = harness.store.findState('run-composed-retry');
    expect(retried?.steps.map((step) => [step.id, step.status])).toEqual([
      ['delivery--implement', 'pending'],
      ['delivery--approve-implementation', 'stale'],
      ['delivery--verify', 'pending'],
    ]);
    expect(harness.runner.next('run-composed-retry')).toEqual({
      kind: 'agent',
      stepId: 'delivery--implement',
    });
  });

  it('freezes typed parameters through a child mapping and skips a false conditional agent', () => {
    const harness = createHarness();
    writeFileSync(join(harness.packageWorkflows, 'classify.yaml'), `id: classify
name: Classify
parameters:
  quality-mode:
    type: enum
    values: [light, strict]
steps:
  - id: classify
    type: agent
    actor: implementer
    capability: investigate
    output: { id: classification, filename: "00 - Classification.md", storage: internal }
    result:
      fields:
        complexity:
          type: enum
          values: [trivial, standard]
  - id: review
    type: agent
    actor: reviewer
    capability: verification
    output: { id: review, filename: "01 - Review.md", storage: internal }
    when:
      notEquals:
        left:
          result: { step: classify, field: complexity }
        right: trivial
`, 'utf8');
    writeFileSync(join(harness.repository, '.impresairio', 'workflows', 'conditional.yaml'), `id: conditional
name: Conditional
parameters:
  quality-mode:
    type: enum
    values: [light, strict]
    default: light
steps:
  - id: classify
    uses: workflow:classify
    actors:
      implementer: implementer
      reviewer: adversary
    with:
      quality-mode:
        fromParameter: quality-mode
`, 'utf8');

    const state = harness.runService.start({
      id: 'run-conditional',
      workflowId: 'conditional',
      repositoryDirectory: harness.repository,
      roles: { implementer: 'codex', adversary: 'codex' },
      feature: { id: 'COMP-5', slug: 'conditional' },
      request: 'Skip a trivial review.',
      parameters: { 'quality-mode': 'strict' },
    });
    expect(state.parameters).toEqual({ 'quality-mode': 'strict' });
    expect(state.steps[0]).toMatchObject({ effectiveParameters: { 'quality-mode': 'strict' } });

    harness.completeWith('run-conditional', 'classify--classify', [
      '# Classification', '', '```impresairio-result', '{"complexity":"trivial"}', '```', '',
    ].join('\n'));
    expect(harness.runner.next('run-conditional')).toEqual({ kind: 'complete' });
    expect(harness.store.findState('run-conditional')?.steps.map((step) => [step.id, step.status])).toEqual([
      ['classify--classify', 'complete'],
      ['classify--review', 'skipped'],
    ]);
    expect(harness.events.read('run-conditional')).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'step.result.recorded', stepId: 'classify--classify' }),
      expect.objectContaining({ type: 'step.skipped', stepId: 'classify--review', reason: 'condition-false' }),
    ]));

    harness.runService.start({
      id: 'run-conditional-true',
      workflowId: 'conditional',
      repositoryDirectory: harness.repository,
      roles: { implementer: 'codex', adversary: 'codex' },
      feature: { id: 'COMP-6', slug: 'conditional-true' },
      request: 'Run a non-trivial review.',
    });
    harness.completeWith('run-conditional-true', 'classify--classify', [
      '# Classification', '', '```impresairio-result', '{"complexity":"standard"}', '```', '',
    ].join('\n'));
    expect(harness.runner.next('run-conditional-true')).toEqual({
      kind: 'agent', stepId: 'classify--review',
    });

    harness.runService.start({
      id: 'run-conditional-invalid-result',
      workflowId: 'conditional',
      repositoryDirectory: harness.repository,
      roles: { implementer: 'codex', adversary: 'codex' },
      feature: { id: 'COMP-7', slug: 'conditional-invalid-result' },
      request: 'Reject an invalid result and preserve it as a failed attempt.',
    });
    expect(() => harness.completeWith('run-conditional-invalid-result', 'classify--classify', '# Missing result\n'))
      .toThrow('Expected exactly one impresairio-result block');
    expect(harness.store.findState('run-conditional-invalid-result')?.steps[0])
      .toMatchObject({ status: 'failed' });
  });
});
