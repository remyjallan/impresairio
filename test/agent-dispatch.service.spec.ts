import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentDispatchService } from '../src/agents/agent-dispatch.service';
import type { AgentProcessRunner, PreparedAgentInvocation } from '../src/agents/agent-provider';
import { ClaudeCodeProvider } from '../src/agents/claude-code.provider';
import { CodexProvider } from '../src/agents/codex.provider';
import { OpenCodeProvider } from '../src/agents/opencode.provider';
import { ProviderRegistryService } from '../src/agents/provider-registry.service';
import { ArtifactService } from '../src/documentation/artifact.service';
import { FilesystemDocumentationTarget } from '../src/documentation/filesystem-documentation.target';
import { PathRendererService } from '../src/documentation/path-renderer.service';
import { HomeDirectoryResolver } from '../src/config/home-directory.resolver';
import { EventLogService } from '../src/runs/event-log.service';
import { FileStateStore } from '../src/runs/file-state.store';
import { RunLockService } from '../src/runs/run-lock.service';
import { createRunState } from '../src/runs/run-state.schema';
import { StaleInvalidationService } from '../src/workflows/stale-invalidation.service';
import { WorkflowRunnerService } from '../src/workflows/workflow-runner.service';
import { NextCommand } from '../src/commands/next.command';

const directories: string[] = [];

class FakeProcessRunner implements AgentProcessRunner {
  readonly calls: PreparedAgentInvocation[] = [];

  prepare(invocation: PreparedAgentInvocation): PreparedAgentInvocation {
    this.calls.push(invocation);
    return invocation;
  }
}

