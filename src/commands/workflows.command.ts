import { Inject, Injectable } from '@nestjs/common';
import { Command, CommandRunner } from 'nest-commander';
import { WorkflowRegistryService } from '../workflows/workflow-registry.service';

export const WORKFLOWS_WRITER = Symbol('WORKFLOWS_WRITER');

@Injectable()
@Command({
  name: 'workflows',
  description: 'List available workflow definitions after repository, global, and package precedence.',
})
export class WorkflowsCommand extends CommandRunner {
  constructor(
    private readonly workflows: WorkflowRegistryService,
    @Inject(WORKFLOWS_WRITER) private readonly write: (line: string) => void = (line) => process.stdout.write(line),
  ) { super(); }

  async run(): Promise<void> {
    const workflows = this.workflows.list();
    if (workflows.length === 0) {
      this.write('No workflow definitions found.\n');
      return;
    }
    this.write([
      'ID\tNAME\tSOURCE',
      ...workflows.map((workflow) => `${workflow.workflow.id}\t${workflow.workflow.name}\t${workflow.source}`),
      '',
    ].join('\n'));
  }
}
