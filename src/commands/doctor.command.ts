import { Inject, Injectable } from '@nestjs/common';
import { Command, CommandRunner, Option } from 'nest-commander';
import { AgentHealthService } from '../agents/agent-health.service';

export const DOCTOR_WRITER = Symbol('DOCTOR_WRITER');

interface DoctorOptions {
  readonly live?: boolean;
  readonly profile?: string[];
}

@Injectable()
@Command({
  name: 'doctor',
  description: 'Check configured agent CLIs; --live also sends a minimal model request.',
})
export class DoctorCommand extends CommandRunner {
  constructor(
    private readonly health: AgentHealthService,
    @Inject(DOCTOR_WRITER) private readonly write: (line: string) => void = (line) => process.stdout.write(line),
  ) { super(); }

  async run(_parameters: string[], options: DoctorOptions): Promise<void> {
    const results = this.health.check(process.cwd(), options.profile ?? [], options.live ?? false);
    for (const result of results) {
      const settings = [
        ...(result.model ? [`model=${result.model}`] : []),
        ...(result.reasoningEffort ? [`reasoningEffort=${result.reasoningEffort}`] : []),
      ];
      this.write(`${result.ok ? 'OK' : 'FAIL'}\t${result.profile}\t${result.provider}${settings.length > 0 ? ` (${settings.join(', ')})` : ''}\t${result.detail}\n`);
    }
    if (results.some((result) => !result.ok)) {
      throw new Error('One or more agent checks failed.');
    }
  }

  @Option({ flags: '-l, --live', description: 'Send a minimal request to each selected agent; this may consume provider credits.' })
  parseLive(): boolean { return true; }

  @Option({ flags: '-p, --profile <profile...>', description: 'Check only one or more configured profile names.' })
  parseProfile(value: string, previous: string[] = []): string[] { return [...previous, value]; }
}
