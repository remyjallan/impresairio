import { Inject, Injectable } from '@nestjs/common';
import { Command, CommandRunner } from 'nest-commander';
import { FileStateStore } from '../runs/file-state.store';
import { verdictWarnings } from '../workflows/verdict-completion.policy';

export const STATUS_WRITER = Symbol('STATUS_WRITER');

export class RunNotFoundError extends Error {
  constructor(runId: string) {
    super(`Run not found: ${runId}`);
    this.name = 'RunNotFoundError';
  }
}

@Injectable()
@Command({
  name: 'status',
  arguments: '<run-id>',
  description: 'Show the status of an Impresairio run.',
})
export class StatusCommand extends CommandRunner {
  constructor(
    @Inject(FileStateStore)
    private readonly stateStore: FileStateStore,
    @Inject(STATUS_WRITER)
    private readonly write: (line: string) => void = (line) => process.stdout.write(line),
  ) {
    super();
  }

  async run([runId]: string[]): Promise<void> {
    const run = this.stateStore.findState(runId);

    if (!run) {
      throw new RunNotFoundError(runId);
    }

    const abandonmentDetails = run.abandonment
      ? abandonedStatusDetails(run.abandonment)
      : [];
    this.write([
      `run: ${run.id}`,
      `workflow: ${run.workflow.id}`,
      ...abandonmentDetails,
      ...(run.parameters && Object.keys(run.parameters).length > 0
        ? [`parameters: ${JSON.stringify(run.parameters)}`]
        : []),
      `current-step: ${run.currentStepId ?? 'not-started'}`,
      `steps: ${run.steps.length}`,
      ...run.steps.map((step) => `${step.id}: ${step.status}${step.kind === 'agent' && step.conditionDecision ? ' (condition false)' : ''}${step.kind === 'agent' && step.agentOverride ? ` (fallback: ${step.agentOverride.profile})` : ''}`),
      ...verdictWarnings(run).map((warning) => `warning: ${warning}`),
      '',
    ].join('\n'));
  }
}

function abandonedStatusDetails(abandonment: { readonly at: string; readonly reason: string; readonly externalReference?: string }): string[] {
  return [
    'run-status: abandoned',
    `abandoned-at: ${abandonment.at}`,
    `abandon-reason: ${abandonment.reason}`,
    ...(abandonment.externalReference ? [`external-reference: ${abandonment.externalReference}`] : []),
  ];
}
