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
  it('recovers host handoffs and rejects non-artifact retry targets', () => {
    const harness = createHarness();
    const current = harness.state();
    const original = current.steps[0];
    if (original.kind !== 'agent') throw new Error('missing agent');
    const host = {
      ...original, kind: 'host-handoff' as const, status: 'failed' as const,
      promptFile: 'prompts/host.md', prompt: 'Review.', inputArtifactIds: [], sideEffects: 'none' as const,
      handoffPreparedAt: '2026-07-20T10:01:00.000Z',
    };
    harness.replace({ ...current, steps: [host, ...current.steps.slice(1)] } as RunState);
    harness.gates.retry('run-stale', 'design');
    expect(harness.state().steps[0]).toMatchObject({ kind: 'host-handoff', status: 'pending', handoffPreparedAt: undefined });
    expect(() => harness.gates.retry('run-stale', 'approve-design')).toThrow('not an agent or host handoff step');
  });

  it('returns a host producer to pending when its gate requests changes', () => {
    const harness = createHarness();
    const current = harness.state();
    const original = current.steps[0];
    if (original.kind !== 'agent') throw new Error('missing agent');
    harness.replace({
      ...current,
      steps: [{ ...original, kind: 'host-handoff' as const, promptFile: 'host.md', prompt: 'Review.', inputArtifactIds: [], sideEffects: 'none' as const }, ...current.steps.slice(1)],
    } as RunState);
    harness.gates.requestChanges('run-stale', 'approve-design', 'Revise host output.');
    expect(harness.state().steps[0]).toMatchObject({ kind: 'host-handoff', status: 'pending', handoffPreparedAt: undefined });
  });

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
    expect(() => gates.retry('run-stale', 'challenge')).toThrow('only be retried when stale, failed or halted on a verdict');
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

describe('verdict halt recovery', () => {
  function withHaltedVerify(harness: ReturnType<typeof createHarness>) {
    const current = harness.state();
    harness.replace({
      ...current,
      steps: current.steps.map((step) => step.id === 'review-specification' && step.kind === 'agent'
        ? {
            ...step,
            verdictPolicy: { blocked: 'stop' as const },
            reviewOutcome: { verdict: 'BLOCKED' as const, exhausted: false },
          }
        : step),
    });
  }

  it('acknowledge records the audited comment and event on a halted step', () => {
    const harness = createHarness();
    withHaltedVerify(harness);

    harness.gates.acknowledge('run-stale', 'review-specification', 'verified locally outside the sandbox');

    const step = harness.state().steps.find((candidate) => candidate.id === 'review-specification');
    expect(step?.kind === 'agent' ? step.acknowledgment?.comment : undefined)
      .toBe('verified locally outside the sandbox');
    expect(harness.events).toContainEqual(expect.objectContaining({
      type: 'verdict.acknowledged', stepId: 'review-specification',
    }));
  });

  it('acknowledge rejects a step without an unacknowledged halted verdict', () => {
    const harness = createHarness();

    expect(() => harness.gates.acknowledge('run-stale', 'review-specification', 'nothing to acknowledge'))
      .toThrow('has no unacknowledged halted verdict');
  });

  it('retry accepts a complete verdict-halted step and clears its verdict fields', () => {
    const harness = createHarness();
    withHaltedVerify(harness);

    harness.gates.retry('run-stale', 'review-specification');

    const step = harness.state().steps.find((candidate) => candidate.id === 'review-specification');
    expect(step?.status).toBe('pending');
    expect(step?.kind === 'agent' ? step.reviewOutcome : undefined).toBeUndefined();
    expect(step?.kind === 'agent' ? step.acknowledgment : undefined).toBeUndefined();
  });

  it('retry still rejects a plain complete step', () => {
    const harness = createHarness();

    expect(() => harness.gates.retry('run-stale', 'review-specification'))
      .toThrow('can only be retried when stale, failed or halted on a verdict');
  });
});
