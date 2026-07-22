import { describe, expect, it } from 'vitest';
import { ConditionEvaluatorService } from '../src/workflows/condition-evaluator.service';
import { createRunState } from '../src/runs/run-state.schema';

const state = createRunState({
  id: 'run-condition', workflowId: 'condition', workflowSha256: 'a'.repeat(64), roles: {},
  documentation: {
    target: { name: 'test', kind: 'filesystem', root: '/tmp/docs', defaultFormat: 'markdown' },
    featurePath: 'unused',
    bindings: {
      project: { name: 'Test', slug: 'test' }, feature: { id: 'TEST-1', slug: 'test-1' },
      run: { id: 'run-condition' },
    },
  },
  steps: [], now: '2026-07-20T10:00:00.000Z',
});

describe('ConditionEvaluatorService', () => {
  const evaluator = new ConditionEvaluatorService();

  it('treats an absent operand as unknown, including through not', () => {
    const equals = { equals: { left: { parameter: 'missing' }, right: 'ready' } } as const;
    expect(evaluator.evaluate(equals, state, {})).toBe(false);
    expect(evaluator.evaluate({ not: equals }, state, {})).toBe(false);
  });

  it('does not let any/all hide an unknown operand', () => {
    const unknown = { equals: { left: { parameter: 'missing' }, right: 'ready' } } as const;
    expect(evaluator.evaluate({ any: [unknown, { equals: { left: true, right: true } }] }, state, {})).toBe(false);
    expect(evaluator.evaluate({ all: [{ equals: { left: false, right: true } }, unknown] }, state, {})).toBe(false);
  });

  it('evaluates resolved boolean compositions and negation', () => {
    expect(evaluator.evaluate({ equals: { left: true, right: true } }, state, {})).toBe(true);
    expect(evaluator.evaluate({ notEquals: { left: 'ready', right: 'blocked' } }, state, {})).toBe(true);
    expect(evaluator.evaluate({ all: [
      { equals: { left: true, right: true } },
      { notEquals: { left: 1, right: 2 } },
    ] }, state, {})).toBe(true);
    expect(evaluator.evaluate({ any: [
      { equals: { left: false, right: true } },
      { equals: { left: 'ready', right: 'ready' } },
    ] }, state, {})).toBe(true);
    expect(evaluator.evaluate({ not: { equals: { left: true, right: true } } }, state, {})).toBe(false);
  });
});
