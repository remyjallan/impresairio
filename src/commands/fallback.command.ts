import { Injectable } from '@nestjs/common';
import { Command, CommandRunner, Option } from 'nest-commander';
import { AgentFallbackService } from '../agents/agent-fallback.service';

interface FallbackOptions {
  readonly profile?: string;
  readonly reason?: string;
}

@Injectable()
@Command({
  name: 'fallback',
  arguments: '<run-id> <step-id>',
  description: 'Explicitly retry a failed step using one of its frozen configured fallback profiles.',
})
export class FallbackCommand extends CommandRunner {
  constructor(private readonly fallbacks: AgentFallbackService) { super(); }

  async run([runId, stepId]: string[], options: FallbackOptions): Promise<void> {
    if (!options.profile?.trim()) throw new Error('fallback requires --profile');
    if (!options.reason?.trim()) throw new Error('fallback requires --reason');
    this.fallbacks.select(runId, stepId, options.profile, options.reason);
  }

  @Option({ flags: '--profile <name>', description: 'One frozen fallback profile configured for the step actor.' })
  parseProfile(value: string): string { return value; }

  @Option({ flags: '--reason <text>', description: 'Required human justification recorded in the run event log.' })
  parseReason(value: string): string { return value; }
}
