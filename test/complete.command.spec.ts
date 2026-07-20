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
