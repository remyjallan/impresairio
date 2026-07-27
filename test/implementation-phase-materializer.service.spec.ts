import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ImplementationPhaseMaterializerService } from '../src/workflows/implementation-phase-materializer.service';
import type { RunState } from '../src/runs/run-state.schema';

const temporaryDirectories: string[] = [];
const hash = 'a'.repeat(64);

function phaseArtifact(): string {
  const directory = mkdtempSync(join(tmpdir(), 'impresairio-phases-'));
  temporaryDirectories.push(directory);
  const path = join(directory, 'plan.md');
  writeFileSync(path, `# Plan\n\n\`\`\`impresairio-phase-manifest\n${JSON.stringify({ phases: [{
    id: 'storage', objective: 'Add storage.', scope: ['state'], dependsOn: [],
    verification: ['Run storage tests.'], retryBudget: 1, gate: true,
  }] })}\n\`\`\`\n`, 'utf8');
  return path;
}

function state(path: string, approved = true): RunState {
  return {
    id: 'run-phases', updatedAt: '2026-07-27T00:00:00.000Z',
    workflow: { id: 'phases', sha256: hash, successors: {} },
    roles: {}, resolvedActors: {}, documentation: {} as RunState['documentation'],
    execution: { agentTimeoutSeconds: 60 }, createdAt: '2026-07-27T00:00:00.000Z',
    steps: [
      {
        id: 'plan', kind: 'agent', status: 'complete', actor: 'launcher', method: { action: 'plan' },
        executionAuthorization: 'explicit', declaredOutput: { id: 'plan', filename: 'plan.md', storage: 'internal' },
        output: { id: 'plan', path, format: 'markdown', sha256: hash, completedAt: '2026-07-27T00:00:00.000Z' }, attempts: [],
      },
      {
        id: 'approve-plan', kind: 'gate', status: 'complete', artifact: 'plan', feedback: [],
        ...(approved ? { approval: { approvedArtifactHash: hash, approvedAt: '2026-07-27T00:00:00.000Z' } } : {}),
      },
      { id: 'phases', kind: 'phase-manifest', status: 'pending', artifact: 'plan', actor: 'implementer', method: { action: 'implement' }, reviewer: 'adversary', reviewMethod: { action: 'verify' } },
      { id: 'report', kind: 'gate', status: 'pending', artifact: 'plan', feedback: [] },
    ],
  } as RunState;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('ImplementationPhaseMaterializerService', () => {
  it('freezes a bounded serial implementation, review and gate sequence after approval', () => {
    let saved: RunState | undefined;
    const events: unknown[] = [];
    const service = new ImplementationPhaseMaterializerService(
      { findState: () => state(phaseArtifact()), save: (value: RunState) => { saved = value; } } as never,
      { append: (_runId: string, event: unknown) => events.push(event) } as never,
    );

    const result = service.materialize('run-phases', 'phases', '2026-07-27T01:00:00.000Z');

    expect(result.steps.map((step) => step.id)).toEqual([
      'plan', 'approve-plan', 'phases', 'phases--storage', 'phases--storage--review', 'phases--storage--approve', 'report',
    ]);
    expect(result.steps[2]).toMatchObject({ status: 'complete', manifestSha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(result.steps[3]).toMatchObject({ patch: 'apply-unified-diff', phase: { id: 'storage' } });
    expect(result.steps[5]).toMatchObject({ artifact: 'phases--storage--review' });
    expect(saved).toBe(result);
    expect(events).toEqual([expect.objectContaining({ type: 'phase-manifest.materialized', generatedStepIds: expect.any(Array) })]);
  });

  it('rejects unavailable, unapproved, non-placeholder and malformed sources without saving', () => {
    const saved: RunState[] = [];
    const store = { findState: () => undefined, save: (value: RunState) => saved.push(value) } as never;
    const events = { append: () => undefined } as never;
    const service = new ImplementationPhaseMaterializerService(store, events);
    expect(() => service.materialize('missing', 'phases')).toThrow('Run not found');

    const unapproved = state(phaseArtifact(), false);
    (store as { findState: () => RunState | undefined }).findState = () => unapproved;
    expect(() => service.materialize('run-phases', 'phases')).toThrow('must be approved');
    expect(() => service.materialize('run-phases', 'plan')).toThrow('not an implementation phase placeholder');
    expect(saved).toEqual([]);
  });
});
