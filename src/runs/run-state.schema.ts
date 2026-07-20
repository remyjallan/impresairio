import { z } from 'zod';

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const timestampSchema = z.string().datetime();
const nonEmptyString = z.string().trim().min(1);

export const runStepSchema = z
  .object({
    id: nonEmptyString,
    kind: z.enum(['agent', 'gate']),
    status: z.enum(['pending', 'in_progress', 'complete', 'stale']),
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

export const runStateSchema = z
  .object({
    version: z.literal(1),
    id: nonEmptyString,
    workflow: z
      .object({
        id: nonEmptyString,
        sha256: sha256Schema,
      })
      .strict(),
    roles: z.record(nonEmptyString, nonEmptyString),
    documentationRoot: nonEmptyString,
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
  readonly roles: Readonly<Record<string, string>>;
  readonly documentationRoot: string;
  readonly now: string;
}): RunState {
  return runStateSchema.parse({
    version: 1,
    id: input.id,
    workflow: {
      id: input.workflowId,
      // Workflow lookup is introduced in Task 5. This deterministic placeholder
      // keeps each V0 state self-describing until the real YAML hash is resolved.
      sha256: '0'.repeat(64),
    },
    roles: input.roles,
    documentationRoot: input.documentationRoot,
    steps: [],
    createdAt: input.now,
    updatedAt: input.now,
  });
}
