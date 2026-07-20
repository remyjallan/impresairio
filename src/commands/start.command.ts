import { Inject, Injectable } from '@nestjs/common';
import { Command, CommandRunner, Option } from 'nest-commander';
import { RunService } from '../runs/run.service';

export const START_WRITER = Symbol('START_WRITER');

interface StartOptions {
  readonly launcher?: string;
  readonly adversary?: string;
  readonly implementer?: string;
  readonly runId?: string;
  readonly documentationRoot?: string;
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
      documentationRoot: options.documentationRoot ?? '.',
    });
    this.write(`${state.id}\n`);
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

  @Option({ flags: '--documentation-root <path>', description: 'Resolved documentation root.' })
  parseDocumentationRoot(value: string): string {
    return value;
  }

  private roles(options: StartOptions): Record<string, string> {
    const roles: Record<string, string> = {};
    for (const [role, profile] of Object.entries({
      launcher: options.launcher,
      adversary: options.adversary,
      implementer: options.implementer,
    })) {
      if (profile !== undefined) {
        roles[role] = profile;
      }
    }
    return roles;
  }
}
