import { z } from 'zod';
import {
  workflowConditionSchema,
  workflowPatchSchema,
  workflowPrimitiveValueSchema,
  workflowResultSchema,
} from '../workflows/workflow.schema';

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const timestampSchema = z.string().datetime();
const nonEmptyString = z.string().trim().min(1);
const stepStatusSchema = z.enum(['pending', 'in_progress', 'complete', 'skipped', 'stale', 'failed']);

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
    storage: z.enum(['documentation', 'internal']).default('documentation'),
  })
  .strict();

const structuredResultSchema = z.object({
  value: z.record(nonEmptyString, workflowPrimitiveValueSchema),
  outputSha256: sha256Schema,
  recordedAt: timestampSchema,
}).strict();

const appliedPatchSchema = z.object({
  sha256: sha256Schema,
  paths: z.array(nonEmptyString).min(1),
  appliedAt: timestampSchema,
}).strict();

const repositoryPatchStateSchema = z.object({
  baselineSha256: sha256Schema,
  currentSha256: sha256Schema,
}).strict();

const workflowDefinitionSchema = z
  .object({
    instanceId: nonEmptyString,
    workflowId: nonEmptyString,
    source: z.enum(['repository', 'global', 'package']),
    sha256: sha256Schema,
  })
  .strict();

const agentMethodSchema = z.union([
  z.object({ action: nonEmptyString }).strict(),
  z.object({ promptFile: nonEmptyString, content: z.string().min(1) }).strict(),
  z.object({ capability: nonEmptyString, skill: nonEmptyString }).strict(),
  z.object({
    capability: nonEmptyString,
    promptSource: z.enum(['global', 'package']),
    content: z.string().min(1),
  }).strict(),
]);

const retryContextSchema = z.object({
  sourceStepId: nonEmptyString,
  artifactPath: nonEmptyString,
  artifactSha256: sha256Schema,
  at: timestampSchema,
}).strict();

const hostHandoffAmendmentSchema = z.object({
  revision: z.number().int().positive(),
  amendedAt: timestampSchema,
  reason: z.string().trim().min(1).max(1_000),
  priorOutput: z.object({
    path: nonEmptyString,
    sha256: sha256Schema,
    completedAt: timestampSchema,
    archivedPath: nonEmptyString,
  }).strict(),
}).strict();

const failedAgentOutputSchema = z.object({
  artifactPath: nonEmptyString,
  artifactSha256: sha256Schema,
  at: timestampSchema,
  diagnostic: z.string().trim().min(1).max(1_000),
  truncated: z.boolean(),
}).strict();

const externalAgentRecoverySchema = z.object({
  preparedAt: timestampSchema,
  reason: z.string().trim().min(1).max(1_000),
}).strict();

const frozenAgentProfileSchema = z.discriminatedUnion('provider', [
  z.object({
    profile: nonEmptyString,
    provider: z.literal('claude-code'),
    model: nonEmptyString.optional(),
    reasoningEffort: nonEmptyString.optional(),
    skills: z.record(nonEmptyString, nonEmptyString).optional(),
  }).strict(),
  z.object({
    profile: nonEmptyString,
    provider: z.literal('codex'),
    model: nonEmptyString.optional(),
    reasoningEffort: nonEmptyString.optional(),
    skills: z.record(nonEmptyString, nonEmptyString).optional(),
  }).strict(),
  z.object({
    profile: nonEmptyString,
    provider: z.literal('opencode'),
    modelAlias: nonEmptyString,
    model: nonEmptyString,
    skills: z.record(nonEmptyString, nonEmptyString).optional(),
  }).strict(),
]);

