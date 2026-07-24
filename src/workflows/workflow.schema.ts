import { isAbsolute, win32 } from 'node:path';
import { z } from 'zod';
import { isKnownDocumentationTemplate } from '../documentation/templates';

const runtimeIdentifier = z.string().regex(/^[a-z][a-z0-9-]*$/, {
  error: 'must use lowercase letters, numbers and hyphens, starting with a letter',
});

const identifier = runtimeIdentifier.refine((value) => !value.includes('--') && !value.endsWith('-'), {
  error: 'must use lowercase letters, numbers and single hyphens, without a trailing hyphen',
});

const nonEmptyString = z.string().trim().min(1);

function hasForbiddenLiteralCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 0x1f) return true;
    if (code === 0x7f) return true;
    if (code === 0x2028) return true;
    if (code === 0x2029) return true;
  }
  return false;
}

function isValidPrimitiveString(value: string): boolean {
  if (value.includes('{{') || value.includes('}}')) return false;
  return !hasForbiddenLiteralCharacter(value);
}

const primitiveString = z.string().refine(
  isValidPrimitiveString,
  'must not contain a dynamic expression or control character',
);

export const workflowPrimitiveValueSchema = z.union([
  primitiveString,
  z.boolean(),
  z.number().int(),
]);

export type WorkflowPrimitiveValue = z.infer<typeof workflowPrimitiveValueSchema>;

const staticText = nonEmptyString.refine(
  (value) => !value.includes('{{') && !value.includes('}}'),
  'must not contain a dynamic expression',
);

const stringParameterSchema = z.object({
  type: z.literal('string'),
  minLength: z.number().int().min(0).optional(),
  maxLength: z.number().int().min(0).optional(),
  default: primitiveString.optional(),
}).strict().superRefine((value, context) => {
  if (value.minLength !== undefined && value.maxLength !== undefined && value.minLength > value.maxLength) {
    context.addIssue({ code: 'custom', path: ['minLength'], message: 'must not exceed maxLength' });
  }
  if (value.default !== undefined) {
    if (value.minLength !== undefined && value.default.length < value.minLength) {
      context.addIssue({ code: 'custom', path: ['default'], message: 'must satisfy minLength' });
    }
    if (value.maxLength !== undefined && value.default.length > value.maxLength) {
      context.addIssue({ code: 'custom', path: ['default'], message: 'must satisfy maxLength' });
    }
  }
});

const booleanParameterSchema = z.object({
  type: z.literal('boolean'),
  default: z.boolean().optional(),
}).strict();

const integerParameterSchema = z.object({
  type: z.literal('integer'),
  minimum: z.number().int().optional(),
  maximum: z.number().int().optional(),
  default: z.number().int().optional(),
}).strict().superRefine((value, context) => {
  if (value.minimum !== undefined && value.maximum !== undefined && value.minimum > value.maximum) {
    context.addIssue({ code: 'custom', path: ['minimum'], message: 'must not exceed maximum' });
  }
  if (value.default !== undefined) {
    if (value.minimum !== undefined && value.default < value.minimum) {
      context.addIssue({ code: 'custom', path: ['default'], message: 'must satisfy minimum' });
    }
    if (value.maximum !== undefined && value.default > value.maximum) {
      context.addIssue({ code: 'custom', path: ['default'], message: 'must satisfy maximum' });
    }
  }
});

const enumParameterSchema = z.object({
  type: z.literal('enum'),
  values: z.array(staticText).min(1),
  default: staticText.optional(),
}).strict().superRefine((value, context) => {
  if (new Set(value.values).size !== value.values.length) {
    context.addIssue({ code: 'custom', path: ['values'], message: 'must not contain duplicate values' });
  }
  if (value.default !== undefined && !value.values.includes(value.default)) {
    context.addIssue({ code: 'custom', path: ['default'], message: 'must be one of values' });
  }
});

export const workflowParameterDefinitionSchema = z.discriminatedUnion('type', [
  stringParameterSchema,
  booleanParameterSchema,
  integerParameterSchema,
  enumParameterSchema,
]);

export const workflowParametersSchema = z.record(identifier, workflowParameterDefinitionSchema);

