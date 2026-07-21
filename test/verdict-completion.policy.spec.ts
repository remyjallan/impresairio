import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { VerdictCompletionPolicy } from '../src/workflows/verdict-completion.policy';
import type { RunState } from '../src/runs/run-state.schema';

const sha = 'a'.repeat(64);

function stateWithVerify(overrides: Partial<Record<string, unknown>>): RunState {
  return {
    version: 1, id: 'run-policy', workflow: { id: 'wf', sha256: sha, successors: { implement: ['verify'], verify: [] } },
    roles: {}, resolvedActors: {}, execution: { agentTimeoutSeconds: 1800 },
    documentation: {
      target: { name: 'docs', kind: 'filesystem', root: '/tmp/docs', defaultFormat: 'markdown' },
      featurePath: 'x', bindings: { project: { name: 'P', slug: 'p' }, feature: { id: 'F', slug: 'f' }, run: { id: 'run-policy' } },
    },
    createdAt: '2026-07-21T10:00:00.000Z', updatedAt: '2026-07-21T10:00:00.000Z',
    steps: [
      { id: 'implement', kind: 'agent', status: 'complete', actor: 'implementer', method: { action: 'implement' },
        declaredOutput: { id: 'implementation-report', filename: 'i.md', storage: 'documentation' }, attempts: [] },
      { id: 'verify', kind: 'agent', status: 'in_progress', actor: 'adversary', method: { action: 'verification' },
        declaredOutput: { id: 'verification', filename: 'v.md', storage: 'documentation' }, attempts: [],
        verdictPolicy: { changesRequested: { retryFrom: 'implement', maxIterations: 2 }, blocked: 'stop' },
        ...overrides },
    ],
  } as RunState;
}

function artifact(content: string): { id: string; path: string; format: 'markdown'; sha256: string } {
  const directory = mkdtempSync(join(tmpdir(), 'impresairio-verdict-'));
  const path = join(directory, 'v.md');
  writeFileSync(path, content, 'utf8');
  return { id: 'verification', path, format: 'markdown', sha256: sha };
}

function policyFor(state: RunState): VerdictCompletionPolicy {
  return new VerdictCompletionPolicy({ findState: () => state } as never);
}

describe('VerdictCompletionPolicy on policy-bearing steps', () => {
  it('continues on APPROVED', () => {
    const output = artifact('done\n\nVERDICT: APPROVED\n');
    const result = policyFor(stateWithVerify({})).evaluate('run-policy', 'verify', output);
    expect(result).toMatchObject({
      source: 'policy',
      transition: { kind: 'continue' },
      reviewOutcome: { verdict: 'APPROVED', exhausted: false },
    });
  });

  it('retries from the configured step while budget remains', () => {
    const output = artifact('gaps\n\nVERDICT: CHANGES_REQUESTED\n');
    const result = policyFor(stateWithVerify({ verdictRetries: 1 })).evaluate('run-policy', 'verify', output);
    expect(result.transition).toEqual({ kind: 'retry-from', targetStepId: 'implement' });
    expect(result.reviewOutcome).toEqual({ verdict: 'CHANGES_REQUESTED', exhausted: false });
  });

  it('halts as exhausted when the budget is spent', () => {
    const output = artifact('still bad\n\nVERDICT: CHANGES_REQUESTED\n');
    const result = policyFor(stateWithVerify({ verdictRetries: 2 })).evaluate('run-policy', 'verify', output);
    expect(result).toMatchObject({
      transition: { kind: 'halt' },
      reviewOutcome: { verdict: 'CHANGES_REQUESTED', exhausted: true },
    });
  });

  it('halts on CHANGES_REQUESTED when no changesRequested block is declared', () => {
    const output = artifact('bad\n\nVERDICT: CHANGES_REQUESTED\n');
    const result = policyFor(stateWithVerify({ verdictPolicy: { blocked: 'stop' } })).evaluate('run-policy', 'verify', output);
    expect(result).toMatchObject({
      transition: { kind: 'halt' },
      reviewOutcome: { verdict: 'CHANGES_REQUESTED', exhausted: true },
    });
  });

  it('halts on BLOCKED', () => {
    const output = artifact('sandbox denied\n\nVERDICT: BLOCKED\n');
    const result = policyFor(stateWithVerify({})).evaluate('run-policy', 'verify', output);
    expect(result).toMatchObject({
      transition: { kind: 'halt' },
      reviewOutcome: { verdict: 'BLOCKED', exhausted: false },
    });
  });

  it('throws when the artifact does not end with a verdict', () => {
    const output = artifact('no verdict here\n');
    expect(() => policyFor(stateWithVerify({})).evaluate('run-policy', 'verify', output))
      .toThrow(/must end with VERDICT/);
  });

  it('ignores steps without a policy or cycle role', () => {
    const output = artifact('anything\n');
    const state = stateWithVerify({ verdictPolicy: undefined });
    expect(policyFor(state).evaluate('run-policy', 'verify', output)).toEqual({ skipStepIds: [] });
  });
});