const resolvedActorProfileSchema = z.discriminatedUnion('provider', [
  z.object({
    profile: nonEmptyString,
    provider: z.literal('claude-code'),
    model: nonEmptyString.optional(),
    reasoningEffort: nonEmptyString.optional(),
    skills: z.record(nonEmptyString, nonEmptyString).optional(),
    fallbacks: z.array(frozenAgentProfileSchema).max(5).optional(),
  }).strict(),
  z.object({
    profile: nonEmptyString,
    provider: z.literal('codex'),
    model: nonEmptyString.optional(),
    reasoningEffort: nonEmptyString.optional(),
    skills: z.record(nonEmptyString, nonEmptyString).optional(),
    fallbacks: z.array(frozenAgentProfileSchema).max(5).optional(),
  }).strict(),
  z.object({
    profile: nonEmptyString,
    provider: z.literal('opencode'),
    modelAlias: nonEmptyString,
    model: nonEmptyString,
    skills: z.record(nonEmptyString, nonEmptyString).optional(),
    fallbacks: z.array(frozenAgentProfileSchema).max(5).optional(),
  }).strict(),
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

const abandonmentSchema = z.object({
  at: timestampSchema,
  reason: z.string().trim().min(1).max(1_000),
  externalReference: z.string().trim().min(1).max(2_000).optional(),
}).strict();

const runAgentStepSchema = z
  .object({
    id: nonEmptyString,
    kind: z.literal('agent'),
    status: stepStatusSchema,
    actor: nonEmptyString,
    executionAuthorization: z.enum(['explicit', 'pre-authorized']).optional(),
    method: agentMethodSchema,
    declaredOutput: declaredWorkflowOutputSchema,
    agentOverride: frozenAgentProfileSchema.optional(),
    fallbackHistory: z.array(z.object({
      from: frozenAgentProfileSchema,
      to: frozenAgentProfileSchema,
      reason: nonEmptyString.max(1_000),
      selectedAt: timestampSchema,
    }).strict()).max(5).optional(),
    effectiveParameters: z.record(nonEmptyString, workflowPrimitiveValueSchema).optional(),
    declaredResult: workflowResultSchema.optional(),
    patch: workflowPatchSchema.optional(),
    appliedPatch: appliedPatchSchema.optional(),
    when: workflowConditionSchema.optional(),
    result: structuredResultSchema.optional(),
    conditionDecision: z.object({
      condition: workflowConditionSchema,
      evaluatedAt: timestampSchema,
      result: z.literal(false),
    }).strict().optional(),
    expectedOutput: preparedDocumentationOutputSchema.optional(),
    dispatchPreparedAt: timestampSchema.optional(),
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
    cycle: z.object({
      id: nonEmptyString,
      role: z.enum(['review', 'consolidate']),
      iteration: z.number().int().positive(),
    }).strict().optional(),
    reviewOutcome: z.object({
      verdict: z.enum(['APPROVED', 'CHANGES_REQUESTED', 'BLOCKED']),
      exhausted: z.boolean(),
    }).strict().optional(),
    verdictPolicy: z.object({
      approved: z.literal('continue').optional(),
      changesRequested: z.object({
        retryFrom: nonEmptyString,
        maxIterations: z.number().int().min(1).max(10),
      }).strict().optional(),
      blocked: z.literal('stop').optional(),
    }).strict().optional(),
    verdictRetries: z.number().int().nonnegative().optional(),
    retryContext: retryContextSchema.optional(),
    failedAgentOutput: failedAgentOutputSchema.optional(),
    externalRecovery: externalAgentRecoverySchema.optional(),
    acknowledgment: z.object({
      at: timestampSchema,
      comment: z.string().min(1),
    }).strict().optional(),
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
    reachedAt: timestampSchema.optional(),
  })
  .strict();

const runHostHandoffStepSchema = z.object({
  id: nonEmptyString,
  kind: z.literal('host-handoff'),
  status: stepStatusSchema,
  actor: nonEmptyString.optional(),
  method: agentMethodSchema.optional(),
  interaction: z.literal('user-dialog').optional(),
  promptFile: nonEmptyString.optional(),
  prompt: z.string().min(1).optional(),
  inputArtifactIds: z.array(nonEmptyString).max(10),
  declaredOutput: declaredWorkflowOutputSchema,
  sideEffects: z.literal('none'),
  expectedOutput: preparedDocumentationOutputSchema.optional(),
  output: z.object({
    id: nonEmptyString,
    path: nonEmptyString,
    format: z.literal('markdown'),
    sha256: sha256Schema,
    completedAt: timestampSchema,
  }).strict().optional(),
  inputArtifactHashes: z.record(nonEmptyString, sha256Schema).optional(),
  attempts: z.array(attemptSchema),
  handoffPreparedAt: timestampSchema.optional(),
  retryContext: retryContextSchema.optional(),
  amendments: z.array(hostHandoffAmendmentSchema).max(20).optional(),
}).strict().superRefine((step, context) => {
  const isInteractive = step.interaction === 'user-dialog';
  const hasPrompt = step.promptFile !== undefined && step.prompt !== undefined;
  if (isInteractive) {
    if (!step.actor || !step.method || !('capability' in step.method)) {
      context.addIssue({ code: 'custom', message: 'interactive host handoff requires actor and capability method' });
    }
    if (hasPrompt) {
      context.addIssue({ code: 'custom', message: 'interactive host handoff must not declare promptFile or prompt' });
    }
    return;
  }
  if (!hasPrompt) {
    context.addIssue({ code: 'custom', message: 'host handoff requires promptFile and prompt' });
  }
  if (step.actor || step.method) {
    context.addIssue({ code: 'custom', message: 'prompt host handoff must not declare actor or method' });
  }
});

export const runStepSchema = z.union([runAgentStepSchema, runHostHandoffStepSchema, runGateStepSchema]);

export const runStateSchema = z
  .object({
    version: z.literal(1),
    id: nonEmptyString,
    request: z.string().trim().min(1).max(20_000).optional(),
    parameters: z.record(nonEmptyString, workflowPrimitiveValueSchema).optional(),
    repositoryDirectory: nonEmptyString.optional(),
    repositoryPatch: repositoryPatchStateSchema.optional(),
    workflow: z
      .object({
        id: nonEmptyString,
        sha256: sha256Schema,
        definitions: z.array(workflowDefinitionSchema).min(1).optional(),
        successors: z.record(nonEmptyString, z.array(nonEmptyString)),
      })
      .strict(),
    roles: z.record(nonEmptyString, nonEmptyString),
    resolvedActors: z.record(nonEmptyString, resolvedActorProfileSchema),
    documentation: documentationContextSchema,
    execution: z.object({
      agentTimeoutSeconds: z.number().int().min(1).max(86_400),
    }).strict().default({ agentTimeoutSeconds: 1_800 }),
    abandonment: abandonmentSchema.optional(),
    currentStepId: nonEmptyString.optional(),
    steps: z.array(runStepSchema),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .strict();

export type RunState = z.infer<typeof runStateSchema>;

/** Rejects mutations after an operator has deliberately closed a run. */
export function assertRunActive(state: Pick<RunState, 'id' | 'abandonment'>): void {
  if (state.abandonment) {
    throw new Error(`Run ${state.id} was abandoned at ${state.abandonment.at}: ${state.abandonment.reason}`);
  }
}

export function createRunState(input: {
  readonly id: string;
  readonly workflowId: string;
  readonly request?: string;
  readonly repositoryDirectory?: string;
  readonly workflowSha256: string;
  readonly workflowDefinitions?: readonly z.input<typeof workflowDefinitionSchema>[];
  readonly roles: Readonly<Record<string, string>>;
  readonly resolvedActors?: z.input<typeof runStateSchema>['resolvedActors'];
  readonly parameters?: Readonly<Record<string, z.input<typeof workflowPrimitiveValueSchema>>>;
  readonly documentation: z.input<typeof documentationContextSchema>;
  readonly execution?: { readonly agentTimeoutSeconds: number };
  readonly steps: readonly {
    readonly id: string;
    readonly kind: 'agent' | 'host-handoff' | 'gate';
    readonly actor?: string;
    readonly executionAuthorization?: 'explicit' | 'pre-authorized';
    readonly method?: z.input<typeof agentMethodSchema>;
    readonly action?: string;
    readonly interaction?: 'user-dialog';
    readonly promptFile?: string;
    readonly prompt?: string;
    readonly inputs?: readonly string[];
    readonly sideEffects?: 'none';
    readonly output?: {
      readonly id: string;
      readonly filename: string;
      readonly template?: string;
      readonly storage?: 'documentation' | 'internal';
    };
    readonly effectiveParameters?: Readonly<Record<string, z.input<typeof workflowPrimitiveValueSchema>>>;
    readonly result?: z.input<typeof workflowResultSchema>;
    readonly patch?: z.input<typeof workflowPatchSchema>;
    readonly when?: z.input<typeof workflowConditionSchema>;
    readonly cycle?: {
      readonly id: string;
      readonly role: 'review' | 'consolidate';
      readonly iteration: number;
    };
    readonly verdictPolicy?: {
      readonly approved?: 'continue';
      readonly changesRequested?: { readonly retryFrom: string; readonly maxIterations: number };
      readonly blocked?: 'stop';
    };
    readonly artifact?: string;
  }[];
  readonly now: string;
}): RunState {
  const stepIds = input.steps.map((step) => step.id);
  if (new Set(stepIds).size !== stepIds.length) {
    throw new Error('Run steps must have unique IDs');
  }
  return runStateSchema.parse({
    version: 1,
    id: input.id,
    ...(input.request ? { request: input.request } : {}),
    ...(input.repositoryDirectory ? { repositoryDirectory: input.repositoryDirectory } : {}),
    ...(input.parameters ? { parameters: input.parameters } : {}),
    workflow: {
      id: input.workflowId,
      sha256: input.workflowSha256,
      ...(input.workflowDefinitions ? { definitions: input.workflowDefinitions } : {}),
      successors: Object.fromEntries(
        input.steps.map((step, index) => [
          step.id,
          index + 1 < input.steps.length ? [input.steps[index + 1].id] : [],
        ]),
      ),
    },
    roles: input.roles,
    resolvedActors: input.resolvedActors ?? {},
    documentation: input.documentation,
    execution: input.execution ?? { agentTimeoutSeconds: 1_800 },
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
      if (step.kind === 'host-handoff') {
        if (!step.output || !step.inputs || !step.sideEffects) {
          throw new Error(`Host handoff ${step.id} requires inputs, output and sideEffects`);
        }
        const interactive = step.interaction === 'user-dialog';
        const hasPrompt = Boolean(step.promptFile && step.prompt);
        if (interactive === hasPrompt || (interactive && (!step.actor || !step.method))) {
          throw new Error(`Host handoff ${step.id} requires exactly one promptFile/prompt pair or interactive actor/method`);
        }
        return {
          id: step.id,
          kind: 'host-handoff' as const,
          status: 'pending' as const,
          ...(interactive
            ? { actor: step.actor, method: step.method, interaction: step.interaction }
            : { promptFile: step.promptFile, prompt: step.prompt }),
          inputArtifactIds: step.inputs,
          declaredOutput: step.output,
          sideEffects: step.sideEffects,
          attempts: [],
        };
      }
      if (!step.actor || !step.output) {
        throw new Error(`Agent ${step.id} requires an actor and declared output`);
      }
      const method = step.method ?? (step.action
        ? { action: step.action }
        : step.promptFile && step.prompt
          ? { promptFile: step.promptFile, content: step.prompt }
          : undefined);
      if (!method || (step.action && step.promptFile)) {
        throw new Error(`Agent ${step.id} requires exactly one action or promptFile`);
      }
      return {
        id: step.id,
        kind: 'agent' as const,
        status: 'pending' as const,
        actor: step.actor,
        executionAuthorization: step.executionAuthorization ?? 'explicit',
        method,
        declaredOutput: step.output,
        ...(step.effectiveParameters ? { effectiveParameters: step.effectiveParameters } : {}),
        ...(step.result ? { declaredResult: step.result } : {}),
        ...(step.patch ? { patch: step.patch } : {}),
        ...(step.when ? { when: step.when } : {}),
        ...(step.cycle ? { cycle: step.cycle } : {}),
        ...(step.verdictPolicy ? { verdictPolicy: step.verdictPolicy } : {}),
        attempts: [],
      };
    }),
    createdAt: input.now,
    updatedAt: input.now,
  });
}