export type WorkflowParameterDefinition = z.infer<typeof workflowParameterDefinitionSchema>;
export type WorkflowParameters = z.infer<typeof workflowParametersSchema>;

export const workflowResultSchema = z.object({
  fields: z.record(identifier, workflowParameterDefinitionSchema).refine(
    (fields) => Object.keys(fields).length > 0,
    'must declare at least one field',
  ).superRefine((fields, context) => {
    for (const [name, definition] of Object.entries(fields)) {
      if (definition.default !== undefined) {
        context.addIssue({ code: 'custom', path: [name, 'default'], message: 'is not allowed on a result field' });
      }
    }
  }),
}).strict();

export type WorkflowResult = z.infer<typeof workflowResultSchema>;

const parameterReferenceSchema = z.object({ parameter: identifier }).strict();
const resultReferenceSchema = z.object({
  result: z.object({ step: runtimeIdentifier, field: identifier }).strict(),
}).strict();
export const workflowConditionOperandSchema = z.union([
  workflowPrimitiveValueSchema,
  parameterReferenceSchema,
  resultReferenceSchema,
]);

export type WorkflowConditionOperand = z.infer<typeof workflowConditionOperandSchema>;

export type WorkflowCondition =
  | { readonly equals: { readonly left: WorkflowConditionOperand; readonly right: WorkflowConditionOperand } }
  | { readonly notEquals: { readonly left: WorkflowConditionOperand; readonly right: WorkflowConditionOperand } }
  | { readonly all: readonly WorkflowCondition[] }
  | { readonly any: readonly WorkflowCondition[] }
  | { readonly not: WorkflowCondition };

export const workflowConditionSchema: z.ZodType<WorkflowCondition> = z.lazy(() => z.union([
  z.object({
    equals: z.object({ left: workflowConditionOperandSchema, right: workflowConditionOperandSchema }).strict(),
  }).strict(),
  z.object({
    notEquals: z.object({ left: workflowConditionOperandSchema, right: workflowConditionOperandSchema }).strict(),
  }).strict(),
  z.object({ all: z.array(workflowConditionSchema).min(1) }).strict(),
  z.object({ any: z.array(workflowConditionSchema).min(1) }).strict(),
  z.object({ not: workflowConditionSchema }).strict(),
]));

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

export const workflowPatchSchema = z.literal('apply-unified-diff');
export type WorkflowPatch = z.infer<typeof workflowPatchSchema>;

export const workflowExecutionAuthorizationSchema = z.enum(['explicit', 'pre-authorized']);
export type WorkflowExecutionAuthorization = z.infer<typeof workflowExecutionAuthorizationSchema>;

const executionAuthorizationSchema = z.object({
  authorization: workflowExecutionAuthorizationSchema.default('explicit'),
}).strict().default({ authorization: 'explicit' });

const agentBaseSchema = z
  .object({
    id: identifier,
    type: z.literal('agent'),
    actor: identifier,
    output: outputSchema,
    verdictPolicy: verdictPolicySchema.optional(),
    result: workflowResultSchema.optional(),
    when: workflowConditionSchema.optional(),
    patch: workflowPatchSchema.optional(),
    execution: executionAuthorizationSchema,
  })
  .strict();

const capabilityAgentStepSchema = agentBaseSchema.extend({
  capability: identifier,
}).strict();

const promptAgentStepSchema = agentBaseSchema.extend({
  promptFile: safeRelativeMarkdownPath,
}).strict();

const hostHandoffBaseSchema = z.object({
  id: identifier,
  type: z.literal('host-handoff'),
  inputs: z.array(identifier).max(10).refine((inputs) => new Set(inputs).size === inputs.length, {
    error: 'must not contain duplicate artifact IDs',
  }),
  output: outputSchema,
  sideEffects: z.literal('none'),
}).strict();

const promptHostHandoffStepSchema = hostHandoffBaseSchema.extend({
  promptFile: safeRelativeMarkdownPath,
}).strict();

const interactiveHostHandoffStepSchema = hostHandoffBaseSchema.extend({
  actor: identifier,
  capability: identifier,
  interaction: z.literal('user-dialog'),
}).strict();

