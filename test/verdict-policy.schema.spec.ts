import { describe, expect, it } from 'vitest';
import { workflowSchema } from '../src/workflows/workflow.schema';

function workflowWith(steps: Record<string, unknown>[]): unknown {
  return { id: 'sample', name: 'Sample', steps };
}

const implement = {
  id: 'implement', type: 'agent', actor: 'implementer', capability: 'implement',
  output: { id: 'implementation-report', filename: '01 - Implementation Report.md' },
};

describe('workflow verdictPolicy schema', () => {
  it('accepts a full policy on an agent step', () => {
    const result = workflowSchema.safeParse(workflowWith([implement, {
      id: 'verify', type: 'agent', actor: 'adversary', capability: 'verification',
      output: { id: 'verification', filename: '02 - Verification.md' },
      verdictPolicy: {
        approved: 'continue',
        changesRequested: { retryFrom: 'implement', maxIterations: 2 },
        blocked: 'stop',
      },
    }]));
    expect(result.success).toBe(true);
  });

  it('rejects an empty policy object', () => {
    const result = workflowSchema.safeParse(workflowWith([implement, {
      id: 'verify', type: 'agent', actor: 'adversary', capability: 'verification',
      output: { id: 'verification', filename: '02 - Verification.md' },
      verdictPolicy: {},
    }]));
    expect(result.success).toBe(false);
  });

  it('rejects retryFrom pointing at an unknown or later step', () => {
    const later = workflowSchema.safeParse(workflowWith([{
      id: 'verify', type: 'agent', actor: 'adversary', capability: 'verification',
      output: { id: 'verification', filename: '02 - Verification.md' },
      verdictPolicy: { changesRequested: { retryFrom: 'implement', maxIterations: 2 } },
    }, implement]));
    expect(later.success).toBe(false);
    expect(JSON.stringify(later.success ? [] : later.error.issues)).toContain('earlier agent step');
  });

  it('rejects verdictPolicy on gate and review-cycle steps', () => {
    const onGate = workflowSchema.safeParse(workflowWith([implement, {
      id: 'approve', type: 'gate', artifact: 'implementation-report', verdictPolicy: { blocked: 'stop' },
    }]));
    expect(onGate.success).toBe(false);
    const onCycle = workflowSchema.safeParse(workflowWith([{
      id: 'design', type: 'review-cycle', actor: 'launcher', reviewer: 'adversary',
      capability: 'feature-design', reviewCapability: 'adversarial-review', maxIterations: 2,
      output: { id: 'design', filename: '01 - Design.md' }, gateId: 'approve-design',
      verdictPolicy: { blocked: 'stop' },
    }]));
    expect(onCycle.success).toBe(false);
  });

  it('rejects maxIterations outside 1..10', () => {
    const result = workflowSchema.safeParse(workflowWith([implement, {
      id: 'verify', type: 'agent', actor: 'adversary', capability: 'verification',
      output: { id: 'verification', filename: '02 - Verification.md' },
      verdictPolicy: { changesRequested: { retryFrom: 'implement', maxIterations: 0 } },
    }]));
    expect(result.success).toBe(false);
  });
});
