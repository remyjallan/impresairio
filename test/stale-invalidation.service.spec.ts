import { describe, expect, it } from 'vitest';
import { createRunState, type RunState } from '../src/runs/run-state.schema';
import { GateService } from '../src/workflows/gate.service';
import { StaleInvalidationService } from '../src/workflows/stale-invalidation.service';

function createHarness() {
  const now = () => new Date('2026-07-20T10:10:00.000Z');
  const initial = createRunState({
    id: 'run-stale', workflowId: 'feature', workflowSha256: 'a'.repeat(64), roles: {},
    documentation: {
      target: { name: 'test', kind: 'filesystem', root: '/tmp/docs', defaultFormat: 'markdown' },
      featurePath: 'unused',
      bindings: {
        project: { name: 'Test', slug: 'test' }, feature: { id: 'TEST-1', slug: 'test-1' },
        run: { id: 'run-stale' },
      },
    },
    steps: [
      { id: 'design', kind: 'agent', actor: 'launcher', action: 'feature-design', output: { id: 'design', filename: '01.md' } },
      { id: 'challenge', kind: 'agent', actor: 'adversary', action: 'adversarial-review', output: { id: 'challenge', filename: '02.md' } },
      { id: 'approve-design', kind: 'gate', artifact: 'design' },
      { id: 'specification', kind: 'agent', actor: 'launcher', action: 'specification', output: { id: 'specification', filename: '03.md' } },
      { id: 'review-specification', kind: 'agent', actor: 'adversary', action: 'spec-review', output: { id: 'review', filename: '04.md' } },
      { id: 'approve-specification', kind: 'gate', artifact: 'specification' },
    ],
    now: '2026-07-20T10:00:00.000Z',
  });
  const completed = initial.steps.map((step) => step.kind === 'agent'
    ? {
        ...step,
        status: 'complete' as const,
        output: {
          id: step.declaredOutput.id, path: `/tmp/docs/${step.declaredOutput.filename}`,
          format: 'markdown' as const, sha256: 'a'.repeat(64), completedAt: '2026-07-20T10:01:00.000Z',
        },
        attempts: [{
          number: 1, startedAt: '2026-07-20T10:00:00.000Z', inputArtifactHashes: {},
          completedAt: '2026-07-20T10:01:00.000Z', outputSha256: 'a'.repeat(64),
        }],
      }
    : { ...step, status: 'complete' as const, approval: { approvedArtifactHash: 'a'.repeat(64), approvedAt: '2026-07-20T10:01:00.000Z' } });
  let state: RunState = { ...initial, steps: completed };
  const store = {
    findState: () => state,
    save: (next: RunState) => { state = next; },
  };
  const events: unknown[] = [];
  const stale = new StaleInvalidationService(
    store as never,
    { append: (_runId: string, event: unknown) => events.push(event) } as never,
    {} as never,
    now,
  );
  const gates = new GateService(
    store as never,
    { acquire: () => () => undefined } as never,
    stale,
  );
  return {
    gates,
    stale,
    state: () => state,
    replace: (next: RunState) => { state = next; },
    events,
  };
}

describe('stale invalidation', () => {
  it('recursively stales completed downstream steps and preserves gate feedback', () => {
    const { gates, state } = createHarness();

    gates.requestChanges('run-stale', 'approve-design', 'Simplify the design.');

    expect(state().steps).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'design', status: 'pending', output: undefined }),
      expect.objectContaining({ id: 'challenge', status: 'stale' }),
      expect.objectContaining({ id: 'approve-design', status: 'pending', feedback: [expect.objectContaining({ comment: 'Simplify the design.' })] }),
      expect.objectContaining({ id: 'specification', status: 'stale' }),
      expect.objectContaining({ id: 'review-specification', status: 'stale' }),
      expect.objectContaining({ id: 'approve-specification', status: 'stale' }),
    ]));
  });

  it('allows retry only for stale agent work and preserves its previous attempt list', () => {
    const { gates, state } = createHarness();
    gates.requestChanges('run-stale', 'approve-design', 'Refresh the analysis.');

    gates.retry('run-stale', 'challenge');

    expect(state().steps[1]).toMatchObject({
      status: 'pending', output: undefined, attempts: [expect.objectContaining({ number: 1 })],
    });
    expect(() => gates.retry('run-stale', 'challenge')).toThrow('only be retried when stale or failed');
  });

  it('reopens a later stale gate after request-changes work has been rebuilt', () => {
    const { gates, stale, state, replace } = createHarness();
    gates.requestChanges('run-stale', 'approve-design', 'Rework the design.');
    replace({
      ...state(),
      steps: state().steps.map((step, index) => index < 5
        ? { ...step, status: 'complete' as const }
        : step),
    });

    const reopened = stale.reopenGateIfReady('run-stale', state(), 'approve-specification');

    expect(reopened?.steps[5]).toMatchObject({ id: 'approve-specification', status: 'pending' });
  });
});
