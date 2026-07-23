import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HomeDirectoryResolver } from '../src/config/home-directory.resolver';
import {
  FileStateStore,
  RunStateError,
  type StateFileOperations,
} from '../src/runs/file-state.store';
import { createRunState } from '../src/runs/run-state.schema';

const temporaryDirectories: string[] = [];
const documentation = {
  target: {
    name: 'test', kind: 'filesystem' as const, root: '/tmp/docs', defaultFormat: 'markdown' as const,
  },
  featurePath: 'Features/{{ feature.id }}',
  bindings: {
    project: { name: 'Test', slug: 'test' },
    feature: { id: 'TEST-1', slug: 'test-1' },
    run: { id: 'run-test' },
  },
};

function createStore(fileOperations?: Partial<StateFileOperations>): {
  readonly home: string;
  readonly store: FileStateStore;
} {
  const home = mkdtempSync(join(tmpdir(), 'impresairio-state-'));
  temporaryDirectories.push(home);
  return {
    home,
    store: new FileStateStore(
      new HomeDirectoryResolver({ IMPRESAIRIO_HOME: home }),
      fileOperations,
    ),
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('FileStateStore', () => {
  it('records only artifact-producing steps and preserves agent patch metadata on completion', () => {
    const { store } = createStore();
    const at = '2026-07-20T10:00:00.000Z';
    const state = createRunState({ id: 'run-completion-state', workflowId: 'feature', workflowSha256: 'a'.repeat(64), roles: {}, documentation,
      steps: [
        { id: 'work', kind: 'agent', actor: 'launcher', action: 'implementation', output: { id: 'work', filename: 'work.md' } },
        { id: 'gate', kind: 'gate', artifact: 'work' },
      ], now: at });
    store.create({ ...state, currentStepId: 'work', steps: state.steps.map((step) => step.kind === 'agent'
      ? { ...step, status: 'in_progress' as const, attempts: [{ number: 1, startedAt: at, inputArtifactHashes: {} }] }
      : step) });
    store.recordCompletion('run-completion-state', { stepId: 'work', output: { id: 'work', path: '/tmp/docs/work.md', format: 'markdown', sha256: 'b'.repeat(64) }, appliedPatch: { sha256: 'c'.repeat(64), paths: ['src/a.ts'], appliedAt: at } });
    expect(store.findState('run-completion-state')?.steps[0]).toMatchObject({ appliedPatch: { paths: ['src/a.ts'] } });
    expect(() => store.recordCompletion('run-completion-state', { stepId: 'gate', output: { id: 'work', path: '/tmp/docs/work.md', format: 'markdown', sha256: 'b'.repeat(64) } })).toThrow('cannot produce an artifact');
    store.markFailed('run-completion-state', 'work', 'failed');
    expect(store.findState('run-completion-state')?.steps[0]).toMatchObject({ status: 'complete' });
  });

  it('marks an in-progress agent failure without applying host-only state fields', () => {
    const { store } = createStore();
    const at = '2026-07-20T10:00:00.000Z';
    const state = createRunState({ id: 'run-agent-failure', workflowId: 'feature', workflowSha256: 'a'.repeat(64), roles: {}, documentation,
      steps: [{ id: 'work', kind: 'agent', actor: 'launcher', action: 'implementation', output: { id: 'work', filename: 'work.md' } }], now: at });
    store.create({ ...state, currentStepId: 'work', steps: state.steps.map((step) => step.kind === 'agent'
      ? { ...step, status: 'in_progress' as const, attempts: [{ number: 1, startedAt: at, inputArtifactHashes: {} }] }
      : step) });
    store.markFailed('run-agent-failure', 'work', 'failed');
    expect(store.findState('run-agent-failure')?.steps[0]).toMatchObject({ status: 'failed' });
  });

  it('marks an in-progress host handoff failure without agent dispatch state', () => {
    const { store } = createStore();
    const at = '2026-07-20T10:00:00.000Z';
    const state = createRunState({ id: 'run-host-failure', workflowId: 'feature', workflowSha256: 'a'.repeat(64), roles: {}, documentation,
      steps: [{ id: 'host', kind: 'host-handoff', promptFile: 'host.md', prompt: 'Review.', inputs: [], sideEffects: 'none', output: { id: 'review', filename: 'review.md' } }], now: at });
    store.create({ ...state, currentStepId: 'host', steps: state.steps.map((step) => step.kind === 'host-handoff'
      ? { ...step, status: 'in_progress' as const, attempts: [{ number: 1, startedAt: at, inputArtifactHashes: {} }] }
      : step) });
    store.markFailed('run-host-failure', 'host', 'failed');
    expect(store.findState('run-host-failure')?.steps[0]).toMatchObject({ status: 'failed' });
  });
  it('round-trips a validated run state', () => {
    const { store } = createStore();
    const state = createRunState({
      id: 'run-20260720-001',
      workflowId: 'feature',
      workflowSha256: 'a'.repeat(64),
      roles: { launcher: 'claude', adversary: 'codex', implementer: 'opencode-glm' },
      documentation,
      steps: [],
      now: '2026-07-20T10:00:00.000Z',
    });

    store.create(state);

    expect(store.findState(state.id)).toEqual(state);
  });

  it('round-trips frozen capability methods and free actor ids', () => {
    const { store } = createStore();
    const state = createRunState({
      id: 'run-capability-methods',
      workflowId: 'feature',
      workflowSha256: 'a'.repeat(64),
      roles: { 'product-author': 'claude', skeptic: 'codex' },
      documentation,
      steps: [
        {
          id: 'model',
          kind: 'agent',
          actor: 'product-author',
          method: { capability: 'threat-model', skill: 'local:threat-model' },
          output: { id: 'threat-model', filename: 'threat-model.md' },
        },
        {
          id: 'review',
          kind: 'agent',
          actor: 'skeptic',
          method: { capability: 'threat-review', promptSource: 'global', content: 'Challenge it.' },
          output: { id: 'threat-review', filename: 'threat-review.md' },
        },
      ],
      now: '2026-07-21T10:00:00.000Z',
    });

    store.create(state);

    expect(store.findState(state.id)).toEqual(state);
  });

  it('rejects malformed persisted state', () => {
    const { home, store } = createStore();
    const statePath = join(home, 'runs', 'broken', 'state.json');
    store.fileOperations.mkdirSync(join(home, 'runs', 'broken'), { recursive: true });
    store.fileOperations.writeFileSync(statePath, '{"version": 999}', 'utf8');

    expect(() => store.findState('broken')).toThrow(RunStateError);
  });

  it('cleans its temporary file when replacing state fails', () => {
    const { home } = createStore();
    const operations: Partial<StateFileOperations> = {
      renameSync: () => {
        throw new Error('simulated replacement failure');
      },
    };
    const store = new FileStateStore(
      new HomeDirectoryResolver({ IMPRESAIRIO_HOME: home }),
      operations,
    );
    const state = createRunState({
      id: 'run-failure',
      workflowId: 'feature',
      workflowSha256: 'a'.repeat(64),
      roles: { launcher: 'claude' },
      documentation,
      steps: [],
      now: '2026-07-20T10:00:00.000Z',
    });

    expect(() => store.create(state)).toThrow('simulated replacement failure');
    expect(readdirSync(join(home, 'runs', state.id))).toEqual([]);
  });

  it('preserves reviewer feedback before reopening the target and counts the retry', () => {
    const { home, store } = createStore();
    const at = '2026-07-21T10:00:00.000Z';
    const content = 'Clarify the output contract.\n\nVERDICT: CHANGES_REQUESTED\n';
    const sha = createHash('sha256').update(content).digest('hex');
    const reviewerPath = join(home, 'runs', 'run-vr', 'artifacts', '.review.md');
    store.create({
      version: 1,
      id: 'run-vr',
      workflow: { id: 'verdicted', sha256: sha, successors: { implement: ['verify'], verify: [] } },
      roles: {},
      resolvedActors: {},
      execution: { agentTimeoutSeconds: 1_800 },
      documentation: { ...documentation, bindings: { ...documentation.bindings, run: { id: 'run-vr' } } },
      currentStepId: 'verify',
      createdAt: at,
      updatedAt: at,
      steps: [
        {
          id: 'implement', kind: 'agent', status: 'complete', actor: 'implementer',
          method: { action: 'implement' },
          declaredOutput: { id: 'implementation-report', filename: 'i.md', storage: 'documentation' },
          output: { id: 'implementation-report', path: '/tmp/docs/i.md', format: 'markdown', sha256: sha, completedAt: at },
          attempts: [{ number: 1, startedAt: at, inputArtifactHashes: {}, completedAt: at, outputSha256: sha }],
        },
        {
          id: 'verify', kind: 'agent', status: 'complete', actor: 'adversary',
          method: { action: 'verification' },
          declaredOutput: { id: 'verification', filename: 'v.md', storage: 'documentation' },
          output: { id: 'verification', path: reviewerPath, format: 'markdown', sha256: sha, completedAt: at },
          verdictPolicy: { changesRequested: { retryFrom: 'implement', maxIterations: 2 }, blocked: 'stop' },
          reviewOutcome: { verdict: 'CHANGES_REQUESTED', exhausted: false },
          attempts: [{ number: 1, startedAt: at, inputArtifactHashes: {}, completedAt: at, outputSha256: sha }],
        },
      ],
    });

    store.fileOperations.mkdirSync(join(home, 'runs', 'run-vr', 'artifacts'), { recursive: true });
    writeFileSync(reviewerPath, content, 'utf8');
    const retryFeedback = store.preserveRetryFeedback('run-vr', 'verify', { path: reviewerPath, sha256: sha });
    store.applyVerdictRetry('run-vr', 'verify', 'implement', retryFeedback);

    const state = store.findState('run-vr');
    const implement = state?.steps.find((step) => step.id === 'implement');
    const verify = state?.steps.find((step) => step.id === 'verify');
    expect(implement?.status).toBe('pending');
    expect(implement?.kind === 'agent' ? implement.retryContext?.sourceStepId : undefined).toBe('verify');
    expect(implement?.kind === 'agent' ? implement.retryContext?.artifactPath : undefined).toBe(retryFeedback.artifactPath);
    expect(readFileSync(retryFeedback.artifactPath, 'utf8')).toBe(content);
    expect(verify?.status).toBe('pending');
    expect(verify?.kind === 'agent' ? verify.verdictRetries : undefined).toBe(1);
    expect(state?.currentStepId).toBeUndefined();
  });

  it('rejects a missing verdict step or a changed verdict artifact when preserving retry feedback', () => {
    const { home, store } = createStore();
    const at = '2026-07-21T10:00:00.000Z';
    const content = 'VERDICT: CHANGES_REQUESTED\n';
    const sha = createHash('sha256').update(content).digest('hex');
    const reviewerPath = join(home, 'review.md');
    store.create(createRunState({
      id: 'run-retry-integrity', workflowId: 'feature', workflowSha256: 'a'.repeat(64), roles: {},
      documentation, steps: [{ id: 'review', kind: 'agent', actor: 'adversary', action: 'verification', output: { id: 'review', filename: 'Review.md' } }], now: at,
    }));
    writeFileSync(reviewerPath, content, 'utf8');

    expect(() => store.preserveRetryFeedback('run-retry-integrity', 'missing', { path: reviewerPath, sha256: sha })).toThrow('not an agent verdict step');
    expect(() => store.preserveRetryFeedback('run-retry-integrity', 'review', { path: reviewerPath, sha256: 'b'.repeat(64) })).toThrow('changed before retry feedback was preserved');
  });

  it('rejects retry feedback that changes while its durable copy is being saved', () => {
    const content = 'VERDICT: CHANGES_REQUESTED\n';
    const sha = createHash('sha256').update(content).digest('hex');
    const { home, store } = createStore({
      readFileSync: ((path: Parameters<typeof readFileSync>[0], options: Parameters<typeof readFileSync>[1]) => (
        String(path).includes('retry-feedback') ? 'tampered feedback\n' : readFileSync(path, options)
      )) as typeof readFileSync,
    });
    const reviewerPath = join(home, 'review.md');
    store.create(createRunState({
      id: 'run-retry-copy-integrity', workflowId: 'feature', workflowSha256: 'a'.repeat(64), roles: {}, documentation,
      steps: [{ id: 'review', kind: 'agent', actor: 'adversary', action: 'verification', output: { id: 'review', filename: 'Review.md' } }],
      now: '2026-07-21T10:00:00.000Z',
    }));
    writeFileSync(reviewerPath, content, 'utf8');

    expect(() => store.preserveRetryFeedback('run-retry-copy-integrity', 'review', { path: reviewerPath, sha256: sha }))
      .toThrow('Preserved retry feedback for step review changed while it was being saved');
  });

  it.each(['../outside', '/tmp/outside', 'run/child', 'run\\child', '..'])(
    'rejects unsafe run id %s before resolving a run path',
    (runId) => {
      const { store } = createStore();

      expect(() => store.findState(runId)).toThrow('Invalid run ID');
    },
  );
});
