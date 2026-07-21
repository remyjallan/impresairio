import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { StatusCommand } from '../src/commands/status.command';
import { HomeDirectoryResolver } from '../src/config/home-directory.resolver';
import { ConfigService } from '../src/config/config.service';
import { EventLogService } from '../src/runs/event-log.service';
import { FileStateStore } from '../src/runs/file-state.store';
import { RunLockService } from '../src/runs/run-lock.service';
import { RunService } from '../src/runs/run.service';
import { CompletionService } from '../src/runs/completion.service';
import { WorkflowRegistryService } from '../src/workflows/workflow-registry.service';
import { WorkflowRunnerService } from '../src/workflows/workflow-runner.service';
import { StaleInvalidationService } from '../src/workflows/stale-invalidation.service';
import { GateService } from '../src/workflows/gate.service';
import { VerdictCompletionPolicy } from '../src/workflows/verdict-completion.policy';
import { ArtifactService } from '../src/documentation/artifact.service';
import { FilesystemDocumentationTarget } from '../src/documentation/filesystem-documentation.target';
import { PathRendererService } from '../src/documentation/path-renderer.service';
import { AgentProfileService } from '../src/agents/agent-profile.service';
import { CapabilityResolverService } from '../src/agents/capability-resolver.service';

const temporaryDirectories: string[] = [];

function createHarness() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'impresairio-verdict-it-')));
  temporaryDirectories.push(home);
  const documentationRoot = realpathSync(mkdtempSync(join(tmpdir(), 'impresairio-verdict-docs-')));
  temporaryDirectories.push(documentationRoot);
  const repository = realpathSync(mkdtempSync(join(tmpdir(), 'impresairio-verdict-repo-')));
  temporaryDirectories.push(repository);

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
  name: Verdict Project
  slug: verdict-project
documentation:
  target: personal-vault
  featurePath: "Specs/{{ feature.id }} - {{ feature.slug }}"
  format: markdown
