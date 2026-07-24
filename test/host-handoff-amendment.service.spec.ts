import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ArtifactService } from '../src/documentation/artifact.service';
import { FilesystemDocumentationTarget } from '../src/documentation/filesystem-documentation.target';
import { PathRendererService } from '../src/documentation/path-renderer.service';
import { EventLogService } from '../src/runs/event-log.service';
import { FileStateStore } from '../src/runs/file-state.store';
import { HostHandoffAmendmentService } from '../src/runs/host-handoff-amendment.service';
import { RunLockService } from '../src/runs/run-lock.service';
import { createRunState } from '../src/runs/run-state.schema';
import { HomeDirectoryResolver } from '../src/config/home-directory.resolver';

const directories: string[] = [];

function createHarness() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'impresairio-amend-host-')));
  directories.push(home);
  const resolver = new HomeDirectoryResolver({ IMPRESAIRIO_HOME: home });
  const store = new FileStateStore(resolver);
  const events = new EventLogService(resolver);
  const locks = new RunLockService(store, events, {
    hostname: 'local', pid: 4242, isPidActive: () => false,
    now: () => new Date('2026-07-24T09:00:00.000Z'),
  });
  const artifacts = new ArtifactService(new PathRendererService(), new FilesystemDocumentationTarget());
  const state = createRunState({
    id: 'run-amend', workflowId: 'host', workflowSha256: 'a'.repeat(64), roles: {},
    documentation: {
      target: { name: 'test', kind: 'filesystem', root: home, defaultFormat: 'markdown' },
      featurePath: 'Features/{{ feature.id }}',
      bindings: { project: { name: 'Test', slug: 'test' }, feature: { id: 'AMD-1', slug: 'amend' }, run: { id: 'run-amend' } },
    },
    steps: [
      {
        id: 'brainstorm', kind: 'host-handoff', promptFile: 'prompts/brainstorm.md', prompt: 'Draft the specification.',
        inputs: [], output: { id: 'brainstorm', filename: 'Brainstorm.md', storage: 'internal' }, sideEffects: 'none',
      },
      {
        id: 'review', kind: 'agent', actor: 'adversary', action: 'adversarial-review',
        output: { id: 'review', filename: 'Review.md', storage: 'internal' },
      },
      { id: 'approve', kind: 'gate', artifact: 'brainstorm' },
    ],
    now: '2026-07-24T09:00:00.000Z',
  });
  store.create(state);
  const current = store.findState('run-amend');
  if (!current) throw new Error('missing run');
  const brainstorm = current.steps[0];
  if (brainstorm.kind !== 'host-handoff') throw new Error('missing host handoff');
  const expectedOutput = artifacts.prepareInternalOutput(store.runDirectory('run-amend'), brainstorm.declaredOutput);
  artifacts.publishMarkdown(expectedOutput, '# Brainstorm\n\nOriginal specification.\n');
  const output = artifacts.completeOutput(expectedOutput);
  const review = current.steps[1];
  if (review.kind !== 'agent') throw new Error('missing review');
  const expectedReview = artifacts.prepareInternalOutput(store.runDirectory('run-amend'), review.declaredOutput);
  store.save({
    ...current,
    currentStepId: 'review',
    steps: [
      {
        ...brainstorm, status: 'complete', expectedOutput,
        output: { ...output, completedAt: '2026-07-24T09:01:00.000Z' },
        attempts: [{ number: 1, startedAt: '2026-07-24T09:00:00.000Z', inputArtifactHashes: {}, completedAt: '2026-07-24T09:01:00.000Z', outputSha256: output.sha256 }],
      },
      {
        ...review, status: 'in_progress', expectedOutput: expectedReview, dispatchPreparedAt: '2026-07-24T09:02:00.000Z',
        attempts: [{ number: 1, startedAt: '2026-07-24T09:02:00.000Z', inputArtifactHashes: { brainstorm: output.sha256 } }],
      },
      current.steps[2],
    ],
    updatedAt: '2026-07-24T09:02:00.000Z',
  });
  const amendments = new HostHandoffAmendmentService(
    store, artifacts, events, locks, () => new Date('2026-07-24T09:03:00.000Z'),
  );
  return { store, events, locks, artifacts, amendments, expectedOutput };
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('HostHandoffAmendmentService', () => {
  it('reopens a completed host handoff and a merely prepared downstream review', () => {
    const { store, events, amendments, expectedOutput } = createHarness();

    amendments.amend('run-amend', 'brainstorm', 'Add the gate default decision before review.');

    const state = store.findState('run-amend');
    const brainstorm = state?.steps[0];
    const review = state?.steps[1];
    expect(state?.currentStepId).toBeUndefined();
    expect(brainstorm).toMatchObject({ kind: 'host-handoff', status: 'pending' });
    expect(review).toMatchObject({ kind: 'agent', status: 'pending' });
    expect(brainstorm).not.toHaveProperty('output');
    expect(brainstorm).not.toHaveProperty('expectedOutput');
    expect(review).not.toHaveProperty('output');
    expect(review).not.toHaveProperty('expectedOutput');
    expect(review).not.toHaveProperty('dispatchPreparedAt');
    if (!brainstorm || brainstorm.kind !== 'host-handoff') throw new Error('missing amended host handoff');
    expect(brainstorm.amendments).toHaveLength(1);
    expect(readFileSync(brainstorm.amendments?.[0].priorOutput.archivedPath ?? '', 'utf8')).toContain('Original specification.');
    expect(() => readFileSync(expectedOutput.path, 'utf8')).toThrow();
    expect(events.read('run-amend')).toContainEqual(expect.objectContaining({
      type: 'host.handoff.amended', stepId: 'brainstorm', revision: 1,
    }));
  });

  it('refuses amendment after a dependent provider execution starts', () => {
    const { store, events, amendments } = createHarness();
    events.append('run-amend', { type: 'agent.execution.started', at: '2026-07-24T09:02:30.000Z', stepId: 'review' });

    expect(() => amendments.amend('run-amend', 'brainstorm', 'Correct the specification.'))
      .toThrow('dependent agent step review already began provider execution');
    expect(store.findState('run-amend')?.steps[0]).toMatchObject({ status: 'complete' });
  });

  it('rejects an unknown or incomplete host handoff without changing the run', () => {
    const { store, amendments } = createHarness();
    expect(() => amendments.amend('run-amend', 'missing', 'Correct it.')).toThrow('not a host handoff');
    const state = store.findState('run-amend');
    if (!state) throw new Error('missing run');
    store.save({ ...state, steps: state.steps.map((step) => step.id === 'brainstorm' && step.kind === 'host-handoff'
      ? { ...step, status: 'pending' as const }
      : step) });
    expect(() => amendments.amend('run-amend', 'brainstorm', 'Correct it.')).toThrow('must be complete');
  });

  it('refuses a completed downstream artifact and an applied downstream patch', () => {
    const { store, amendments } = createHarness();
    const state = store.findState('run-amend');
    if (!state) throw new Error('missing run');
    store.save({ ...state, steps: state.steps.map((step) => step.id === 'review' && step.kind === 'agent'
      ? { ...step, status: 'complete' as const }
      : step) });
    expect(() => amendments.amend('run-amend', 'brainstorm', 'Correct it.')).toThrow('already completed');

    const completed = store.findState('run-amend');
    if (!completed) throw new Error('missing completed run');
    store.save({ ...completed, steps: completed.steps.map((step) => step.id === 'review' && step.kind === 'agent'
      ? { ...step, status: 'in_progress' as const, appliedPatch: { sha256: 'b'.repeat(64), paths: ['src/index.ts'], appliedAt: '2026-07-24T09:03:00.000Z' } }
      : step) });
    expect(() => amendments.amend('run-amend', 'brainstorm', 'Correct it.')).toThrow('already applied a patch');
  });

  it('refuses an inconsistent downstream state that has already published an artifact', () => {
    const { store, amendments } = createHarness();
    const state = store.findState('run-amend');
    if (!state) throw new Error('missing run');
    store.save({
      ...state,
      steps: state.steps.map((step) => step.id === 'review' && step.kind === 'agent'
        ? {
            ...step,
            output: {
              id: 'review', path: '/tmp/review.md', format: 'markdown' as const,
              sha256: 'b'.repeat(64), completedAt: '2026-07-24T09:02:30.000Z',
            },
          }
        : step),
    });

    expect(() => amendments.amend('run-amend', 'brainstorm', 'Correct it.'))
      .toThrow('dependent step review already published an artifact');
  });

  it('refuses an incomplete persisted successor graph before changing the run', () => {
    const { store, amendments } = createHarness();
    const state = store.findState('run-amend');
    if (!state) throw new Error('missing run');
    store.save({ ...state, workflow: { ...state.workflow, successors: { brainstorm: [] } } });

    expect(() => amendments.amend('run-amend', 'brainstorm', 'Correct it.'))
      .toThrow('workflow successor graph is missing step review');
    expect(store.findState('run-amend')?.steps[0]).toMatchObject({ status: 'complete' });
  });

  it('refuses an amendment when the frozen graph omits its source step', () => {
    const { store, amendments } = createHarness();
    const state = store.findState('run-amend');
    if (!state) throw new Error('missing run');
    store.save({ ...state, workflow: { ...state.workflow, successors: { review: [], approve: [] } } });

    expect(() => amendments.amend('run-amend', 'brainstorm', 'Correct it.'))
      .toThrow('workflow successor graph is missing source step brainstorm');
  });

  it('refuses a separately invoked amendment while advance holds the run lock', () => {
    const { store, events, locks, artifacts } = createHarness();
    const release = locks.acquireReentrant('run-amend', 'advance');
    const separateProcessLocks = new RunLockService(store, events, {
      hostname: 'local', pid: 9999, isPidActive: () => true,
    });
    const amendments = new HostHandoffAmendmentService(
      store, artifacts, events, separateProcessLocks, () => new Date('2026-07-24T09:03:00.000Z'),
    );

    expect(() => amendments.amend('run-amend', 'brainstorm', 'Correct it.')).toThrow('run busy: run-amend');

    release();
  });

  it('returns a merely prepared downstream host handoff to pending', () => {
    const { store, amendments } = createHarness();
    const state = store.findState('run-amend');
    if (!state) throw new Error('missing run');
    const preparedReview = state.steps[1];
    if (preparedReview.kind !== 'agent') throw new Error('missing review');
    store.save({
      ...state,
      steps: state.steps.map((step) => step.id === 'review'
        ? {
            id: 'review', kind: 'host-handoff' as const, status: 'in_progress' as const,
            promptFile: 'prompts/review.md', prompt: 'Review the brainstorm.', inputArtifactIds: [],
            declaredOutput: preparedReview.declaredOutput, sideEffects: 'none' as const,
            expectedOutput: preparedReview.expectedOutput, handoffPreparedAt: '2026-07-24T09:02:00.000Z',
            attempts: preparedReview.attempts,
          }
        : step),
    });

    amendments.amend('run-amend', 'brainstorm', 'Correct the scope.');

    expect(store.findState('run-amend')?.steps[1]).toMatchObject({ kind: 'host-handoff', status: 'pending' });
  });

  it('reports the amendment limit before archiving another revision', () => {
    const { store, amendments } = createHarness();
    const state = store.findState('run-amend');
    const brainstorm = state?.steps[0];
    if (!state || !brainstorm || brainstorm.kind !== 'host-handoff' || !brainstorm.output) throw new Error('missing host handoff');
    store.save({
      ...state,
      steps: state.steps.map((step) => step.id === 'brainstorm' && step.kind === 'host-handoff'
        ? {
            ...step,
            amendments: Array.from({ length: 20 }, (_value, index) => ({
              revision: index + 1, amendedAt: '2026-07-24T09:02:00.000Z', reason: 'Earlier correction.',
              priorOutput: {
                path: brainstorm.output!.path,
                sha256: brainstorm.output!.sha256,
                completedAt: brainstorm.output!.completedAt,
                archivedPath: join(store.runDirectory('run-amend'), `revision-${index + 1}.md`),
              },
            })),
          }
        : step),
    });

    expect(() => amendments.amend('run-amend', 'brainstorm', 'One more correction.')).toThrow('maximum of 20 amendments');
  });
});
