import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
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

  it('applyVerdictRetry reopens the target with reviewer feedback and counts the retry', () => {
    const { store } = createStore();
    const sha = 'b'.repeat(64);
    const at = '2026-07-21T10:00:00.000Z';
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
          output: { id: 'verification', path: '/tmp/docs/v.md', format: 'markdown', sha256: sha, completedAt: at },
          verdictPolicy: { changesRequested: { retryFrom: 'implement', maxIterations: 2 }, blocked: 'stop' },
          reviewOutcome: { verdict: 'CHANGES_REQUESTED', exhausted: false },
          attempts: [{ number: 1, startedAt: at, inputArtifactHashes: {}, completedAt: at, outputSha256: sha }],
        },
      ],
    });

    store.applyVerdictRetry('run-vr', 'verify', 'implement');

    const state = store.findState('run-vr');
    const implement = state?.steps.find((step) => step.id === 'implement');
    const verify = state?.steps.find((step) => step.id === 'verify');
    expect(implement?.status).toBe('pending');
    expect(implement?.kind === 'agent' ? implement.retryContext?.sourceStepId : undefined).toBe('verify');
    expect(implement?.kind === 'agent' ? implement.retryContext?.artifactPath : undefined).toBe('/tmp/docs/v.md');
    expect(verify?.status).toBe('pending');
    expect(verify?.kind === 'agent' ? verify.verdictRetries : undefined).toBe(1);
    expect(state?.currentStepId).toBeUndefined();
  });

  it.each(['../outside', '/tmp/outside', 'run/child', 'run\\child', '..'])(
    'rejects unsafe run id %s before resolving a run path',
    (runId) => {
      const { store } = createStore();

      expect(() => store.findState(runId)).toThrow('Invalid run ID');
    },
  );
});