`);
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
        maxIterations: 1
      blocked: stop
`);

  const resolver = new HomeDirectoryResolver({ IMPRESAIRIO_HOME: home });
  const store = new FileStateStore(resolver);
  const events = new EventLogService(resolver);
  const locks = new RunLockService(store, events, {
    hostname: 'local-machine', pid: 4242, isPidActive: () => false,
    now: () => new Date('2026-07-21T10:00:00.000Z'),
  });
  const workflows = new WorkflowRegistryService(resolver, {
    packageWorkflowsDirectory: join(__dirname, '..', 'src', 'workflows', 'builtins'),
    currentDirectory: () => repository,
  });
  const artifactService = new ArtifactService(new PathRendererService(), new FilesystemDocumentationTarget());
  const stale = new StaleInvalidationService(store, events, artifactService, () => new Date('2026-07-21T10:01:00.000Z'));
  const runner = new WorkflowRunnerService(store, events, locks, artifactService, stale, () => new Date('2026-07-21T10:01:00.000Z'));
  const completion = new CompletionService(store, artifactService, undefined, undefined, new VerdictCompletionPolicy(store));
  const gates = new GateService(store, locks, stale);
  const runService = new RunService(
    store, events, locks, workflows, new ConfigService(resolver), new AgentProfileService(),
    new CapabilityResolverService(resolver),
    () => new Date('2026-07-21T10:00:00.000Z'),
  );

  function startRun(runId: string): string {
    runService.start({
      id: runId, workflowId: 'verdicted', repositoryDirectory: repository,
      roles: { implementer: 'opencode-glm', adversary: 'codex' },
      feature: { id: 'VP-9', slug: 'verdict' },
      request: 'Correct the defect and verify it.',
    });
    return runId;
  }

  function completeWith(runId: string, stepId: string, content: string): void {
    const result = runner.next(runId);
    expect(result).toEqual({ kind: 'agent', stepId });
    const state = store.findState(runId);
    const step = state?.steps.find((candidate) => candidate.id === stepId);
    if (!step || step.kind !== 'agent' || !step.expectedOutput) throw new Error(`step ${stepId} has no prepared output`);
    writeFileSync(step.expectedOutput.path, content, 'utf8');
    completion.complete(runId, stepId);
  }

  function statusOutput(runId: string): string {
    const lines: string[] = [];
    const status = new StatusCommand(store, (line) => lines.push(line));
    void status.run([runId]);
    return lines.join('');
  }

  return { store, events, runner, completion, gates, startRun, completeWith, statusOutput };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('terminal verdict policies (integration)', () => {
  it('DOG-6: a BLOCKED verification halts the run until acknowledged', () => {
    const { events, runner, gates, startRun, completeWith, statusOutput } = createHarness();
    const runId = startRun('run-dog6');

    completeWith(runId, 'implement', 'implemented\n');
    completeWith(runId, 'verify', 'sandbox is read-only\n\nVERDICT: BLOCKED\n');

    expect(runner.next(runId)).toEqual({
      kind: 'blocked', stepId: 'verify',
      warnings: [expect.stringContaining('VERDICT: BLOCKED')],
    });
    expect(statusOutput(runId)).toContain('warning: step verify halted with VERDICT: BLOCKED');
    expect(events.read(runId)).toContainEqual(expect.objectContaining({ type: 'verdict.blocked', stepId: 'verify' }));

    gates.acknowledge(runId, 'verify', 'verified locally outside the sandbox');

    expect(runner.next(runId)).toEqual({ kind: 'complete' });
    expect(statusOutput(runId)).not.toContain('warning:');
    expect(events.read(runId)).toContainEqual(expect.objectContaining({
      type: 'verdict.acknowledged', stepId: 'verify', comment: 'verified locally outside the sandbox',
    }));
  });

  it('CHANGES_REQUESTED reopens the target with reviewer feedback, then completes on APPROVED', () => {
    const { store, events, runner, startRun, completeWith } = createHarness();
    const runId = startRun('run-loop');

    completeWith(runId, 'implement', 'first attempt\n');
    completeWith(runId, 'verify', 'missing edge case\n\nVERDICT: CHANGES_REQUESTED\n');

    const state = store.findState(runId);
    const implement = state?.steps.find((step) => step.id === 'implement');
    const verify = state?.steps.find((step) => step.id === 'verify');
    expect(implement?.status).toBe('pending');
    expect(implement?.kind === 'agent' ? implement.retryContext?.sourceStepId : undefined).toBe('verify');
    expect(verify?.status).toBe('pending');
    expect(events.read(runId)).toContainEqual(expect.objectContaining({
      type: 'verdict.changes_requested', stepId: 'verify', retryFrom: 'implement',
    }));

    completeWith(runId, 'implement', 'second attempt with the edge case\n');
    completeWith(runId, 'verify', 'all good\n\nVERDICT: APPROVED\n');

    expect(runner.next(runId)).toEqual({ kind: 'complete' });
  });

  it('an exhausted retry budget halts instead of completing, and retry reruns the verification', () => {
    const { events, runner, gates, startRun, completeWith } = createHarness();
    const runId = startRun('run-exhaust');

    completeWith(runId, 'implement', 'first attempt\n');
    completeWith(runId, 'verify', 'not good\n\nVERDICT: CHANGES_REQUESTED\n');
    completeWith(runId, 'implement', 'second attempt\n');
    completeWith(runId, 'verify', 'still not good\n\nVERDICT: CHANGES_REQUESTED\n');

    expect(runner.next(runId)).toEqual({
      kind: 'blocked', stepId: 'verify',
      warnings: [expect.stringContaining('exhausted its 1 allowed retries')],
    });
    expect(events.read(runId)).toContainEqual(expect.objectContaining({ type: 'verdict.exhausted', stepId: 'verify' }));

    gates.retry(runId, 'verify');

    completeWith(runId, 'verify', 'fixed after manual correction\n\nVERDICT: APPROVED\n');
    expect(runner.next(runId)).toEqual({ kind: 'complete' });
  });

  it('a frozen V0 run without verdict fields still loads and completes', () => {
    const { store, runner, completion } = createHarness();
    const at = '2026-07-20T10:00:00.000Z';
    const documentationRoot = realpathSync(mkdtempSync(join(tmpdir(), 'impresairio-v0-docs-')));
    temporaryDirectories.push(documentationRoot);
    store.create({
      version: 1,
      id: 'run-v0',
      workflow: { id: 'legacy', sha256: 'a'.repeat(64), successors: { solo: [] } },
      roles: { launcher: 'claude' },
      resolvedActors: { launcher: { profile: 'claude', provider: 'claude-code' } },
      execution: { agentTimeoutSeconds: 1_800 },
      documentation: {
        target: { name: 'personal-vault', kind: 'filesystem', root: documentationRoot, defaultFormat: 'markdown' },
        featurePath: 'Specs/V0',
        bindings: {
          project: { name: 'Legacy', slug: 'legacy' },
          feature: { id: 'V0-1', slug: 'legacy' },
          run: { id: 'run-v0' },
        },
      },
      createdAt: at,
      updatedAt: at,
      steps: [{
        id: 'solo', kind: 'agent', status: 'pending', actor: 'launcher',
        method: { action: 'investigate' },
        declaredOutput: { id: 'investigation', filename: '01 - Investigation.md', storage: 'documentation' },
        attempts: [],
      }],
    });

    expect(runner.next('run-v0')).toEqual({ kind: 'agent', stepId: 'solo' });
    const state = store.findState('run-v0');
    const solo = state?.steps.find((step) => step.id === 'solo');
    if (!solo || solo.kind !== 'agent' || !solo.expectedOutput) throw new Error('missing prepared output');
    writeFileSync(solo.expectedOutput.path, 'legacy investigation without any verdict\n', 'utf8');
    completion.complete('run-v0', 'solo');

    expect(runner.next('run-v0')).toEqual({ kind: 'complete' });
  });
});
