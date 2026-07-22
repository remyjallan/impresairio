import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HomeDirectoryResolver } from '../src/config/home-directory.resolver';
import { ArtifactService } from '../src/documentation/artifact.service';
import { FilesystemDocumentationTarget } from '../src/documentation/filesystem-documentation.target';
import { PathRendererService } from '../src/documentation/path-renderer.service';
import { EventLogService } from '../src/runs/event-log.service';
import { CompletionService } from '../src/runs/completion.service';
import { FileStateStore } from '../src/runs/file-state.store';
import { RunLockService } from '../src/runs/run-lock.service';
import { createRunState } from '../src/runs/run-state.schema';
import { GateService } from '../src/workflows/gate.service';
import { ApprovalIntegrityError, StaleInvalidationService } from '../src/workflows/stale-invalidation.service';
import { WorkflowRunnerService } from '../src/workflows/workflow-runner.service';

const temporaryDirectories: string[] = [];
const clock = () => new Date('2026-07-20T10:10:00.000Z');

function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function createHarness() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'impresairio-gates-home-')));
  const docs = realpathSync(mkdtempSync(join(tmpdir(), 'impresairio-gates-docs-')));
  temporaryDirectories.push(home, docs);
  const resolver = new HomeDirectoryResolver({ IMPRESAIRIO_HOME: home });
  const store = new FileStateStore(resolver);
  const events = new EventLogService(resolver);
  const locks = new RunLockService(store, events, {
    hostname: 'test-host', pid: 4242, isPidActive: () => false, now: clock,
  });
  const artifacts = new ArtifactService(new PathRendererService(), new FilesystemDocumentationTarget());
  const stale = new StaleInvalidationService(store, events, artifacts, clock);
  const gates = new GateService(store, locks, stale);
  const runner = new WorkflowRunnerService(store, events, locks, artifacts, stale, clock);
  const completion = new CompletionService(store, artifacts, clock, locks);
  const output = (id: string, filename: string) => ({
    id,
    targetRoot: docs,
    directory: docs,
    path: join(docs, filename),
    format: 'markdown' as const,
  });
  const outputs = {
    design: output('design', '01 - Design.md'),
    challenge: output('challenge', '02 - Challenge.md'),
    specification: output('specification', '03 - Specification.md'),
    review: output('review', '04 - Review.md'),
  };
  const seed = (completed: readonly (keyof typeof outputs)[] = ['design', 'challenge']) => {
    const content: Record<keyof typeof outputs, string> = {
      design: '# Design\noriginal\n', challenge: '# Challenge\noriginal\n',
      specification: '# Specification\noriginal\n', review: '# Review\noriginal\n',
    };
    for (const [id, item] of Object.entries(outputs) as [keyof typeof outputs, typeof outputs[keyof typeof outputs]][]) {
      if (completed.includes(id)) writeFileSync(item.path, content[id], 'utf8');
    }
    const initial = createRunState({
      id: 'run-gates', workflowId: 'feature', workflowSha256: 'a'.repeat(64), roles: {},
      documentation: {
        target: { name: 'test', kind: 'filesystem', root: docs, defaultFormat: 'markdown' },
        featurePath: 'unused',
        bindings: {
          project: { name: 'Test', slug: 'test' }, feature: { id: 'TEST-1', slug: 'test-1' },
          run: { id: 'run-gates' },
        },
      },
      steps: [
        { id: 'design', kind: 'agent', actor: 'launcher', action: 'feature-design', output: { id: 'design', filename: '01 - Design.md' } },
        { id: 'challenge', kind: 'agent', actor: 'adversary', action: 'adversarial-review', output: { id: 'challenge', filename: '02 - Challenge.md' } },
        { id: 'approve-design', kind: 'gate', artifact: 'design' },
        { id: 'specification', kind: 'agent', actor: 'launcher', action: 'specification', output: { id: 'specification', filename: '03 - Specification.md' } },
        { id: 'review-specification', kind: 'agent', actor: 'adversary', action: 'spec-review', output: { id: 'review', filename: '04 - Review.md' } },
        { id: 'approve-specification', kind: 'gate', artifact: 'specification' },
      ],
      now: '2026-07-20T10:00:00.000Z',
    });
    const state = {
      ...initial,
      steps: initial.steps.map((step) => {
        if (step.kind !== 'agent') return step;
        const item = outputs[step.declaredOutput.id as keyof typeof outputs];
        if (!completed.includes(step.declaredOutput.id as keyof typeof outputs)) return step;
        return {
          ...step,
          status: 'complete' as const,
          expectedOutput: item,
          output: { id: item.id, path: item.path, format: 'markdown' as const, sha256: sha256(content[step.declaredOutput.id as keyof typeof outputs]), completedAt: '2026-07-20T10:01:00.000Z' },
          inputArtifactHashes: step.id === 'challenge' ? { design: sha256(content.design) } : {},
          attempts: [{ number: 1, startedAt: '2026-07-20T10:00:00.000Z', inputArtifactHashes: {}, completedAt: '2026-07-20T10:01:00.000Z', outputSha256: sha256(content[step.declaredOutput.id as keyof typeof outputs]) }],
        };
      }),
    };
    store.create(state);
    return { content, state };
  };
  return { docs, store, events, gates, runner, completion, outputs, seed };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('approval integrity', () => {
  it('records an immutable approval hash and optional comment on the gate', () => {
    const { gates, store, seed } = createHarness();
    seed();

    gates.approve('run-gates', 'approve-design', 'ready for specification');

    expect(store.findState('run-gates')?.steps[2]).toMatchObject({
      status: 'complete',
      approval: { approvedArtifactHash: sha256('# Design\noriginal\n'), comment: 'ready for specification' },
    });
  });

  it('detects a manually modified approved artifact before next and stales its producer', () => {
    const { gates, runner, store, outputs, seed } = createHarness();
    seed();
    gates.approve('run-gates', 'approve-design');
    writeFileSync(outputs.design.path, '# Design\nchanged outside Impresairio\n', 'utf8');

    expect(() => runner.next('run-gates')).toThrow(ApprovalIntegrityError);
    expect(store.findState('run-gates')?.steps).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'design', status: 'stale' }),
      expect.objectContaining({ id: 'approve-design', status: 'stale' }),
    ]));
  });

  it('reopens a stale gate after its invalidated prerequisite agents are retried and completed', () => {
    const { gates, runner, completion, store, outputs, seed } = createHarness();
    seed();
    gates.approve('run-gates', 'approve-design');
    writeFileSync(outputs.design.path, '# Design\nrevised outside Impresairio\n', 'utf8');
    expect(() => runner.next('run-gates')).toThrow(ApprovalIntegrityError);

    gates.retry('run-gates', 'design');
    expect(runner.next('run-gates')).toEqual({ kind: 'agent', stepId: 'design' });
    const designOutput = store.findState('run-gates')?.steps[0];
    if (!designOutput || designOutput.kind !== 'agent' || !designOutput.expectedOutput) throw new Error('missing design output');
    writeFileSync(designOutput.expectedOutput.path, '# Design\nrevised outside Impresairio\n', 'utf8');
    completion.complete('run-gates', 'design');
    gates.retry('run-gates', 'challenge');
    expect(runner.next('run-gates')).toEqual({ kind: 'agent', stepId: 'challenge' });
    const challengeOutput = store.findState('run-gates')?.steps[1];
    if (!challengeOutput || challengeOutput.kind !== 'agent' || !challengeOutput.expectedOutput) throw new Error('missing challenge output');
    writeFileSync(challengeOutput.expectedOutput.path, '# Challenge\nreviewed revised design\n', 'utf8');
    completion.complete('run-gates', 'challenge');

    expect(runner.next('run-gates')).toEqual({ kind: 'gate', stepId: 'approve-design' });
    expect(store.findState('run-gates')?.steps[2]).toMatchObject({ status: 'pending' });
    expect(() => gates.approve('run-gates', 'approve-design')).not.toThrow();
  });

  it('stales a completed challenge when the design changed after its input snapshot', () => {
    const { gates, store, outputs, seed } = createHarness();
    seed();
    writeFileSync(outputs.design.path, '# Design\nrevised by human\n', 'utf8');

    expect(() => gates.approve('run-gates', 'approve-design')).toThrow(ApprovalIntegrityError);
    expect(store.findState('run-gates')?.steps[1]).toMatchObject({ id: 'challenge', status: 'stale' });
    expect(store.findState('run-gates')?.steps[2]).toMatchObject({ id: 'approve-design', status: 'pending' });
  });

  it('hashes and discards internal gate artifacts in the run directory', () => {
    const { gates, store, seed, docs } = createHarness();
    const seeded = seed();
    const internalRoot = join(docs, 'run-artifacts');
    const internalOutput = {
      id: 'design', targetRoot: internalRoot, directory: internalRoot,
      path: join(internalRoot, 'design.md'), format: 'markdown' as const,
    };
    mkdirSync(internalRoot, { recursive: true });
    writeFileSync(internalOutput.path, seeded.content.design, 'utf8');
    store.save({
      ...seeded.state,
      steps: seeded.state.steps.map((step) => step.id === 'design' && step.kind === 'agent'
        ? {
            ...step,
            declaredOutput: { ...step.declaredOutput, storage: 'internal' as const },
            expectedOutput: internalOutput,
            output: { ...step.output!, path: internalOutput.path },
          }
        : step),
    });

    expect(() => gates.approve('run-gates', 'approve-design')).not.toThrow();
    expect(store.findState('run-gates')?.steps[2]).toMatchObject({
      status: 'complete', approval: { approvedArtifactHash: sha256(seeded.content.design) },
    });

    gates.requestChanges('run-gates', 'approve-design', 'Rework the internal artifact.');
    expect(() => realpathSync(internalOutput.path)).toThrow();
  });

  it('uses the documentation root for legacy outputs without frozen target metadata', () => {
    const { gates, store, seed } = createHarness();
    const seeded = seed();
    const current = store.findState('run-gates');
    if (!current) throw new Error('missing seeded state');
    store.save({
      ...current,
      steps: current.steps.map((step) => step.id === 'design' && step.kind === 'agent'
        ? { ...step, expectedOutput: undefined }
        : step),
    });

    expect(() => gates.approve('run-gates', 'approve-design')).not.toThrow();
    expect(store.findState('run-gates')?.steps[2]).toMatchObject({
      status: 'complete', approval: { approvedArtifactHash: sha256(seeded.content.design) },
    });
  });
});
