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
  })
  .strict();

const agentBaseSchema = z
  .object({
    id: identifier,
    type: z.literal('agent'),
    actor: z.enum(['launcher', 'adversary', 'implementer']),
    output: outputSchema,
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

export const workflowSchema = z
  .object({
    id: identifier,
    name: staticText,
    steps: z.array(z.union([actionAgentStepSchema, promptAgentStepSchema, gateStepSchema])).min(1),
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

      if (step.type === 'agent') {
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
    });
  });

export type Workflow = z.infer<typeof workflowSchema>;
export type WorkflowStep = Workflow['steps'][number];
export type AgentWorkflowStep = Extract<WorkflowStep, { readonly type: 'agent' }>;
export type GateWorkflowStep = Extract<WorkflowStep, { readonly type: 'gate' }>;

export function isAgentWorkflowStep(step: WorkflowStep): step is AgentWorkflowStep {
  return step.type === 'agent';
}