function setup(actor: 'launcher' | 'implementer') {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'impresairio-agent-dispatch-')));
  directories.push(home);
  const resolver = new HomeDirectoryResolver({ IMPRESAIRIO_HOME: home });
  const store = new FileStateStore(resolver);
  const events = new EventLogService(resolver);
  const locks = new RunLockService(store, events, {
    hostname: 'local-machine', pid: 4242, isPidActive: () => false,
    now: () => new Date('2026-07-20T10:00:00.000Z'),
  });
  const artifactService = new ArtifactService(new PathRendererService(), new FilesystemDocumentationTarget());
  const profile = actor === 'launcher'
    ? { profile: 'claude', provider: 'claude-code' as const }
    : {
        profile: 'opencode-glm', provider: 'opencode' as const,
        modelAlias: 'glm-5.2', model: 'z-ai/glm-5.2',
      };
  store.create(createRunState({
    id: 'run-agent', workflowId: 'feature', workflowSha256: 'a'.repeat(64),
    request: 'Add a safe greeting command.',
    roles: { [actor]: profile.profile }, resolvedActors: { [actor]: profile },
    documentation: {
      target: { name: 'test', kind: 'filesystem', root: home, defaultFormat: 'markdown' },
      featurePath: 'Features/{{ feature.id }}',
      bindings: {
        project: { name: 'Test', slug: 'test' },
        feature: { id: 'IMP-1', slug: 'dispatch' }, run: { id: 'run-agent' },
      },
    },
    steps: [
      {
        id: 'work', kind: 'agent', actor, action: actor === 'launcher' ? 'feature-design' : 'implementation',
        output: { id: 'report', filename: '01 - Report.md' },
      },
      { id: 'approve-report', kind: 'gate', artifact: 'report' },
    ],
    now: '2026-07-20T10:00:00.000Z',
  }));
  const runner = new WorkflowRunnerService(
    store, events, locks, artifactService,
    new StaleInvalidationService(store, events, artifactService, () => new Date('2026-07-20T10:01:00.000Z')),
    () => new Date('2026-07-20T10:01:00.000Z'),
  );
  const processRunner = new FakeProcessRunner();
  const dispatch = new AgentDispatchService(
    store,
    new ProviderRegistryService([new ClaudeCodeProvider(), new CodexProvider(), new OpenCodeProvider()]),
    events,
    processRunner,
    locks,
  );
  return { store, events, runner, processRunner, dispatch };
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('AgentDispatchService', () => {
  it('returns a prepared launcher handoff without executing it', () => {
    const { runner, dispatch, processRunner } = setup('launcher');

    const handoff = dispatch.prepare('run-agent', runner.next('run-agent'));

    expect(handoff).toMatchObject({
      mode: 'prepared-non-interactive',
      instruction: expect.objectContaining({ kind: 'fallback-prompt' }),
      expectedOutput: { id: 'report' },
      invocation: { command: 'claude' },
    });
    expect(handoff?.invocation?.input).toContain('Work request:\nAdd a safe greeting command.');
    expect(handoff?.invocation?.input).toContain('Separate observed evidence (including file paths) from assumptions or open questions.');
    expect(processRunner.calls).toHaveLength(1);
  });

  it('renders the launcher result from next as structured handoff JSON', async () => {
    const { runner, dispatch, processRunner } = setup('launcher');
    const output: string[] = [];

    await new NextCommand(runner, dispatch, (line) => output.push(line)).run(['run-agent']);

    expect(JSON.parse(output.join(''))).toMatchObject({
      kind: 'agent', mode: 'prepared-non-interactive', stepId: 'work',
    });
    expect(processRunner.calls).toHaveLength(1);
  });

  it('prints cycle exhaustion warnings before a human gate', async () => {
    const output: string[] = [];
    const command = new NextCommand(
      { next: () => ({ kind: 'gate', stepId: 'approve-design', warnings: ['cycle design exhausted'] }) } as never,
      { prepare: () => undefined } as never,
      (line) => output.push(line),
    );

    await command.run(['run-agent']);

    expect(output.join('')).toBe('warning: cycle design exhausted\ngate: approve-design\n');
  });

  it('prepares OpenCode with its frozen model and records that preparation', () => {
    const { runner, dispatch, processRunner, events } = setup('implementer');

    const handoff = dispatch.prepare('run-agent', runner.next('run-agent'));

    expect(handoff).toMatchObject({
      mode: 'prepared-non-interactive',
      provider: 'opencode',
      invocation: { command: 'opencode', args: ['run', '--model', 'z-ai/glm-5.2'] },
    });
    expect(processRunner.calls).toHaveLength(1);
    expect(events.read('run-agent')).toContainEqual(expect.objectContaining({
      type: 'agent.invocation.prepared', modelAlias: 'glm-5.2', model: 'z-ai/glm-5.2',
    }));
  });

  it('keeps an invocation in repeated handoffs while recording preparation once', () => {
    const { runner, dispatch, processRunner, events } = setup('implementer');
    const result = runner.next('run-agent');

    expect(dispatch.prepare('run-agent', result)?.invocation).toBeDefined();
    expect(dispatch.prepare('run-agent', result)?.invocation).toBeDefined();
    expect(processRunner.calls).toHaveLength(2);
    expect(events.read('run-agent').filter((event) => event.type === 'agent.invocation.prepared')).toHaveLength(1);
  });

  it('injects persisted human gate feedback when a producer is dispatched again', () => {
    const { runner, dispatch, store } = setup('launcher');
    const state = store.findState('run-agent');
    if (!state) throw new Error('missing state');
    store.save({
      ...state,
      steps: state.steps.map((step) => step.kind === 'gate'
        ? { ...step, feedback: [{ requestedAt: '2026-07-20T10:00:00.000Z', comment: 'Clarify empty names.' }] }
        : step),
    });

    const handoff = dispatch.prepare('run-agent', runner.next('run-agent'));

    expect(handoff?.invocation?.input).toContain('Human feedback to address:');
    expect(handoff?.invocation?.input).toContain('Clarify empty names.');
  });

  it('instructs a patch-enabled step to return a controlled unified diff', () => {
    const { runner, dispatch, store } = setup('implementer');
    const state = store.findState('run-agent');
    if (!state) throw new Error('missing state');
    store.save({
      ...state,
      steps: state.steps.map((step) => step.id === 'work' && step.kind === 'agent'
        ? { ...step, patch: 'apply-unified-diff' as const }
        : step),
    });

    const handoff = dispatch.prepare('run-agent', runner.next('run-agent'));

    expect(handoff?.invocation?.input).toContain('`impresairio-patch` block');
    expect(handoff?.invocation?.input).toContain('`diff --git a/path b/path`');
    expect(handoff?.invocation?.input).toContain('enough unchanged context for Git to apply it');
    expect(handoff?.invocation?.input).toContain('do not modify them directly');
  });

  it('lists declared enum result values in the agent handoff', () => {
    const { runner, dispatch, store } = setup('implementer');
    const state = store.findState('run-agent');
    if (!state) throw new Error('missing state');
    store.save({
      ...state,
      steps: state.steps.map((step) => step.id === 'work' && step.kind === 'agent'
        ? {
            ...step,
            declaredResult: {
              fields: { complexity: { type: 'enum' as const, values: ['trivial', 'standard', 'complex'] } },
            },
          }
        : step),
    });

    const handoff = dispatch.prepare('run-agent', runner.next('run-agent'));

    expect(handoff?.invocation?.input).toContain(
      'complexity (enum; allowed values: trivial, standard, complex)',
    );
  });

  it('preserves context additions for configured skills and prompt files', () => {
    const { runner, dispatch, store } = setup('launcher');
    const state = store.findState('run-agent');
    if (!state) throw new Error('missing state');
    store.save({
      ...state,
      resolvedActors: {
        ...state.resolvedActors,
        launcher: { ...state.resolvedActors.launcher, skills: { 'feature-design': 'local:brainstorming' } },
      },
      steps: state.steps.map((step) => step.kind === 'gate'
        ? { ...step, feedback: [{ requestedAt: '2026-07-20T10:00:00.000Z', comment: 'Keep it small.' }] }
        : step),
    });
    const skillHandoff = dispatch.prepare('run-agent', runner.next('run-agent'));
    expect(skillHandoff?.instruction).toMatchObject({ kind: 'native-skill', skill: 'local:brainstorming' });
    expect(skillHandoff?.invocation?.input).toContain('Use skill: local:brainstorming');
    expect(skillHandoff?.invocation?.input).toContain('Keep it small.');

    const current = store.findState('run-agent');
    if (!current) throw new Error('missing current state');
    store.save({
      ...current,
      resolvedActors: { ...current.resolvedActors, launcher: { profile: 'claude', provider: 'claude-code' } },
      steps: current.steps.map((step) => step.id === 'work' && step.kind === 'agent'
        ? { ...step, method: { promptFile: 'prompts/custom.md', content: 'Custom instructions.' } }
        : step),
    });
    const promptHandoff = dispatch.prepare('run-agent', { kind: 'agent', stepId: 'work' });
    expect(promptHandoff?.invocation?.input).toContain('Custom instructions.');
    expect(promptHandoff?.invocation?.input).toContain('Keep it small.');
  });

  it('drives verdict transport from a declared policy, not action names', () => {
    const { runner, dispatch, store } = setup('launcher');
    const state = store.findState('run-agent');
    if (!state) throw new Error('missing state');
    store.save({
      ...state,
      steps: state.steps.map((step) => step.id === 'work' && step.kind === 'agent'
        ? { ...step, verdictPolicy: { blocked: 'stop' as const } }
        : step),
    });

    const handoff = dispatch.prepare('run-agent', runner.next('run-agent'));

    expect(handoff?.invocation?.args).toContain('--json-schema');
    expect(handoff?.invocation?.input).toContain(
      'End the Markdown response with exactly one of: VERDICT: APPROVED, VERDICT: CHANGES_REQUESTED, or VERDICT: BLOCKED.',
    );
  });

  it('omits verdict transport for plain steps', () => {
    const { runner, dispatch } = setup('launcher');

    const handoff = dispatch.prepare('run-agent', runner.next('run-agent'));

    expect(handoff?.invocation?.args).not.toContain('--json-schema');
    expect(handoff?.invocation?.input).not.toContain('End the Markdown response with exactly one of');
  });

  it('dispatches a frozen skill capability without consulting profile skills', () => {
    const { runner, dispatch, store } = setup('launcher');
    const state = store.findState('run-agent');
    if (!state) throw new Error('missing state');
    store.save({
      ...state,
      resolvedActors: {
        ...state.resolvedActors,
        launcher: { ...state.resolvedActors.launcher, skills: { 'feature-design': 'local:should-not-be-used' } },
      },
      steps: state.steps.map((step) => step.id === 'work' && step.kind === 'agent'
        ? { ...step, method: { capability: 'feature-design', skill: 'local:frozen-skill' } }
        : step),
    });

    const handoff = dispatch.prepare('run-agent', runner.next('run-agent'));

    expect(handoff?.instruction).toMatchObject({ kind: 'native-skill', skill: 'local:frozen-skill' });
  });

  it('dispatches a frozen prompt capability using its exact content', () => {
    const { runner, dispatch, store } = setup('launcher');
    const state = store.findState('run-agent');
    if (!state) throw new Error('missing state');
    store.save({
      ...state,
      steps: state.steps.map((step) => step.id === 'work' && step.kind === 'agent'
        ? { ...step, method: { capability: 'feature-design', promptSource: 'global' as const, content: 'Custom global capability prompt.' } }
        : step),
    });

    const handoff = dispatch.prepare('run-agent', runner.next('run-agent'));

    expect(handoff?.instruction?.kind).toBe('fallback-prompt');
    expect((handoff?.instruction as { content: string }).content).toContain('Custom global capability prompt.');
  });

  it('injects the reviewer feedback artifact into a reopened step', () => {
    const { runner, dispatch, store } = setup('launcher');
    const feedbackDirectory = realpathSync(mkdtempSync(join(tmpdir(), 'impresairio-feedback-')));
    directories.push(feedbackDirectory);
    const feedbackPath = join(feedbackDirectory, 'v.md');
    writeFileSync(feedbackPath, 'Fix the empty-name handling.\n\nVERDICT: CHANGES_REQUESTED\n', 'utf8');
    const state = store.findState('run-agent');
    if (!state) throw new Error('missing state');
    store.save({
      ...state,
      steps: state.steps.map((step) => step.id === 'work' && step.kind === 'agent'
        ? {
            ...step,
            retryContext: {
              sourceStepId: 'verify', artifactPath: feedbackPath,
              artifactSha256: 'c'.repeat(64), at: '2026-07-20T10:03:00.000Z',
            },
          }
        : step),
    });

    const handoff = dispatch.prepare('run-agent', runner.next('run-agent'));

    expect(handoff?.invocation?.input).toContain('Reviewer feedback to address:');
    expect(handoff?.invocation?.input).toContain('Fix the empty-name handling.');
  });
});
