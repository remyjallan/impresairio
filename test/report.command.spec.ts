import { describe, expect, it } from 'vitest';
import { ReportCommand } from '../src/commands/report.command';
import type { RunReport } from '../src/runs/run-report.service';

const report: RunReport = {
  run: {
    id: 'run-42', workflow: 'quick-fix', status: 'complete',
    startedAt: '2026-07-22T10:00:00.000Z', endedAt: '2026-07-22T10:01:00.000Z', durationMs: 60_000,
  },
  agentSteps: [], gates: [], hostHandoffs: [],
  recovery: { providerFailures: 0, technicalRetries: 0, fallbacks: 0, productChangeRequests: 0 },
  availability: [],
};

describe('ReportCommand', () => {
  it('writes a human-readable report by default', async () => {
    const output: string[] = [];
    const command = new ReportCommand({ create: () => report } as never, (line) => output.push(line));

    await command.run(['run-42'], {});

    expect(output).toEqual([expect.stringContaining('Run: run-42 (quick-fix)')]);
  });

  it('writes the same report shape as JSON on request', async () => {
    const output: string[] = [];
    const command = new ReportCommand({ create: () => report } as never, (line) => output.push(line));

    await command.run(['run-42'], { json: true });

    expect(JSON.parse(output[0] ?? '')).toEqual(report);
  });
});
