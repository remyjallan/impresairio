import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentFallbackService } from '../src/agents/agent-fallback.service';
import { HomeDirectoryResolver } from '../src/config/home-directory.resolver';
import { EventLogService } from '../src/runs/event-log.service';
import { FileStateStore, RunStateError } from '../src/runs/file-state.store';
import { RunLockService } from '../src/runs/run-lock.service';
import { createRunState } from '../src/runs/run-state.schema';

const directories: string[] = [];

function setup() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'impresairio-fallback-')));
  directories.push(home);
  const resolver = new HomeDirectoryResolver({ IMPRESAIRIO_HOME: home });
  const store = new FileStateStore(resolver);
  const events = new EventLogService(resolver);
  const locks = new RunLockService(store, events, {
    hostname: 'local-machine', pid: 4242, isPidActive: () => false,
    now: () => new Date('2026-07-21T12:00:00.000Z'),
  });
  store.create(createRunState({
    id: 'run-fallback', workflowId: 'quick-fix', workflowSha256: 'a'.repeat(64),
    request: 'Correct the parser.',
    roles: { implementer: 'opencode-glm' },
    resolvedActors: {
      implementer: {
        profile: 'opencode-glm', provider: 'opencode', modelAlias: 'glm-5.2', model: 'openrouter/z-ai/glm-5.2',
        fallbacks: [{ profile: 'codex', provider: 'codex', model: 'gpt-5.6-sol', reasoningEffort: 'xhigh' }],
      },
    },
    documentation: {
      target: { name: 'test', kind: 'filesystem', root: home, defaultFormat: 'markdown' },
      featurePath: 'Features/{{ feature.id }}',
      bindings: {
        project: { name: 'Test', slug: 'test' },
        feature: { id: 'IMP-1', slug: 'fallback' }, run: { id: 'run-fallback' },
      },
    },
    steps: [{
      id: 'implement', kind: 'agent', actor: 'implementer', action: 'implement',
      output: { id: 'implementation', filename: '01 - Implementation.md', storage: 'internal' },
    }],
    now: '2026-07-21T12:00:00.000Z',
  }));
  const initial = store.findState('run-fallback');
  if (!initial) throw new Error('missing run state');
  store.save({
    ...initial,
    currentStepId: 'implement',
    steps: initial.steps.map((step) => step.id === 'implement'
      ? {
          ...step,
          status: 'in_progress' as const,
          attempts: [{ number: 1, startedAt: '2026-07-21T12:00:01.000Z', inputArtifactHashes: {} }],
        }
      : step),
  });
  store.markFailed('run-fallback', 'implement', 'opencode exited with status 1');
  return { store, events, service: new AgentFallbackService(store, events, locks) };
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('AgentFallbackService', () => {
  it('does not select a fallback after a run is abandoned', () => {
    const { store, service } = setup();
    const state = store.findState('run-fallback');
    if (!state) throw new Error('missing run state');
    store.save({ ...state, abandonment: { at: '2026-07-21T12:01:00.000Z', reason: 'Delivered manually.' } });

    expect(() => service.select('run-fallback', 'implement', 'codex', 'Provider failed.'))
      .toThrow('was abandoned');
  });

  it('reopens a failed step with a frozen configured fallback and durable audit history', () => {
    const { store, events, service } = setup();

    service.select('run-fallback', 'implement', 'codex', 'Reviewed the repository diff; OpenCode exited before producing output.');

    const step = store.findState('run-fallback')?.steps[0];
    expect(step).toMatchObject({
      id: 'implement', status: 'pending',
      agentOverride: { profile: 'codex', provider: 'codex', model: 'gpt-5.6-sol', reasoningEffort: 'xhigh' },
      fallbackHistory: [{
        from: { profile: 'opencode-glm', provider: 'opencode', model: 'openrouter/z-ai/glm-5.2' },
        to: { profile: 'codex', provider: 'codex', model: 'gpt-5.6-sol', reasoningEffort: 'xhigh' },
      }],
    });
    expect(events.read('run-fallback')).toContainEqual(expect.objectContaining({
      type: 'agent.fallback.selected', stepId: 'implement', fromProfile: 'opencode-glm', toProfile: 'codex',
      model: 'gpt-5.6-sol', reasoningEffort: 'xhigh',
    }));
  });

  it('rejects unconfigured and non-failed fallbacks', () => {
    const { store, service } = setup();

    expect(() => service.select('run-fallback', 'implement', 'claude', 'Provider failed.'))
      .toThrow(new RunStateError('Profile "claude" is not a configured fallback for actor implementer; allowed fallbacks: codex'));

    service.select('run-fallback', 'implement', 'codex', 'Provider failed before output.');
    expect(() => service.select('run-fallback', 'implement', 'codex', 'Try again.'))
      .toThrow(new RunStateError('Step implement can only select a fallback after a provider failure'));
    expect(store.findState('run-fallback')?.steps[0]?.status).toBe('pending');
  });
});
