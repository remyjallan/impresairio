import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HomeDirectoryResolver } from '../src/config/home-directory.resolver';
import { ConfigService } from '../src/config/config.service';
import { EventLogService } from '../src/runs/event-log.service';
import { FileStateStore } from '../src/runs/file-state.store';
import { RunLockService } from '../src/runs/run-lock.service';
import { RunService } from '../src/runs/run.service';
import { CompletionService } from '../src/runs/completion.service';
import { WorkflowRegistryService } from '../src/workflows/workflow-registry.service';
import { WorkflowExpanderService } from '../src/workflows/workflow-expander.service';
import { WorkflowRunnerService } from '../src/workflows/workflow-runner.service';
import { StaleInvalidationService } from '../src/workflows/stale-invalidation.service';
import { VerdictCompletionPolicy } from '../src/workflows/verdict-completion.policy';
import { ArtifactService } from '../src/documentation/artifact.service';
import { FilesystemDocumentationTarget } from '../src/documentation/filesystem-documentation.target';
import { PathRendererService } from '../src/documentation/path-renderer.service';
import { AgentProfileService } from '../src/agents/agent-profile.service';
import { CapabilityResolverService } from '../src/agents/capability-resolver.service';
import { AgentDispatchService } from '../src/agents/agent-dispatch.service';
import { ProviderRegistryService } from '../src/agents/provider-registry.service';
import { ClaudeCodeProvider } from '../src/agents/claude-code.provider';
import { CodexProvider } from '../src/agents/codex.provider';
import { OpenCodeProvider } from '../src/agents/opencode.provider';
import type { AgentProcessRunner, PreparedAgentInvocation } from '../src/agents/agent-provider';
import { createRunState } from '../src/runs/run-state.schema';

const temporaryDirectories: string[] = [];

class PassthroughProcessRunner implements AgentProcessRunner {
  prepare(invocation: PreparedAgentInvocation): PreparedAgentInvocation {
    return invocation;
  }
}

