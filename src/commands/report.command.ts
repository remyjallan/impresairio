import { Inject, Injectable } from '@nestjs/common';
import { Command, CommandRunner, Option } from 'nest-commander';
import { formatRunReport, RunReportService } from '../runs/run-report.service';

export const REPORT_WRITER = Symbol('REPORT_WRITER');

interface ReportOptions { readonly json?: boolean; }

@Injectable()
@Command({
  name: 'report',
  arguments: '<run-id>',
  description: 'Derive a read-only duration, recovery, and human-gate report from a durable run.',
})
export class ReportCommand extends CommandRunner {
  constructor(
    private readonly reports: RunReportService,
    @Inject(REPORT_WRITER) private readonly write: (line: string) => void,
  ) { super(); }

  async run([runId]: string[], options: ReportOptions): Promise<void> {
    const report = this.reports.create(runId);
    this.write(options.json ? `${JSON.stringify(report, null, 2)}\n` : formatRunReport(report));
  }

  @Option({ flags: '--json', description: 'Emit the same read-only report as JSON for scripts.' })
  parseJson(): boolean { return true; }
}