const hostHandoffStepSchema = z.union([
  promptHostHandoffStepSchema,
  interactiveHostHandoffStepSchema,
]);

const gateStepSchema = z
  .object({
    id: identifier,
    type: z.literal('gate'),
    artifact: identifier,
  })
  .strict();

const composedWorkflowStepSchema = z
  .object({
    id: identifier,
    uses: z.string().regex(/^workflow:(?!.*--)[a-z](?:[a-z0-9-]*[a-z0-9])?$/, {
      error: 'must reference a workflow as workflow:<id>',
    }),
    actors: z.record(identifier, identifier).optional(),
    with: z.record(
      identifier,
      z.union([workflowPrimitiveValueSchema, z.object({ fromParameter: identifier }).strict()]),
    ).optional(),
  })
  .strict();

const reviewCycleStepSchema = z.object({
  id: identifier,
  type: z.literal('review-cycle'),
  actor: identifier,
  reviewer: identifier,
  capability: identifier,
  reviewCapability: identifier,
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
    parameters: workflowParametersSchema.optional(),
    steps: z.array(z.union([
      capabilityAgentStepSchema,
      promptAgentStepSchema,
      hostHandoffStepSchema,
      gateStepSchema,
      reviewCycleStepSchema,
      composedWorkflowStepSchema,
    ])).min(1),
  })
  .strict()
  .superRefine((workflow, context) => {
    const stepIds = new Set<string>();
    const outputIds = new Map<string, { readonly index: number; readonly conditional: boolean }>();

    workflow.steps.forEach((step, index) => {
      if (stepIds.has(step.id)) {
        context.addIssue({
          code: 'custom',
          path: ['steps', index, 'id'],
          message: `duplicate step ID "${step.id}"`,
        });
      }
      stepIds.add(step.id);

      if ('uses' in step) return;

      if (step.type === 'agent' || step.type === 'host-handoff' || step.type === 'review-cycle') {
        if (outputIds.has(step.output.id)) {
          context.addIssue({
            code: 'custom',
            path: ['steps', index, 'output', 'id'],
            message: `duplicate output ID "${step.output.id}"`,
          });
        }
        outputIds.set(step.output.id, { index, conditional: step.type === 'agent' && step.when !== undefined });
      }

      if (step.type === 'host-handoff') {
        for (const [inputIndex, input] of step.inputs.entries()) {
          const producer = outputIds.get(input);
          if (!producer) {
            context.addIssue({
              code: 'custom',
              path: ['steps', index, 'inputs', inputIndex],
              message: 'must reference an output produced by a preceding step',
            });
          } else if (producer.conditional) {
            context.addIssue({
              code: 'custom',
              path: ['steps', index, 'inputs', inputIndex],
              message: 'must reference an unconditional output; a false condition would make the handoff input unavailable',
            });
          }
        }
      }

      if (step.type === 'gate') {
        const producer = outputIds.get(step.artifact);
        if (!producer) {
          context.addIssue({
            code: 'custom',
            path: ['steps', index, 'artifact'],
            message: `must reference an output produced by a preceding step`,
          });
        } else if (producer.conditional) {
          context.addIssue({
            code: 'custom',
            path: ['steps', index, 'artifact'],
            message: 'must reference an output from an unconditional agent step; a false condition would make the gate unreachable',
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
        if (!target || !('type' in target) || (target.type !== 'agent' && target.type !== 'host-handoff')) {
          context.addIssue({
            code: 'custom',
            path: ['steps', index, 'verdictPolicy', 'changesRequested', 'retryFrom'],
            message: 'must reference an earlier agent or host-handoff step',
          });
        }
      }
    });

    const generatedOwners = new Map<string, number>();
    workflow.steps.forEach((step, index) => {
      if ('uses' in step) return;
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
export type HostHandoffWorkflowStep = Extract<WorkflowStep, { readonly type: 'host-handoff' }>;
export type GateWorkflowStep = Extract<WorkflowStep, { readonly type: 'gate' }>;
export type ComposedWorkflowStep = Extract<WorkflowStep, { readonly uses: string }>;

export function isAgentWorkflowStep(step: WorkflowStep): step is AgentWorkflowStep {
  return 'type' in step && step.type === 'agent';
}
