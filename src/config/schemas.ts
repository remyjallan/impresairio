import { isAbsolute, win32 } from 'node:path';
import { z } from 'zod';

const nonEmptyString = z.string().trim().min(1);

const absoluteFilesystemPath = nonEmptyString.refine(
  (value) => isAbsolute(value) || win32.isAbsolute(value),
  'must be an absolute filesystem path',
);

const filesystemDocumentationTargetSchema = z
  .object({
    kind: z.literal('filesystem'),
    root: absoluteFilesystemPath,
    defaultFormat: z.literal('markdown'),
  })
  .strict();

const claudeCodeProfileSchema = z
  .object({
    provider: z.literal('claude-code'),
  })
  .strict();

const codexProfileSchema = z
  .object({
    provider: z.literal('codex'),
  })
  .strict();

const openCodeProfileSchema = z
  .object({
    provider: z.literal('opencode'),
    modelAlias: nonEmptyString,
  })
  .strict();

export const globalConfigSchema = z
  .object({
    documentationTargets: z.record(
      nonEmptyString,
      filesystemDocumentationTargetSchema,
    ),
    agentProfiles: z.record(
      nonEmptyString,
      z.discriminatedUnion('provider', [
        claudeCodeProfileSchema,
        codexProfileSchema,
        openCodeProfileSchema,
      ]),
    ),
    models: z.record(nonEmptyString, nonEmptyString).default({}),
  })
  .strict();

export const repositoryConfigSchema = z
  .object({
    project: z
      .object({
        name: nonEmptyString,
        slug: z.string().regex(/^[a-z0-9]+(?:[-_][a-z0-9]+)*$/, {
          error: 'must use lowercase letters, numbers, hyphens or underscores',
        }),
      })
      .strict(),
    documentation: z
      .object({
        target: nonEmptyString,
        featurePath: nonEmptyString,
        format: z.literal('markdown'),
      })
      .strict(),
  })
  .strict();

export type GlobalConfig = z.infer<typeof globalConfigSchema>;
export type RepositoryConfig = z.infer<typeof repositoryConfigSchema>;
export type DocumentationTargetConfig = GlobalConfig['documentationTargets'][string];
export type AgentProfileConfig = GlobalConfig['agentProfiles'][string];
