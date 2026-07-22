import { Inject, Injectable, Optional } from '@nestjs/common';
import { Command, CommandRunner } from 'nest-commander';
import { WorkflowRunnerService } from '../workflows/workflow-runner.service';
import { AgentDispatchService } from '../agents/agent-dispatch.service';
import { HostHandoffService } from '../agents/host-handoff.service';

export const NEXT_WRITER = Symbol('NEXT_WRITER');

@Injectable()
@Command({
  name: 'next',
  arguments: '<run-id>',
  description: 'Start the next agent step or report a waiting human gate.',
})
export class NextCommand extends CommandRunner {
  constructor(
    @Inject(WorkflowRunnerService)
    private readonly workflowRunner: WorkflowRunnerService,
    @Inject(AgentDispatchService)
    private readonly agentDispatch: AgentDispatchService,
    @Inject(NEXT_WRITER)
    private readonly write: (line: string) => void = (line) => process.stdout.write(line),
    @Optional() @Inject(HostHandoffService)
    private readonly hostHandoffs?: HostHandoffService,
  ) {
    super();
  }

  async run([runId]: string[]): Promise<void> {
    const result = this.workflowRunner.next(runId);
    const handoff = this.agentDispatch.prepare(runId, result);
    if (handoff) {
      this.write(`${JSON.stringify(handoff)}\n`);
      return;
    }
    const hostHandoff = this.hostHandoffs?.prepare(runId, result);
    if (hostHandoff) {
      this.write(`${JSON.stringify(hostHandoff)}\n`);
      return;
    }
    if (result.kind === 'complete') {
      this.write('complete\n');
      return;
    }
    if (result.kind === 'gate') {
      for (const warning of result.warnings ?? []) this.write(`warning: ${warning}\n`);
    }
    if (result.kind === 'blocked') {
      for (const warning of result.warnings) this.write(`warning: ${warning}\n`);
    }
    this.write(`${result.kind}: ${result.stepId}\n`);
  }
}
