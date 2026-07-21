import { isAbsolute, win32 } from 'node:path';
import { z } from 'zod';
import { isKnownDocumentationTemplate } from '../documentation/templates';

const identifier = z.string().regex(/^[a-z][a-z0-9-]*$/, {
  error: 'must use lowercase letters, numbers and hyphens, starting with a letter',
});

const nonEmptyString = z.string().trim().min(1);

const staticText = nonEmptyString.refine(
  (value) => !value.includes('{{') && !value.includes('}}'),
  'must not contain a dynamic expression',
);

const safeRelativeMarkdownPath = staticText.refine(
  (value) => {
    const normalized = value.replaceAll('\\', '/');
    return !isAbsolute(value)
      && !win32.isAbsolute(value)
      && normalized.endsWith('.md')
      && !normalized.split('/').some((segment) => segment === '..' || segment.length === 0);
  },
  'must be a safe relative Markdown path without traversal segments',
);

const safeFilename = staticText.refine(
  (value) => {
    const normalized = value.replaceAll('\\', '/');
    return normalized.endsWith('.md')
      && !normalized.includes('/')
      && normalized !== '.'
      && normalized !== '..';
  },
  'must be a Markdown filename without path separators',
);

const builtInAction = z.enum([
  'feature-design',
  'adversarial-review',
  'specification',
  'spec-review',
  'integration-plan',
  'plan-review',
  'implementation',
  'final-review',
  'final-report',
  'investigate',
  'implement',
  'verification',
]);

const outputSchema = z
  .object({
    id: identifier,
    filename: safeFilename,
    template: identifier.refine(isKnownDocumentationTemplate, 'must be a known documentation template').optional(),
    storage: z.enum(['documentation', 'internal']).default('documentation'),
  })
  .strict();

const verdictPolicySchema = z
  .object({
    approved: z.literal('continue').optional(),
    changesRequested: z
      .object({
        retryFrom: identifier,
        maxIterations: z.number().int().min(1).max(10),
      })
      .strict()
      .optional(),
    blocked: z.literal('stop').optional(),
  })
  .strict()
  .refine(
    (policy) => policy.approved !== undefined
      || policy.changesRequested !== undefined
      || policy.blocked !== undefined,
    'must declare at least one verdict behavior',
  );

export type WorkflowVerdictPolicy = z.infer<typeof verdictPolicySchema>;

const agentBaseSchema = z
  .object({
    id: identifier,
    type: z.literal('agent'),
    actor: z.enum(['launcher', 'adversary', 'implementer']),
    output: outputSchema,
    verdictPolicy: verdictPolicySchema.optional(),
  })
  .strict();

const actionAgentStepSchema = agentBaseSchema.extend({
  action: builtInAction,
}).strict();

const promptAgentStepSchema = agentBaseSchema.extend({
  promptFile: safeRelativeMarkdownPath,
}).strict();

const gateStepSchema = z
  .object({
    id: identifier,
    type: z.literal('gate'),
    artifact: identifier,
  })
  .strict();

const reviewCycleStepSchema = z.object({
  id: identifier,
  type: z.literal('review-cycle'),
  actor: z.enum(['launcher', 'adversary', 'implementer']),
  reviewer: z.enum(['launcher', 'adversary', 'implementer']),
  action: builtInAction,
  reviewAction: builtInAction,
  maxIterations: z.number().int().min(1).max(10),
  output: outputSchema,
  gateId: identifier,
}).strict().superRefine((value, context) => {
  if (value.actor === value.reviewer) context.addIssue({ code: 'custom', path: ['reviewer'], message: 'must differ from actor' });
});

export const workflowSchema = z
  .object({
    id: identifier,
    name: staticText,
    steps: z.array(z.union([actionAgentStepSchema, promptAgentStepSchema, gateStepSchema, reviewCycleStepSchema])).min(1),
  })
  .strict()
  .superRefine((workflow, context) => {
    const stepIds = new Set<string>();
    const outputIds = new Set<string>();

    workflow.steps.forEach((step, index) => {
      if (stepIds.has(step.id)) {
        context.addIssue({
          code: 'custom',
          path: ['steps', index, 'id'],
          message: `duplicate step ID "${step.id}"`,
        });
      }
      stepIds.add(step.id);

      if (step.type === 'agent' || step.type === 'review-cycle') {
        if (outputIds.has(step.output.id)) {
          context.addIssue({
            code: 'custom',
            path: ['steps', index, 'output', 'id'],
            message: `duplicate output ID "${step.output.id}"`,
          });
        }
        outputIds.add(step.output.id);
      }

      if (step.type === 'gate') {
        if (!outputIds.has(step.artifact)) {
          context.addIssue({
            code: 'custom',
            path: ['steps', index, 'artifact'],
            message: `must reference an output produced by a preceding agent step`,
          });
        }
      }
      if (step.type === 'review-cycle') {
        if (stepIds.has(step.gateId)) context.addIssue({ code: 'custom', path: ['steps', index, 'gateId'], message: `duplicate step ID "${step.gateId}"` });
        stepIds.add(step.gateId);
      }
      if (step.type === 'agent' && step.verdictPolicy?.changesRequested) {
        const retryFrom = step.verdictPolicy.changesRequested.retryFrom;
        const target = workflow.steps
          .slice(0, index)
          .find((candidate) => candidate.id === retryFrom);
        if (!target || target.type !== 'agent') {
          context.addIssue({
            code: 'custom',
            path: ['steps', index, 'verdictPolicy', 'changesRequested', 'retryFrom'],
            message: 'must reference an earlier agent step',
          });
        }
      }
    });

    const generatedOwners = new Map<string, number>();
    workflow.steps.forEach((step, index) => {
      if (step.type !== 'review-cycle') return;
      const generated = [
        step.gateId,
        ...Array.from({ length: step.maxIterations }, (_value, offset) => `${step.id}-review-${offset + 1}`),
        ...Array.from({ length: Math.max(0, step.maxIterations - 1) }, (_value, offset) => `${step.id}-consolidate-${offset + 1}`),
      ];
      for (const id of generated) {
        const explicitIndex = workflow.steps.findIndex((candidate) => candidate.id === id);
        if (explicitIndex >= 0) {
          context.addIssue({ code: 'custom', path: ['steps', explicitIndex, 'id'], message: `collides with review-cycle generated step ID "${id}"` });
        }
        const previousOwner = generatedOwners.get(id);
        if (previousOwner !== undefined) {
          context.addIssue({ code: 'custom', path: ['steps', index, 'id'], message: `generates duplicate step ID "${id}" also generated by steps.${previousOwner}` });
        } else {
          generatedOwners.set(id, index);
        }
      }
      for (const outputId of Array.from(
        { length: step.maxIterations },
        (_value, offset) => `${step.id}-review-${offset + 1}`,
      )) {
        if (outputIds.has(outputId)) {
          context.addIssue({
            code: 'custom',
            path: ['steps', index, 'output', 'id'],
            message: `generated review output ID "${outputId}" collides with an explicit workflow output ID`,
          });
        }
      }
    });
  });

export type Workflow = z.infer<typeof workflowSchema>;
export type WorkflowStep = Workflow['steps'][number];
export type AgentWorkflowStep = Extract<WorkflowStep, { readonly type: 'agent' }>;
export type GateWorkflowStep = Extract<WorkflowStep, { readonly type: 'gate' }>;

export function isAgentWorkflowStep(step: WorkflowStep): step is AgentWorkflowStep {
  return step.type === 'agent';
}