function createHarness() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'impresairio-capability-it-')));
  temporaryDirectories.push(home);
  const documentationRoot = realpathSync(mkdtempSync(join(tmpdir(), 'impresairio-capability-docs-')));
  temporaryDirectories.push(documentationRoot);
  const repository = realpathSync(mkdtempSync(join(tmpdir(), 'impresairio-capability-repo-')));
  temporaryDirectories.push(repository);

  writeFileSync(join(home, 'config.yaml'), `documentationTargets:
  personal-vault:
    kind: filesystem
    root: ${documentationRoot}
    defaultFormat: markdown
agentProfiles:
  claude:
    provider: claude-code
    skills:
      threat-review: local:review-skill
  codex:
    provider: codex
models: {}
`);
  writeFileSync(join(repository, '.impresairio.yaml'), `project:
  name: Capability Project
  slug: capability-project
documentation:
  target: personal-vault
  featurePath: "Specs/{{ feature.id }} - {{ feature.slug }}"
  format: markdown
`);
  // A global capability prompt the author role resolves through.
  mkdirSync(join(home, 'prompts'), { recursive: true });
  writeFileSync(join(home, 'prompts', 'threat-model.md'), 'Produce a threat model for the change.\n', 'utf8');
  // Custom workflow with invented roles and capabilities.
  mkdirSync(join(repository, '.impresairio', 'workflows'), { recursive: true });
  writeFileSync(join(repository, '.impresairio', 'workflows', 'threat.yaml'), `id: threat
name: Threat
steps:
  - id: model
    type: agent
    actor: product-author
    capability: threat-model
    output:
      id: threat-model
      filename: "01 - Threat Model.md"
  - id: challenge
    type: agent
    actor: skeptic
    capability: threat-review
    output:
      id: threat-review
      filename: "02 - Threat Review.md"
    verdictPolicy:
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
  const dispatch = new AgentDispatchService(
    store,
    new ProviderRegistryService([new ClaudeCodeProvider(), new CodexProvider(), new OpenCodeProvider()]),
    events,
    new PassthroughProcessRunner(),
    locks,
  );
  const runService = new RunService(
    store, events, locks, workflows, new WorkflowExpanderService(workflows), new ConfigService(resolver), new AgentProfileService(),
    new CapabilityResolverService(resolver),
    artifactService,
    () => new Date('2026-07-21T10:00:00.000Z'),
  );

  function completeWith(runId: string, stepId: string, content: string): void {
    const result = runner.next(runId);
    expect(result).toEqual({ kind: 'agent', stepId });
    const step = store.findState(runId)?.steps.find((candidate) => candidate.id === stepId);
    if (!step || step.kind !== 'agent' || !step.expectedOutput) throw new Error(`step ${stepId} has no prepared output`);
    writeFileSync(step.expectedOutput.path, content, 'utf8');
    completion.complete(runId, stepId);
  }

  return { home, documentationRoot, repository, store, runner, completion, dispatch, runService, completeWith };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('configurable capabilities and actors (integration)', () => {
  it('runs a workflow with invented roles and capabilities resolved at start', () => {
    const { repository, store, runner, dispatch, runService, completeWith } = createHarness();
    runService.start({
      id: 'run-threat', workflowId: 'threat', repositoryDirectory: repository,
      roles: { 'product-author': 'codex', skeptic: 'claude' },
      feature: { id: 'THR-1', slug: 'threat' },
      request: 'Assess the risk of the new endpoint.',
    });

    const frozen = store.findState('run-threat');
    const model = frozen?.steps.find((step) => step.id === 'model');
    const challenge = frozen?.steps.find((step) => step.id === 'challenge');
    // The author capability resolves through the global prompt file.
    expect(model?.kind === 'agent' ? model.method : undefined)
      .toEqual({ capability: 'threat-model', promptSource: 'global', content: 'Produce a threat model for the change.\n' });
    // The reviewer capability resolves through the profile skill map.
    expect(challenge?.kind === 'agent' ? challenge.method : undefined)
      .toEqual({ capability: 'threat-review', skill: 'local:review-skill' });

    // The reviewer handoff surfaces the configured skill.
    completeWith('run-threat', 'model', 'threat model body\n');
    const handoff = dispatch.prepare('run-threat', runner.next('run-threat'));
    expect(handoff?.instruction).toMatchObject({ kind: 'native-skill', skill: 'local:review-skill' });

    completeWith('run-threat', 'challenge', 'looks safe\n\nVERDICT: APPROVED\n');
    expect(runner.next('run-threat')).toEqual({ kind: 'complete' });
  });

  it('fails start when a capability cannot be resolved for the bound profile', () => {
    const { repository, runService } = createHarness();
    expect(() => runService.start({
      id: 'run-threat-unresolved', workflowId: 'threat', repositoryDirectory: repository,
      // codex has no skill for threat-review and there is no prompt file for it.
      roles: { 'product-author': 'codex', skeptic: 'codex' },
      feature: { id: 'THR-2', slug: 'threat' },
      request: 'Assess the risk of the new endpoint.',
    })).toThrow(/has no method for capability "threat-review"/);
  });

  it('loads and runs a frozen V0 run whose step uses a legacy action method', () => {
    const { home, documentationRoot, store, runner, completion, dispatch } = createHarness();
    const at = '2026-07-20T10:00:00.000Z';
    store.create(createRunState({
      id: 'run-legacy',
      workflowId: 'quick-fix',
      request: 'Legacy run.',
      workflowSha256: 'a'.repeat(64),
      roles: { launcher: 'claude' },
      resolvedActors: { launcher: { profile: 'claude', provider: 'claude-code' } },
      documentation: {
        target: { name: 'personal-vault', kind: 'filesystem', root: documentationRoot, defaultFormat: 'markdown' },
        featurePath: 'Specs/{{ feature.id }}',
        bindings: {
          project: { name: 'Legacy', slug: 'legacy' },
          feature: { id: 'V0-9', slug: 'legacy' },
          run: { id: 'run-legacy' },
        },
      },
      steps: [{
        id: 'solo', kind: 'agent', actor: 'launcher', action: 'investigate',
        output: { id: 'investigation', filename: '01 - Investigation.md' },
      }],
      now: at,
    }));
    // Silence unused-home lint by referencing it.
    expect(home).toContain('impresairio-capability-it-');

    const result = runner.next('run-legacy');
    expect(result).toEqual({ kind: 'agent', stepId: 'solo' });
    const handoff = dispatch.prepare('run-legacy', result);
    expect(handoff?.instruction).toMatchObject({
      kind: 'fallback-prompt',
      content: expect.stringContaining('Inspect relevant repository files and tests'),
    });

    const step = store.findState('run-legacy')?.steps.find((candidate) => candidate.id === 'solo');
    if (!step || step.kind !== 'agent' || !step.expectedOutput) throw new Error('missing prepared output');
    writeFileSync(step.expectedOutput.path, 'legacy investigation\n', 'utf8');
    completion.complete('run-legacy', 'solo');
    expect(runner.next('run-legacy')).toEqual({ kind: 'complete' });
  });
});
