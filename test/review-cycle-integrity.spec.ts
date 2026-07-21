import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HomeDirectoryResolver } from '../src/config/home-directory.resolver';
import { ArtifactService } from '../src/documentation/artifact.service';
import { FilesystemDocumentationTarget } from '../src/documentation/filesystem-documentation.target';
import { PathRendererService } from '../src/documentation/path-renderer.service';
import { CompletionService } from '../src/runs/completion.service';
import { EventLogService } from '../src/runs/event-log.service';
import { FileStateStore } from '../src/runs/file-state.store';
import { RunLockService } from '../src/runs/run-lock.service';
import { createRunState } from '../src/runs/run-state.schema';
import { ApprovalIntegrityError, StaleInvalidationService } from '../src/workflows/stale-invalidation.service';
import { GateService } from '../src/workflows/gate.service';
import { WorkflowRunnerService } from '../src/workflows/workflow-runner.service';
import { ReviewCycleCompletionPolicy } from '../src/workflows/review-cycle-completion.policy';
import { StatusCommand } from '../src/commands/status.command';

const directories: string[] = [];
const now = () => new Date('2026-07-21T10:00:00.000Z');

function harness() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'impresairio-cycle-home-')));
  const docs = realpathSync(mkdtempSync(join(tmpdir(), 'impresairio-cycle-docs-')));
  directories.push(home, docs);
  const resolver = new HomeDirectoryResolver({ IMPRESAIRIO_HOME: home });
  const store = new FileStateStore(resolver);
  const events = new EventLogService(resolver);
  const locks = new RunLockService(store, events, { hostname: 'test', pid: 42, isPidActive: () => false, now });
  const artifacts = new ArtifactService(new PathRendererService(), new FilesystemDocumentationTarget());
  const stale = new StaleInvalidationService(store, events, artifacts, now);
  const runner = new WorkflowRunnerService(store, events, locks, artifacts, stale, now);
  const completion = new CompletionService(store, artifacts, now, locks, new ReviewCycleCompletionPolicy(store));
  const gates = new GateService(store, locks, stale);
  store.create(createRunState({
    id: 'run-cycle', workflowId: 'feature', workflowSha256: 'a'.repeat(64), roles: {},
    documentation: {
      target: { name: 'docs', kind: 'filesystem', root: docs, defaultFormat: 'markdown' },
      featurePath: 'Feature',
      bindings: {
        project: { name: 'Test', slug: 'test' }, feature: { id: 'TEST-1', slug: 'cycle' }, run: { id: 'run-cycle' },
      },
    },
    steps: [
      { id: 'design', kind: 'agent', actor: 'launcher', action: 'feature-design', output: { id: 'design', filename: '01.md' } },
      { id: 'design-review-1', kind: 'agent', actor: 'adversary', action: 'adversarial-review', output: { id: 'design-review-1', filename: '.review-1.md', storage: 'internal' }, cycle: { id: 'design', role: 'review', iteration: 1 } },
      { id: 'design-consolidate-1', kind: 'agent', actor: 'launcher', action: 'feature-design', output: { id: 'design', filename: '01.md' }, cycle: { id: 'design', role: 'consolidate', iteration: 1 } },
      { id: 'design-review-2', kind: 'agent', actor: 'adversary', action: 'adversarial-review', output: { id: 'design-review-2', filename: '.review-2.md', storage: 'internal' }, cycle: { id: 'design', role: 'review', iteration: 2 } },
      { id: 'approve-design', kind: 'gate', artifact: 'design' },
    ],
    now: now().toISOString(),
  }));

  const complete = (stepId: string, content: string) => {
    expect(runner.next('run-cycle')).toEqual({ kind: 'agent', stepId });
    const step = store.findState('run-cycle')?.steps.find((candidate) => candidate.id === stepId);
    if (!step || step.kind !== 'agent' || !step.expectedOutput) throw new Error('missing output');
    writeFileSync(step.expectedOutput.path, content, 'utf8');
    completion.complete('run-cycle', stepId);
    return step.expectedOutput.path;
  };
  return { store, events, runner, gates, complete };
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('review cycle integrity', () => {
  it('uses only the final verdict instead of an earlier mention', () => {
    const { store, complete } = harness();
    complete('design', '# Design\n');
    complete('design-review-1', '# Review\nExample: VERDICT: APPROVED\n\nVERDICT: CHANGES_REQUESTED\n');

    expect(store.findState('run-cycle')?.steps).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'design-consolidate-1', status: 'pending' }),
      expect.objectContaining({ id: 'design-review-2', status: 'pending' }),
    ]));
  });

  it('marks unused cycle work skipped and rejects an artifact edited after its real review', () => {
    const { store, runner, gates, complete } = harness();
    const designPath = complete('design', '# Design\nreviewed version\n');
    complete('design-review-1', '# Review\n\nVERDICT: APPROVED\n');

    expect(store.findState('run-cycle')?.steps).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'design-consolidate-1', status: 'skipped' }),
      expect.objectContaining({ id: 'design-review-2', status: 'skipped' }),
    ]));
    expect(runner.next('run-cycle')).toEqual({ kind: 'gate', stepId: 'approve-design' });
    writeFileSync(designPath, '# Design\nchanged after review\n', 'utf8');

    expect(() => gates.approve('run-cycle', 'approve-design')).toThrow(ApprovalIntegrityError);
    expect(store.findState('run-cycle')?.steps.find((step) => step.id === 'design-review-1')).toMatchObject({ status: 'stale' });
  });

  it('marks an invalid review failed so it can be retried', () => {
    const { store, runner, gates, complete } = harness();
    complete('design', '# Design\n');
    expect(runner.next('run-cycle')).toEqual({ kind: 'agent', stepId: 'design-review-1' });
    const review = store.findState('run-cycle')?.steps.find((step) => step.id === 'design-review-1');
    if (!review || review.kind !== 'agent' || !review.expectedOutput) throw new Error('missing review');
    writeFileSync(review.expectedOutput.path, '# Review without verdict\n', 'utf8');
    expect(() => new CompletionService(
      store,
      new ArtifactService(new PathRendererService(), new FilesystemDocumentationTarget()),
      now,
      { acquire: () => () => undefined },
      new ReviewCycleCompletionPolicy(store),
    ).complete('run-cycle', 'design-review-1')).toThrow('must end with VERDICT');
    expect(store.findState('run-cycle')?.steps.find((step) => step.id === 'design-review-1')).toMatchObject({ status: 'failed' });

    expect(() => gates.retry('run-cycle', 'design-review-1')).not.toThrow();
    expect(existsSync(review.expectedOutput.path)).toBe(false);
    expect(store.findState('run-cycle')?.steps.find((step) => step.id === 'design-review-1')).toMatchObject({ status: 'pending' });
  });

  it('surfaces a final changes-requested verdict when the cycle budget is exhausted', async () => {
    const { store, events, runner, gates, complete } = harness();
    complete('design', '# Design\n');
    complete('design-review-1', '# Review one\n\nVERDICT: CHANGES_REQUESTED\n');
    complete('design-consolidate-1', '# Revised design\n');
    complete('design-review-2', '# Final review\n\nVERDICT: CHANGES_REQUESTED\n');

    expect(store.findState('run-cycle')?.steps.find((step) => step.id === 'design-review-2'))
      .toMatchObject({ reviewOutcome: { verdict: 'CHANGES_REQUESTED', exhausted: true } });
    expect(events.read('run-cycle')).toContainEqual(expect.objectContaining({
      type: 'cycle.exhausted', cycleId: 'design', iteration: 2, stepId: 'design-review-2',
    }));
    expect(runner.next('run-cycle')).toEqual({
      kind: 'gate', stepId: 'approve-design',
      warnings: [expect.stringContaining('human decision required')],
    });

    const output: string[] = [];
    await new StatusCommand(store, (line) => output.push(line)).run(['run-cycle']);
    expect(output.join('')).toContain('warning: cycle design exhausted at iteration 2');

    gates.approve('run-cycle', 'approve-design');
    const approvedOutput: string[] = [];
    await new StatusCommand(store, (line) => approvedOutput.push(line)).run(['run-cycle']);
    expect(approvedOutput.join('')).not.toContain('warning: cycle design exhausted');
  });

  it('surfaces a blocked verdict until the human resolves the gate', async () => {
    const { store, events, runner, gates, complete } = harness();
    complete('design', '# Design\n');
    complete('design-review-1', '# Blocking issue\n\nVERDICT: BLOCKED\n');

    expect(store.findState('run-cycle')?.steps).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'design-review-1', status: 'complete',
        reviewOutcome: { verdict: 'BLOCKED', exhausted: false },
      }),
      expect.objectContaining({ id: 'design-consolidate-1', status: 'skipped' }),
      expect.objectContaining({ id: 'design-review-2', status: 'skipped' }),
    ]));
    expect(events.read('run-cycle')).toContainEqual(expect.objectContaining({
      type: 'cycle.blocked', cycleId: 'design', iteration: 1,
      stepId: 'design-review-1', verdict: 'BLOCKED',
    }));
    expect(runner.next('run-cycle')).toEqual({
      kind: 'gate', stepId: 'approve-design',
      warnings: [expect.stringContaining('blocked at iteration 1 with VERDICT: BLOCKED')],
    });

    const output: string[] = [];
    await new StatusCommand(store, (line) => output.push(line)).run(['run-cycle']);
    expect(output.join('')).toContain('warning: cycle design blocked at iteration 1');

    gates.approve('run-cycle', 'approve-design');
    const approvedOutput: string[] = [];
    await new StatusCommand(store, (line) => approvedOutput.push(line)).run(['run-cycle']);
    expect(approvedOutput.join('')).not.toContain('warning: cycle design blocked');
  });
});
