import { describe, expect, it } from 'vitest';
import { CompleteCommand } from '../src/commands/complete.command';
import {
  CompletionError,
  CompletionService,
  type CompletionRunStore,
} from '../src/runs/completion.service';
import { RunBusyError } from '../src/runs/run-lock.service';

function createStore(step: {
  readonly id: string;
  readonly kind: 'agent' | 'gate';
  readonly status: 'pending' | 'in_progress' | 'complete' | 'stale';
}): CompletionRunStore & {
  readonly events: unknown[];
  readonly completions: unknown[];
} {
  const events: unknown[] = [];
  const completions: unknown[] = [];
  return {
    events,
    completions,
    find(runId) {
      return { id: runId, currentStepId: step.id, steps: [step] };
    },
    recordCompletion(_runId, completion) {
      completions.push(completion);
    },
    appendEvent(_runId, event) {
      events.push(event);
    },
  };
}

describe('CompleteCommand', () => {
  it('records verified output metadata and an event for the current agent step', async () => {
    const store = createStore({ id: 'design', kind: 'agent', status: 'in_progress' });
    const artifactService = {
      completeExpectedOutput: () => ({
        id: 'design', path: '/docs/01 - Design.md', format: 'markdown' as const,
        sha256: 'a'.repeat(64),
      }),
    };
    const command = new CompleteCommand(new CompletionService(store, artifactService));

    await command.run(['run-42', 'design']);

    expect(store.completions).toEqual([{ stepId: 'design', output: artifactService.completeExpectedOutput() }]);
    expect(store.events).toEqual([expect.objectContaining({ type: 'step.completed', stepId: 'design' })]);
  });

  it('applies a declared patch after publishing its Markdown output', () => {
    const patch = {
      sha256: 'b'.repeat(64), paths: ['src/greet.ts'], appliedAt: '2026-07-21T12:00:00.000Z',
    };
    const repositoryPatch = { baselineSha256: 'c'.repeat(64), currentSha256: 'd'.repeat(64) };
    const store = createStore({ id: 'implement', kind: 'agent', status: 'in_progress' });
    const service = new CompletionService(
      {
        ...store,
        find: (runId) => ({
          id: runId,
          repositoryDirectory: '/repository',
          currentStepId: 'implement',
          steps: [{ id: 'implement', kind: 'agent', status: 'in_progress', patch: 'apply-unified-diff' }],
        }),
      },
      {
        completeExpectedOutput: () => ({
          id: 'implementation', path: '/docs/implementation.md', format: 'markdown' as const, sha256: 'a'.repeat(64),
        }),
        readExpectedOutput: () => '# Implementation\n\n```impresairio-patch\ndiff --git a/src/greet.ts b/src/greet.ts\n```\n',
      },
      undefined,
      undefined,
      undefined,
      { apply: () => ({ patch, repositoryPatch }) },
    );

    service.complete('run-42', 'implement');

    expect(store.completions).toContainEqual(expect.objectContaining({
      stepId: 'implement', appliedPatch: patch, repositoryPatch,
    }));
    expect(store.events).toContainEqual(expect.objectContaining({
      type: 'step.patch.applied', stepId: 'implement', sha256: patch.sha256, paths: patch.paths,
    }));
  });

  it.each([
    ['pending', 'must be in progress'],
    ['complete', 'is already complete'],
    ['stale', 'is stale'],
  ] as const)('rejects a %s step', async (status, message) => {
    const store = createStore({ id: 'design', kind: 'agent', status });
    const command = new CompleteCommand(new CompletionService(store, {
      completeExpectedOutput: () => { throw new Error('must not verify output'); },
    }));

    await expect(command.run(['run-42', 'design'])).rejects.toThrow(message);
  });

  it('rejects a gate or a step that is not current', async () => {
    const artifactService = { completeExpectedOutput: () => { throw new Error('must not verify output'); } };
    const gateCommand = new CompleteCommand(new CompletionService(
      createStore({ id: 'approve-design', kind: 'gate', status: 'in_progress' }), artifactService,
    ));
    await expect(gateCommand.run(['run-42', 'approve-design'])).rejects.toThrow('is a gate');

    const service = new CompletionService({
      ...createStore({ id: 'design', kind: 'agent', status: 'in_progress' }),
      find: () => ({ id: 'run-42', currentStepId: 'other', steps: [{ id: 'design', kind: 'agent', status: 'in_progress' }] }),
    }, artifactService);
    expect(() => service.complete('run-42', 'design')).toThrow('is not the current step');
  });

  it('surfaces missing output failures without recording a completion', async () => {
    const store = createStore({ id: 'design', kind: 'agent', status: 'in_progress' });
    const command = new CompleteCommand(new CompletionService(store, {
      completeExpectedOutput: () => { throw new Error('Expected output does not exist'); },
    }));

    await expect(command.run(['run-42', 'design'])).rejects.toThrow('Expected output does not exist');
    expect(store.completions).toEqual([]);
  });

  it('uses a stable domain error for an unknown run', async () => {
    const service = new CompletionService({
      find: () => undefined,
      recordCompletion: () => undefined,
      appendEvent: () => undefined,
    }, {
      completeExpectedOutput: () => ({
        id: 'design',
        path: '/docs/design.md',
        format: 'markdown',
        sha256: 'a'.repeat(64),
      }),
    });

    expect(() => service.complete('missing', 'design')).toThrow(CompletionError);
  });

  it('applies a policy retry-from transition and records the verdict event', () => {
    const store = createStore({ id: 'verify', kind: 'agent', status: 'in_progress' });
    const retries: unknown[] = [];
    const artifactService = {
      completeExpectedOutput: () => ({
        id: 'verification', path: '/docs/v.md', format: 'markdown' as const, sha256: 'a'.repeat(64),
      }),
    };
    const service = new CompletionService(
      { ...store, applyVerdictRetry: (...call: unknown[]) => { retries.push(call); } },
      artifactService,
      undefined,
      undefined,
      { evaluate: () => ({
        skipStepIds: [], source: 'policy',
        reviewOutcome: { verdict: 'CHANGES_REQUESTED', exhausted: false },
        transition: { kind: 'retry-from', targetStepId: 'implement' },
      }) },
    );

    service.complete('run-42', 'verify');

    expect(retries).toEqual([['run-42', 'verify', 'implement']]);
    expect(store.events).toContainEqual(expect.objectContaining({
      type: 'verdict.changes_requested', stepId: 'verify', retryFrom: 'implement',
    }));
  });

  it('discards a retried internal artifact before reopening its target', () => {
    const store = {
      ...createStore({ id: 'verify', kind: 'agent', status: 'in_progress' }),
      find: (runId: string) => ({
        id: runId,
        currentStepId: 'verify',
        successors: { implement: ['verify'], verify: ['implement'] },
        steps: [
          {
            id: 'verify', kind: 'agent' as const, status: 'in_progress' as const,
            storage: 'internal' as const,
            output: {
              id: 'verification', targetRoot: '/run', directory: '/run/artifacts',
              path: '/run/artifacts/verification.md', format: 'markdown' as const,
            },
          },
          {
            id: 'implement', kind: 'agent' as const, status: 'complete' as const,
            storage: 'internal' as const,
            output: {
              id: 'implementation', targetRoot: '/run', directory: '/run/artifacts',
              path: '/run/artifacts/implementation.md', format: 'markdown' as const,
            },
          },
        ],
      }),
    };
    const discarded: string[] = [];
    const service = new CompletionService(
      store,
      {
        completeExpectedOutput: () => ({
          id: 'verification', path: '/docs/v.md', format: 'markdown' as const, sha256: 'a'.repeat(64),
        }),
        discardExpectedOutput: (step) => discarded.push(step.output?.path ?? ''),
      },
      undefined,
      undefined,
      { evaluate: () => ({
        skipStepIds: [], source: 'policy',
        reviewOutcome: { verdict: 'CHANGES_REQUESTED', exhausted: false },
        transition: { kind: 'retry-from', targetStepId: 'implement' },
      }) },
    );

    service.complete('run-42', 'verify');

    expect(discarded).toEqual(['/run/artifacts/verification.md', '/run/artifacts/implementation.md']);
  });

  it.each([
    ['BLOCKED', false, 'verdict.blocked'],
    ['CHANGES_REQUESTED', true, 'verdict.exhausted'],
  ] as const)('records %s halts as %s events', (verdict, exhausted, eventType) => {
    const store = createStore({ id: 'verify', kind: 'agent', status: 'in_progress' });
    const service = new CompletionService(
      store,
      { completeExpectedOutput: () => ({
        id: 'verification', path: '/docs/v.md', format: 'markdown' as const, sha256: 'a'.repeat(64),
      }) },
      undefined,
      undefined,
      { evaluate: () => ({
        skipStepIds: [], source: 'policy',
        reviewOutcome: { verdict, exhausted },
        transition: { kind: 'halt' },
      }) },
    );

    service.complete('run-42', 'verify');

    expect(store.events).toContainEqual(expect.objectContaining({ type: eventType, stepId: 'verify' }));
  });

  it('does not emit verdict events for cycle-sourced outcomes', () => {
    const store = createStore({ id: 'design-review-1', kind: 'agent', status: 'in_progress' });
    const service = new CompletionService(
      store,
      { completeExpectedOutput: () => ({
        id: 'design-review-1', path: '/docs/r.md', format: 'markdown' as const, sha256: 'a'.repeat(64),
      }) },
      undefined,
      undefined,
      { evaluate: () => ({
        skipStepIds: [], source: 'cycle',
        reviewOutcome: { verdict: 'APPROVED', exhausted: false },
        transition: { kind: 'continue' },
      }) },
    );

    service.complete('run-42', 'design-review-1');

    expect(store.events.filter((event) => String((event as { type: string }).type).startsWith('verdict.'))).toEqual([]);
  });

  it('refuses a concurrent completion before reading, verifying or mutating the run', async () => {
    const store = createStore({ id: 'design', kind: 'agent', status: 'in_progress' });
    const verifier = { completeExpectedOutput: () => { throw new Error('must not verify output'); } };
    const service = new CompletionService(
      store,
      verifier,
      undefined,
      { acquire: () => { throw new RunBusyError('run-42'); } },
    );

    await expect(new CompleteCommand(service).run(['run-42', 'design']))
      .rejects.toThrow('run busy: run-42');
    expect(store.completions).toEqual([]);
    expect(store.events).toEqual([]);
  });
});
