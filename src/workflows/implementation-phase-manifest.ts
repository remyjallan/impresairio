import { z } from 'zod';

const phaseIdentifier = z.string().regex(/^[a-z][a-z0-9-]*$/, {
  error: 'must use lowercase letters, numbers and hyphens, starting with a letter',
});

const phaseText = z.string().trim().min(1).max(1_000).refine(
  (value) => !value.includes('{{')
    && !value.includes('}}')
    && ![...value].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code <= 0x1f || code === 0x7f || code === 0x2028 || code === 0x2029;
    }),
  'must be plain text without dynamic expressions or control characters',
);

const implementationPhaseSchema = z.object({
  id: phaseIdentifier,
  objective: phaseText,
  scope: z.array(phaseText).min(1).max(12),
  dependsOn: z.array(phaseIdentifier).max(5).refine(
    (dependencies) => new Set(dependencies).size === dependencies.length,
    'must not contain duplicate phase IDs',
  ),
  verification: z.array(phaseText).min(1).max(8),
  retryBudget: z.number().int().min(0).max(2),
  gate: z.boolean().default(false),
}).strict();

export const implementationPhaseManifestSchema = z.object({
  phases: z.array(implementationPhaseSchema).min(1).max(6),
}).strict().superRefine((manifest, context) => {
  const knownIds = new Set<string>();
  manifest.phases.forEach((phase, phaseIndex) => {
    if (knownIds.has(phase.id)) {
      context.addIssue({
        code: 'custom', path: ['phases', phaseIndex, 'id'],
        message: `duplicate phase ID "${phase.id}"`,
      });
    }
    for (const [dependencyIndex, dependency] of phase.dependsOn.entries()) {
      if (!knownIds.has(dependency)) {
        context.addIssue({
          code: 'custom', path: ['phases', phaseIndex, 'dependsOn', dependencyIndex],
          message: 'must reference a preceding phase ID',
        });
      }
    }
    knownIds.add(phase.id);
  });
});

export type ImplementationPhaseManifest = z.infer<typeof implementationPhaseManifestSchema>;

export class ImplementationPhaseManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImplementationPhaseManifestError';
  }
}

const manifestBlockPattern = /```impresairio-phase-manifest[ \t]*\r?\n([\s\S]*?)\r?\n```/g;

/**
 * Parses a bounded, data-only phase plan from an approved planning artifact.
 * Materializing it into run steps is intentionally a separate, audited action.
 */
export function parseImplementationPhaseManifest(markdown: string): ImplementationPhaseManifest {
  const blocks = [...markdown.matchAll(manifestBlockPattern)];
  if (blocks.length !== 1) {
    throw new ImplementationPhaseManifestError(
      `Expected exactly one impresairio-phase-manifest block, found ${blocks.length}`,
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(blocks[0][1]);
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'invalid JSON';
    throw new ImplementationPhaseManifestError(`Invalid impresairio-phase-manifest JSON: ${detail}`);
  }
  const parsed = implementationPhaseManifestSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
  throw new ImplementationPhaseManifestError(`Invalid impresairio-phase-manifest at ${path}: ${issue.message}`);
}
