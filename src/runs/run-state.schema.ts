import { z } from 'zod';

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const timestampSchema = z.string().datetime();
const nonEmptyString = z.string().trim().min(1);
const stepStatusSchema = z.enum(['pending', 'in_progress', 'complete', 'stale', 'failed']);

const attemptSchema = z
  .object({
    number: z.number().int().positive(),
    startedAt: timestampSchema,
    inputArtifactHashes: z.record(nonEmptyString, sha256Schema),
    completedAt: timestampSchema.optional(),
    outputSha256: sha256Schema.optional(),
  })
  .strict();

const preparedDocumentationOutputSchema = z
  .object({
    id: nonEmptyString,
    targetRoot: nonEmptyString,
    directory: nonEmptyString,
    path: nonEmptyString,
    format: z.literal('markdown'),
  })
  .strict();

const declaredWorkflowOutputSchema = z
  .object({
    id: nonEmptyString,
    filename: nonEmptyString,
    template: nonEmptyString.optional(),
  })
  .strict();

const agentMethodSchema = z.union([
  z.object({ action: nonEmptyString }).strict(),
  z.object({ promptFile: nonEmptyString }).strict(),
]);

const documentationContextSchema = z
  .object({
    target: z
      .object({
        name: nonEmptyString,
        kind: z.literal('filesystem'),
        root: nonEmptyString,
        defaultFormat: z.literal('markdown'),
      })
      .strict(),
    featurePath: nonEmptyString,
    bindings: z
      .object({
        project: z.object({ name: nonEmptyString, slug: nonEmptyString }).strict(),
        feature: z.object({ id: nonEmptyString, slug: nonEmptyString }).strict(),
        run: z.object({ id: nonEmptyString }).strict(),
      })
      .strict(),
  })
  .strict();

const runAgentStepSchema = z
  .object({
    id: nonEmptyString,
    kind: z.literal('agent'),
    status: stepStatusSchema,
    actor: z.enum(['launcher', 'adversary', 'implementer']),
    method: agentMethodSchema,
    declaredOutput: declaredWorkflowOutputSchema,
    expectedOutput: preparedDocumentationOutputSchema.optional(),
    output: z
      .object({
        id: nonEmptyString,
        path: nonEmptyString,
        format: z.literal('markdown'),
        sha256: sha256Schema,
        completedAt: timestampSchema,
      })
      .strict()
      .optional(),
    inputArtifactHashes: z.record(nonEmptyString, sha256Schema).optional(),
    attempts: z.array(attemptSchema),
    approval: z
      .object({
        approvedArtifactHash: sha256Schema,
        approvedAt: timestampSchema,
        comment: z.string().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const runGateStepSchema = z
  .object({
    id: nonEmptyString,
    kind: z.literal('gate'),
    status: stepStatusSchema,
    artifact: nonEmptyString,
    approval: z
      .object({
        approvedArtifactHash: sha256Schema,
        approvedAt: timestampSchema,
        comment: z.string().optional(),
      })
      .strict()
      .optional(),
    feedback: z.array(
      z.object({
        requestedAt: timestampSchema,
        comment: z.string().min(1),
      }).strict(),
    ),
  })
  .strict();

export const runStepSchema = z.union([runAgentStepSchema, runGateStepSchema]);

export const runStateSchema = z
  .object({
    version: z.literal(1),
    id: nonEmptyString,
    workflow: z
      .object({
        id: nonEmptyString,
        sha256: sha256Schema,
        successors: z.record(nonEmptyString, z.array(nonEmptyString)),
      })
      .strict(),
    roles: z.record(nonEmptyString, nonEmptyString),
    documentation: documentationContextSchema,
    currentStepId: nonEmptyString.optional(),
    steps: z.array(runStepSchema),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .strict();

export type RunState = z.infer<typeof runStateSchema>;

export function createRunState(input: {
  readonly id: string;
  readonly workflowId: string;
  readonly workflowSha256: string;
  readonly roles: Readonly<Record<string, string>>;
  readonly documentation: z.input<typeof documentationContextSchema>;
  readonly steps: readonly {
    readonly id: string;
    readonly kind: 'agent' | 'gate';
    readonly actor?: 'launcher' | 'adversary' | 'implementer';
    readonly action?: string;
    readonly promptFile?: string;
    readonly output?: {
      readonly id: string;
      readonly filename: string;
      readonly template?: string;
    };
    readonly artifact?: string;
  }[];
  readonly now: string;
}): RunState {
  return runStateSchema.parse({
    version: 1,
    id: input.id,
    workflow: {
      id: input.workflowId,
      sha256: input.workflowSha256,
      successors: Object.fromEntries(
        input.steps.map((step, index) => [
          step.id,
          index + 1 < input.steps.length ? [input.steps[index + 1].id] : [],
        ]),
      ),
    },
    roles: input.roles,
    documentation: input.documentation,
    steps: input.steps.map((step) => {
      if (step.kind === 'gate') {
        if (!step.artifact) {
          throw new Error(`Gate ${step.id} requires an artifact reference`);
        }
        return {
          id: step.id,
          kind: 'gate' as const,
          status: 'pending' as const,
          artifact: step.artifact,
          feedback: [],
        };
      }
      if (!step.actor || !step.output) {
        throw new Error(`Agent ${step.id} requires an actor and declared output`);
      }
      const method = step.action ? { action: step.action } : step.promptFile
        ? { promptFile: step.promptFile }
        : undefined;
      if (!method || (step.action && step.promptFile)) {
        throw new Error(`Agent ${step.id} requires exactly one action or promptFile`);
      }
      return {
        id: step.id,
        kind: 'agent' as const,
        status: 'pending' as const,
        actor: step.actor,
        method,
        declaredOutput: step.output,
        attempts: [],
      };
    }),
    createdAt: input.now,
    updatedAt: input.now,
  });
}
