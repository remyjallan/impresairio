import { Injectable } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse, YAMLParseError } from 'yaml';
import { z } from 'zod';
import { HomeDirectoryResolver } from './home-directory.resolver';
import {
  type AgentProfileConfig,
  type DocumentationTargetConfig,
  globalConfigSchema,
  repositoryConfigSchema,
} from './schemas';

export class ConfigurationError extends Error {
  constructor(
    readonly source: string,
    readonly field: string,
    message: string,
  ) {
    super(`${source}: ${field}: ${message}`);
    this.name = 'ConfigurationError';
  }
}

export interface ResolvedDocumentationTarget extends DocumentationTargetConfig {
  readonly name: string;
}

export type ResolvedAgentProfile =
  | {
      readonly provider: 'claude-code' | 'codex';
      readonly modelAlias?: undefined;
      readonly model?: undefined;
    }
  | {
      readonly provider: 'opencode';
      readonly modelAlias: string;
      readonly model: string;
    };

export interface LoadedConfiguration {
  readonly homeDirectory: string;
  readonly globalConfigPath: string;
  readonly repositoryConfigPath: string;
  readonly project: {
    readonly name: string;
    readonly slug: string;
  };
  readonly documentation: {
    readonly target: ResolvedDocumentationTarget;
    readonly featurePath: string;
    readonly format: 'markdown';
  };
  readonly agentProfiles: Readonly<Record<string, ResolvedAgentProfile>>;
  readonly models: Readonly<Record<string, string>>;
}

@Injectable()
export class ConfigService {
  constructor(private readonly homeDirectoryResolver: HomeDirectoryResolver) {}

  load(repositoryDirectory: string): LoadedConfiguration {
    const homeDirectory = this.homeDirectoryResolver.resolve();
    const globalConfigPath = join(homeDirectory, 'config.yaml');
    const repositoryConfigPath = join(
      resolve(repositoryDirectory),
      '.impresairio.yaml',
    );
    const globalConfig = this.readAndValidate(
      globalConfigPath,
      globalConfigSchema,
    );
    const repositoryConfig = this.readAndValidate(
      repositoryConfigPath,
      repositoryConfigSchema,
    );
    const targetName = repositoryConfig.documentation.target;
    const target = Object.hasOwn(globalConfig.documentationTargets, targetName)
      ? globalConfig.documentationTargets[targetName]
      : undefined;

    if (!target) {
      throw new ConfigurationError(
        repositoryConfigPath,
        'documentation.target',
        `references unknown documentation target "${repositoryConfig.documentation.target}"`,
      );
    }

    return {
      homeDirectory,
      globalConfigPath,
      repositoryConfigPath,
      project: repositoryConfig.project,
      documentation: {
        target: {
          name: targetName,
          ...target,
        },
        featurePath: repositoryConfig.documentation.featurePath,
        format: repositoryConfig.documentation.format,
      },
      agentProfiles: this.resolveAgentProfiles(
        globalConfig.agentProfiles,
        globalConfig.models,
        globalConfigPath,
      ),
      models: globalConfig.models,
    };
  }

  private resolveAgentProfiles(
    profiles: Readonly<Record<string, AgentProfileConfig>>,
    models: Readonly<Record<string, string>>,
    source: string,
  ): Readonly<Record<string, ResolvedAgentProfile>> {
    return Object.fromEntries(
      Object.entries(profiles).map(([name, profile]) => [
        name,
        this.resolveAgentProfile(name, profile, models, source),
      ]),
    );
  }

  private resolveAgentProfile(
    name: string,
    profile: AgentProfileConfig,
    models: Readonly<Record<string, string>>,
    source: string,
  ): ResolvedAgentProfile {
    if (profile.provider !== 'opencode') {
      return { provider: profile.provider };
    }

    const model = Object.hasOwn(models, profile.modelAlias)
      ? models[profile.modelAlias]
      : undefined;
    if (!model) {
      throw new ConfigurationError(
        source,
        `agentProfiles.${name}.modelAlias`,
        `references unknown model alias "${profile.modelAlias}"`,
      );
    }

    return {
      provider: 'opencode',
      modelAlias: profile.modelAlias,
      model,
    };
  }

  private readAndValidate<T extends z.ZodType>(
    source: string,
    schema: T,
  ): z.output<T> {
    let parsed: unknown;

    try {
      parsed = parse(readFileSync(source, 'utf8'));
    } catch (error) {
      if (error instanceof YAMLParseError) {
        throw new ConfigurationError(source, '(yaml)', error.message);
      }

      if (error instanceof Error) {
        throw new ConfigurationError(source, '(file)', error.message);
      }

      throw error;
    }

    const result = schema.safeParse(parsed);
    if (!result.success) {
      const issue = result.error.issues[0];
      const field = issue.path.length > 0 ? issue.path.join('.') : '(root)';
      throw new ConfigurationError(source, field, issue.message);
    }

    return result.data;
  }
}
