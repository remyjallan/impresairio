import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ImplementationPhaseMaterializerService } from '../src/workflows/implementation-phase-materializer.service';
import { createRunState, runStepSchema, type RunState } from '../src/runs/run-state.schema';

const temporaryDirectories: string[] = [];
const hash = 'a'.repeat(64);

function phaseArtifact(
  overrides: Partial<{ retryBudget: number; gate: boolean }> = {},
  additionalPhases: readonly Record<string, unknown>[] = [],
): string {
  const directory = mkdtempSync(join(tmpdir(), 'impresairio-phases-'));
  temporaryDirectories.push(directory);
  const path = join(directory, 'plan.md');
  writeFileSync(path, `# Plan\n\n\`\`\`impresairio-phase-manifest\n${JSON.stringify({ phases: [{
    id: 'storage', objective: 'Add storage.', scope: ['state'], dependsOn: [],
    verification: ['Run storage tests.'], retryBudget: 1, gate: true, ...overrides,
  }, ...additionalPhases] })}\n\`\`\`\n`, 'utf8');
  return path;
}

function state(path: string, approved = true): RunState {
  const artifactHash = createHash('sha256').update(readFileSync(path, 'utf8')).digest('hex');
  return {
    id: 'run-phases', updatedAt: '2026-07-27T00:00:00.000Z',
    workflow: { id: 'phases', sha256: hash, successors: {} },
    roles: {}, resolvedActors: {}, documentation: {} as RunState['documentation'],
    execution: { agentTimeoutSeconds: 60 }, createdAt: '2026-07-27T00:00:00.000Z',
    steps: [
      {
        id: 'plan', kind: 'agent', status: 'complete', actor: 'launcher', method: { action: 'plan' },
        executionAuthorization: 'explicit', declaredOutput: { id: 'plan', filename: 'plan.md', storage: 'internal' },
        output: { id: 'plan', path, format: 'markdown', sha256: artifactHash, completedAt: '2026-07-27T00:00:00.000Z' }, attempts: [],
      },
      {
        id: 'approve-plan', kind: 'gate', status: 'complete', artifact: 'plan', feedback: [],
        ...(approved ? { approval: { approvedArtifactHash: artifactHash, approvedAt: '2026-07-27T00:00:00.000Z' } } : {}),
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

  it('inserts materialized phases without flattening existing successor edges', () => {
    const source = state(phaseArtifact());
    const branched = {
      ...source,
      workflow: {
        ...source.workflow,
        successors: {
          plan: ['approve-plan', 'audit'],
          'approve-plan': ['phases'],
          phases: ['report'],
          audit: ['report'],
          report: [],
        },
      },
      steps: [...source.steps.slice(0, 3), {
        id: 'audit', kind: 'gate' as const, status: 'pending' as const, artifact: 'plan', feedback: [],
      }, source.steps[3]],
    } as RunState;
    const service = new ImplementationPhaseMaterializerService(
      { findState: () => branched, save: () => undefined } as never,
      { append: () => undefined } as never,
    );

    const result = service.materialize('run-phases', 'phases');

    expect(result.workflow.successors).toMatchObject({
      plan: ['approve-plan', 'audit'],
      'approve-plan': ['phases'],
      phases: ['phases--storage'],
      'phases--storage': ['phases--storage--review'],
      'phases--storage--review': ['phases--storage--approve'],
      'phases--storage--approve': ['report'],
      audit: ['report'],
    });
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

  it('rejects an in-progress placeholder and unavailable sources', () => {
    const saved: RunState[] = [];
    const source = state(phaseArtifact());
    const store = { findState: () => source, save: (value: RunState) => saved.push(value) } as never;
    const service = new ImplementationPhaseMaterializerService(store, { append: () => undefined } as never);
    const inProgress = { ...source, steps: source.steps.map((step) => step.id === 'phases' ? { ...step, status: 'in_progress' as const } : step) } as RunState;
    (store as { findState: () => RunState }).findState = () => inProgress;
    expect(() => service.materialize('run-phases', 'phases')).toThrow('is in_progress');
    const unavailable = { ...source, steps: source.steps.map((step) => step.id === 'plan' ? { ...step, output: undefined } : step) } as RunState;
    (store as { findState: () => RunState }).findState = () => unavailable;
    expect(() => service.materialize('run-phases', 'phases')).toThrow('is unavailable');
    const missing = { ...source, steps: source.steps.map((step) => step.id === 'plan' && step.kind === 'agent'
      ? { ...step, output: { ...step.output!, path: '/missing-plan.md' } }
      : step) } as RunState;
    (store as { findState: () => RunState }).findState = () => missing;
    expect(() => service.materialize('run-phases', 'phases')).toThrow('cannot be read');
    expect(saved).toEqual([]);
  });

  it('accepts only a complete placeholder whose frozen generated sequence is still present', () => {
    const source = state(phaseArtifact());
    const complete = {
      ...source,
      steps: source.steps.map((step) => step.id === 'phases' && step.kind === 'phase-manifest'
        ? { ...step, status: 'complete' as const, manifestSha256: source.steps[0].kind === 'agent' ? source.steps[0].output!.sha256 : hash, materializedAt: '2026-07-27T01:00:00.000Z', generatedStepIds: ['generated'] }
        : step).concat([{
        id: 'generated', kind: 'gate' as const, status: 'pending' as const, artifact: 'plan', feedback: [],
      }]),
    } as RunState;
    const store = { findState: () => complete, save: () => undefined } as never;
    const service = new ImplementationPhaseMaterializerService(store, { append: () => undefined } as never);
    expect(service.materialize('run-phases', 'phases')).toBe(complete);
    const broken = { ...complete, steps: complete.steps.filter((step) => step.id !== 'generated') } as RunState;
    (store as { findState: () => RunState }).findState = () => broken;
    expect(() => service.materialize('run-phases', 'phases')).toThrow('inconsistent generated sequence');
  });

  it('rejects a manifest whose approval or file content no longer matches the published artifact', () => {
    const approved = state(phaseArtifact());
    const store = { findState: () => approved, save: () => undefined } as never;
    const service = new ImplementationPhaseMaterializerService(store, { append: () => undefined } as never);
    const mismatchedApproval = {
      ...approved,
      steps: approved.steps.map((step) => step.id === 'approve-plan'
        ? { ...step, approval: { approvedArtifactHash: hash, approvedAt: '2026-07-27T00:00:00.000Z' } }
        : step),
    } as RunState;
    (store as { findState: () => RunState }).findState = () => mismatchedApproval;
    expect(() => service.materialize('run-phases', 'phases')).toThrow('has changed');

    const tampered = state(phaseArtifact());
    const plan = tampered.steps.find((step) => step.id === 'plan');
    if (!plan || plan.kind !== 'agent' || !plan.output) throw new Error('missing plan output');
    writeFileSync(plan.output.path, '# tampered', 'utf8');
    (store as { findState: () => RunState }).findState = () => tampered;
    expect(() => service.materialize('run-phases', 'phases')).toThrow('has changed');
  });

  it('detects tampering when a completed phase placeholder is re-entered', () => {
    const source = state(phaseArtifact());
    const plan = source.steps.find((step) => step.id === 'plan');
    if (!plan || plan.kind !== 'agent' || !plan.output) throw new Error('missing plan output');
    const complete = {
      ...source,
      steps: source.steps.map((step) => step.id === 'phases'
        ? { ...step, status: 'complete' as const, manifestSha256: plan.output!.sha256, materializedAt: '2026-07-27T01:00:00.000Z', generatedStepIds: ['generated'] }
        : step).concat([{ id: 'generated', kind: 'gate' as const, status: 'pending' as const, artifact: 'plan', feedback: [] }]),
    } as RunState;
    writeFileSync(plan.output.path, '# tampered', 'utf8');
    const service = new ImplementationPhaseMaterializerService(
      { findState: () => complete, save: () => undefined } as never,
      { append: () => undefined } as never,
    );

    expect(() => service.materialize('run-phases', 'phases')).toThrow('has changed');
  });

  it('materializes a phase without review retries and gates its implementation artifact', () => {
    const source = state(phaseArtifact({ retryBudget: 0, gate: true }));
    const withoutReviewer = {
      ...source,
      steps: source.steps.map((step) => step.id === 'phases' && step.kind === 'phase-manifest'
        ? { id: step.id, kind: step.kind, status: step.status, artifact: step.artifact, actor: step.actor, method: step.method }
        : step),
    } as RunState;
    const service = new ImplementationPhaseMaterializerService(
      { findState: () => withoutReviewer, save: () => undefined } as never,
      { append: () => undefined } as never,
    );

    const result = service.materialize('run-phases', 'phases');

    expect(result.steps).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'phases--storage', patch: 'apply-unified-diff' }),
      expect.objectContaining({ id: 'phases--storage--approve', artifact: 'phases--storage' }),
    ]));
  });

  it('materializes a reviewer without a retry loop when the phase budget is zero', () => {
    const source = state(phaseArtifact({ retryBudget: 0, gate: false }));
    const service = new ImplementationPhaseMaterializerService(
      { findState: () => source, save: () => undefined } as never,
      { append: () => undefined } as never,
    );

    const result = service.materialize('run-phases', 'phases');

    expect(result.steps.find((step) => step.id === 'phases--storage--review')).toMatchObject({
      verdictPolicy: { blocked: 'stop' },
    });
  });

  it('keeps phase dependencies in the frozen serial materialization order', () => {
    const source = state(phaseArtifact({}, [{
      id: 'migration', objective: 'Migrate storage.', scope: ['migration'], dependsOn: ['storage'],
      verification: ['Run migration tests.'], retryBudget: 0, gate: false,
    }]));
    const service = new ImplementationPhaseMaterializerService(
      { findState: () => source, save: () => undefined } as never,
      { append: () => undefined } as never,
    );

    const result = service.materialize('run-phases', 'phases');

    expect(result.steps.map((step) => step.id)).toEqual(expect.arrayContaining([
      'phases--storage', 'phases--migration',
    ]));
    expect(result.workflow.successors['phases--storage--approve']).toEqual(['phases--migration']);
  });

  it('validates phase placeholder state and preserves phase data on generated agents', () => {
    const phase = { id: 'storage', objective: 'Add storage.', scope: ['state'], dependsOn: [], verification: ['Run tests.'], retryBudget: 0, gate: false };
    const base = { id: 'phases', kind: 'phase-manifest' as const, status: 'pending' as const, artifact: 'plan', actor: 'implementer', method: { action: 'implement' } };
    const documentation = {
      target: { name: 'test', kind: 'filesystem' as const, root: '/tmp', defaultFormat: 'markdown' as const },
      featurePath: 'Features/{{ feature.id }}',
      bindings: { project: { name: 'Test', slug: 'test' }, feature: { id: 'IMP-71', slug: 'phases' }, run: { id: 'phase-data' } },
    };

    expect(runStepSchema.safeParse({ ...base, reviewer: 'adversary' }).success).toBe(false);
    expect(runStepSchema.safeParse({ ...base, manifestSha256: hash }).success).toBe(false);
    expect(() => createRunState({
      id: 'missing-phase-fields', workflowId: 'phases', workflowSha256: hash, roles: {}, documentation,
      steps: [{ id: 'phases', kind: 'phase-manifest', artifact: 'plan' }], now: '2026-07-27T00:00:00.000Z',
    })).toThrow('requires an artifact, actor and method');
    expect(() => createRunState({
      id: 'missing-review-method', workflowId: 'phases', workflowSha256: hash, roles: {}, documentation,
      steps: [{ ...base, reviewer: 'adversary' }], now: '2026-07-27T00:00:00.000Z',
    })).toThrow('requires reviewer and review method together');
    expect(createRunState({
      id: 'phase-data', workflowId: 'phases', workflowSha256: hash, roles: {}, documentation,
      steps: [
        { ...base, reviewer: 'adversary', reviewMethod: { action: 'review' } },
        { id: 'implement', kind: 'agent', actor: 'implementer', action: 'implement', output: { id: 'implementation', filename: 'Implementation.md' }, phase },
      ], now: '2026-07-27T00:00:00.000Z',
    }).steps).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'phases', reviewer: 'adversary' }),
      expect.objectContaining({ id: 'implement', phase }),
    ]));
  });
});
