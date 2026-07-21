import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HomeDirectoryResolver } from '../src/config/home-directory.resolver';
import { EventLogService } from '../src/runs/event-log.service';
import { FileStateStore } from '../src/runs/file-state.store';
import { RunLockService } from '../src/runs/run-lock.service';
import { createRunState } from '../src/runs/run-state.schema';
import { WorkflowRunnerService } from '../src/workflows/workflow-runner.service';
import { StaleInvalidationService } from '../src/workflows/stale-invalidation.service';
import { ArtifactService } from '../src/documentation/artifact.service';
import { FilesystemDocumentationTarget } from '../src/documentation/filesystem-documentation.target';
import { PathRendererService } from '../src/documentation/path-renderer.service';

const directories: string[] = [];

function agent(id: string): NonNullable<Parameters<typeof createRunState>[0]['steps']>[number] {
  return {
    id,
    kind: 'agent',
    actor: 'launcher',
    action: 'feature-design',
    output: { id: `${id}-output`, filename: `01 - ${id}.md` },
  };
}

function gate(id: string, artifact: string): NonNullable<Parameters<typeof createRunState>[0]['steps']>[number] {
  return { id, kind: 'gate', artifact };
}

function createRunner(steps: Parameters<typeof createRunState>[0]['steps']) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'impresairio-schedule-')));
  directories.push(home);
  const resolver = new HomeDirectoryResolver({ IMPRESAIRIO_HOME: home });
  const store = new FileStateStore(resolver);
  const events = new EventLogService(resolver);
  const locks = new RunLockService(store, events, {
    hostname: 'local-machine', pid: 4242, isPidActive: () => false,
    now: () => new Date('2026-07-20T10:00:00.000Z'),
  });
  const artifactService = new ArtifactService(
    new PathRendererService(),
    new FilesystemDocumentationTarget(),
  );
  store.create(createRunState({
    id: 'run-workflow', workflowId: 'feature', workflowSha256: 'a'.repeat(64),
    roles: {},
    documentation: {
      target: { name: 'test', kind: 'filesystem', root: home, defaultFormat: 'markdown' },
      featurePath: 'Features/{{ feature.id }}',
      bindings: {
        project: { name: 'Test', slug: 'test' },
        feature: { id: 'TEST-1', slug: 'test-1' },
        run: { id: 'run-workflow' },
      },
    },
    steps,
    now: '2026-07-20T10:00:00.000Z',
  }));
  return {
    store,
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
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('WorkflowRunnerService', () => {
  it('starts only the first pending agent step in order', () => {
    const { runner, store } = createRunner([
      agent('design'),
      agent('challenge'),
    ]);

    expect(runner.next('run-workflow')).toEqual({ kind: 'agent', stepId: 'design' });
    expect(store.findState('run-workflow')?.steps).toEqual([
      expect.objectContaining({ id: 'design', status: 'in_progress' }),
      expect.objectContaining({ id: 'challenge', status: 'pending' }),
    ]);
    expect(runner.next('run-workflow')).toEqual({ kind: 'agent', stepId: 'design' });
  });

  it('skips completed work but stops at the first waiting human gate', () => {
    const { runner, store } = createRunner([
      agent('design'),
      gate('approve-design', 'design-output'),
      agent('specification'),
    ]);
    const state = store.findState('run-workflow');
    if (!state) throw new Error('missing test state');
    store.save({
      ...state,
      steps: state.steps.map((step) => step.id === 'design'
        ? { ...step, status: 'complete' as const }
        : step),
    });

    expect(runner.next('run-workflow')).toEqual({ kind: 'gate', stepId: 'approve-design' });
    expect(store.findState('run-workflow')?.steps[2]).toMatchObject({ status: 'pending' });
  });

  it('reports completion when every declared step is complete', () => {
    const { runner, store } = createRunner([agent('design')]);
    const state = store.findState('run-workflow');
    if (!state) throw new Error('missing test state');
    store.save({ ...state, steps: [{ ...state.steps[0], status: 'complete' }] });

    expect(runner.next('run-workflow')).toEqual({ kind: 'complete' });
  });
});

describe('verdict halts', () => {
  it('halts progression on an unresolved verdict until acknowledged', () => {
    const { runner, store } = createRunner([
      agent('implement'),
      { ...agent('verify'), verdictPolicy: { blocked: 'stop' } },
    ]);
    const at = '2026-07-20T10:02:00.000Z';
    const state = store.findState('run-workflow');
    if (!state) throw new Error('missing state');
    store.save({
      ...state,
      steps: state.steps.map((step) => step.kind === 'agent'
        ? {
            ...step,
            status: 'complete' as const,
            output: {
              id: step.declaredOutput.id, path: `/tmp/${step.id}.md`,
              format: 'markdown' as const, sha256: 'b'.repeat(64), completedAt: at,
            },
            ...(step.id === 'verify'
              ? { reviewOutcome: { verdict: 'BLOCKED' as const, exhausted: false } }
              : {}),
          }
        : step),
    });

    expect(runner.next('run-workflow')).toEqual({
      kind: 'blocked',
      stepId: 'verify',
      warnings: [expect.stringContaining('BLOCKED')],
    });

    const halted = store.findState('run-workflow');
    if (!halted) throw new Error('missing halted state');
    store.save({
      ...halted,
      steps: halted.steps.map((step) => step.id === 'verify' && step.kind === 'agent'
        ? { ...step, acknowledgment: { at, comment: 'verified locally outside the sandbox' } }
        : step),
    });

    expect(runner.next('run-workflow')).toEqual({ kind: 'complete' });
  });
});
