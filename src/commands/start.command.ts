import { Inject, Injectable } from '@nestjs/common';
import { Command, CommandRunner, Option } from 'nest-commander';
import { RunService } from '../runs/run.service';
import { parseParameterAssignments } from '../workflows/workflow-parameters';

export const START_WRITER = Symbol('START_WRITER');

interface StartOptions {
  readonly actor?: string[];
  readonly launcher?: string;
  readonly adversary?: string;
  readonly implementer?: string;
  readonly runId?: string;
  readonly repository?: string;
  readonly featureId?: string;
  readonly featureSlug?: string;
  readonly request?: string;
  readonly param?: string[];
}

@Injectable()
@Command({
  name: 'start',
  arguments: '<workflow-id>',
  description: 'Create a durable Impresairio workflow run.',
})
export class StartCommand extends CommandRunner {
  constructor(
    @Inject(RunService) private readonly runService: RunService,
    @Inject(START_WRITER)
    private readonly write: (line: string) => void = (line) => process.stdout.write(line),
  ) {
    super();
  }

  async run([workflowId]: string[], options: StartOptions): Promise<void> {
    const state = this.runService.start({
      id: options.runId,
      workflowId,
      roles: this.roles(options),
      feature: this.feature(options),
      request: this.request(options),
      parameters: this.parameters(options),
      repositoryDirectory: options.repository,
    });
    this.write(`${state.id}\n`);
  }

  @Option({ flags: '--actor <binding...>', description: 'Bind a workflow role to a profile, as <role>=<profile>. Repeatable.' })
  parseActor(value: string, previous: string[] = []): string[] {
    return [...previous, value];
  }

  @Option({ flags: '--launcher <profile>', description: 'Launcher agent profile.' })
  parseLauncher(value: string): string {
    return value;
  }

  @Option({ flags: '--adversary <profile>', description: 'Adversary agent profile.' })
  parseAdversary(value: string): string {
    return value;
  }

  @Option({ flags: '--implementer <profile>', description: 'Implementer agent profile.' })
  parseImplementer(value: string): string {
    return value;
  }

  @Option({ flags: '--run-id <id>', description: 'Explicit run identifier.' })
  parseRunId(value: string): string {
    return value;
  }

  @Option({ flags: '--repository <path>', description: 'Repository used to resolve workflow overrides.' })
  parseRepository(value: string): string {
    return value;
  }

  @Option({ flags: '--feature-id <id>', description: 'Feature identifier used by documentation bindings.' })
  parseFeatureId(value: string): string {
    return value;
  }

  @Option({ flags: '--feature-slug <slug>', description: 'Feature slug used by documentation bindings.' })
  parseFeatureSlug(value: string): string {
    return value;
  }

  @Option({ flags: '--request <text>', description: 'Work request frozen into the run and supplied to every agent step.' })
  parseRequest(value: string): string {
    return value;
  }

  @Option({ flags: '--param <name=value...>', description: 'Set a typed workflow parameter. Repeatable.' })
  parseParameter(value: string, previous: string[] = []): string[] {
    return [...previous, value];
  }

  private roles(options: StartOptions): Record<string, string> {
    const roles: Record<string, string> = {};
    const assign = (role: string, profile: string, source: string): void => {
      if (roles[role] !== undefined && roles[role] !== profile) {
        throw new Error(`Role "${role}" is bound twice (${source}); use a single binding`);
      }
      roles[role] = profile;
    };
    for (const binding of options.actor ?? []) {
      const separator = binding.indexOf('=');
      if (separator <= 0 || separator === binding.length - 1) {
        throw new Error(`--actor expects <role>=<profile>, received "${binding}"`);
      }
      assign(binding.slice(0, separator), binding.slice(separator + 1), '--actor');
    }
    for (const [role, profile] of Object.entries({
      launcher: options.launcher, adversary: options.adversary, implementer: options.implementer,
    })) {
      if (profile !== undefined) assign(role, profile, `--${role}`);
    }
    return roles;
  }

  private feature(options: StartOptions): { id: string; slug: string } {
    if (!options.featureId || !options.featureSlug) {
      throw new Error('start requires --feature-id and --feature-slug');
    }
    return { id: options.featureId, slug: options.featureSlug };
  }

  private request(options: StartOptions): string {
    if (!options.request?.trim()) {
      throw new Error('start requires --request');
    }
    return options.request;
  }

  private parameters(options: StartOptions): Record<string, string> {
    return parseParameterAssignments(options.param ?? []);
  }
}
