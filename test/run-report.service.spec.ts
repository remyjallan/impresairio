import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HomeDirectoryResolver } from '../src/config/home-directory.resolver';
import { EventLogService } from '../src/runs/event-log.service';
import { FileStateStore } from '../src/runs/file-state.store';
import { createRunState } from '../src/runs/run-state.schema';
import { formatRunReport, RunReportService } from '../src/runs/run-report.service';

const directories: string[] = [];

function createHarness() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'impresairio-report-')));
  directories.push(home);
  const resolver = new HomeDirectoryResolver({ IMPRESAIRIO_HOME: home });
  const store = new FileStateStore(resolver);
  const events = new EventLogService(resolver);
  const state = createRunState({
    id: 'run-report',
    workflowId: 'feature',
    workflowSha256: 'a'.repeat(64),
    roles: { launcher: 'opencode-glm' },
    resolvedActors: {
      launcher: {
        profile: 'opencode-glm', provider: 'opencode', modelAlias: 'glm',
        model: 'openrouter/z-ai/glm-5.2',
      },
    },
    documentation: {
      target: { name: 'test', kind: 'filesystem', root: home, defaultFormat: 'markdown' },
      featurePath: 'Features/{{ feature.id }}',
      bindings: {
        project: { name: 'Test', slug: 'test' },
        feature: { id: 'TEST-1', slug: 'test-1' },
        run: { id: 'run-report' },
      },
    },
    steps: [
      {
        id: 'design', kind: 'agent', actor: 'launcher', action: 'feature-design',
        output: { id: 'design', filename: '01 - Design.md' },
      },
      { id: 'approve-design', kind: 'gate', artifact: 'design' },
    ],
    now: '2026-07-22T10:00:00.000Z',
  });
  store.create(state);
  return { store, events, report: new RunReportService(store, events, () => new Date('2026-07-22T10:10:00.000Z')) };
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('RunReportService', () => {
  it('derives terminal duration, gate wait, agent details and recovery counters', () => {
    const { store, events, report } = createHarness();
    const state = store.findState('run-report');
    if (!state) throw new Error('missing state');
    store.save({
      ...state,
      updatedAt: '2026-07-22T10:06:00.000Z',
      steps: state.steps.map((step) => {
        if (step.kind === 'agent') {
          return {
            ...step,
            status: 'complete' as const,
            attempts: [{
              number: 1,
              startedAt: '2026-07-22T10:00:00.000Z',
              completedAt: '2026-07-22T10:01:00.000Z',
              inputArtifactHashes: {},
            }],
          };
        }
        return {
          ...step,
          status: 'complete' as const,
          reachedAt: '2026-07-22T10:01:00.000Z',
          approval: {
            approvedArtifactHash: 'b'.repeat(64),
            approvedAt: '2026-07-22T10:06:00.000Z',
          },
        };
      }),
    });
    for (const event of [
      { type: 'run.started', at: '2026-07-22T10:00:00.000Z' },
      { type: 'step.started', at: '2026-07-22T10:00:00.000Z', stepId: 'design' },
      { type: 'step.completed', at: '2026-07-22T10:01:00.000Z', stepId: 'design' },
      { type: 'gate.reached', at: '2026-07-22T10:01:00.000Z', gateId: 'approve-design' },
      { type: 'agent.execution.failed', at: '2026-07-22T10:02:00.000Z', stepId: 'design' },
      { type: 'step.retry_requested', at: '2026-07-22T10:03:00.000Z', stepId: 'design' },
      { type: 'agent.fallback.selected', at: '2026-07-22T10:04:00.000Z', stepId: 'design' },
      { type: 'verdict.changes_requested', at: '2026-07-22T10:05:00.000Z', stepId: 'design' },
      { type: 'gate.approved', at: '2026-07-22T10:06:00.000Z', gateId: 'approve-design' },
    ]) events.append('run-report', event);

    expect(report.create('run-report')).toMatchObject({
      run: {
        id: 'run-report', status: 'complete', durationMs: 360_000,
        endedAt: '2026-07-22T10:06:00.000Z',
      },
      agentSteps: [{
        id: 'design', provider: 'opencode', profile: 'opencode-glm',
        model: 'openrouter/z-ai/glm-5.2', durationMs: 60_000,
        attempts: [{ number: 1, durationMs: 60_000, outcome: 'complete' }],
      }],
      gates: [{
        id: 'approve-design', reachedAt: '2026-07-22T10:01:00.000Z', waitMs: 300_000,
      }],
      recovery: {
        providerFailures: 1, technicalRetries: 1, fallbacks: 1, productChangeRequests: 1,
      },
      availability: [],
    });
  });

  it('reports frozen Claude Code or Codex model and reasoning effort', () => {
    const { store, report } = createHarness();
    const state = store.findState('run-report');
    if (!state) throw new Error('missing state');
    store.save({
      ...state,
      resolvedActors: {
        launcher: {
          profile: 'codex-sol', provider: 'codex', model: 'gpt-5.6-sol', reasoningEffort: 'xhigh',
        },
      },
    });

    const result = report.create('run-report');

    expect(result.agentSteps[0]).toMatchObject({
      provider: 'codex', model: 'gpt-5.6-sol', reasoningEffort: 'xhigh',
    });
    expect(formatRunReport(result)).toContain('codex-sol / codex / gpt-5.6-sol / effort=xhigh');
  });

  it('reports unavailable gate timing for runs created before gate.reached existed', () => {
    const { report } = createHarness();
    const result = report.create('run-report');

    expect(result.gates).toEqual([{ id: 'approve-design', status: 'pending' }]);
    expect(result.availability).toContain(
      'gate approve-design: wait duration is unavailable (run predates gate.reached)',
    );
  });

  it('does not label an unclosed historical attempt as in progress after terminal failure', () => {
    const { store, events, report } = createHarness();
    const state = store.findState('run-report');
    if (!state) throw new Error('missing state');
    store.save({
      ...state,
      updatedAt: '2026-07-22T10:01:00.000Z',
      steps: state.steps.map((step) => step.kind === 'agent'
        ? {
            ...step,
            status: 'failed' as const,
            attempts: [{ number: 1, startedAt: '2026-07-22T10:00:00.000Z', inputArtifactHashes: {} }],
          }
        : step),
    });
    events.append('run-report', { type: 'run.started', at: '2026-07-22T10:00:00.000Z' });

    const result = report.create('run-report');
    expect(result.agentSteps[0]?.attempts).toEqual([{ number: 1, outcome: 'unavailable' }]);
    expect(result.availability).toContain('agent design: one or more attempt durations are unavailable');
  });
});
