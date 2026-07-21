import { Inject, Injectable } from '@nestjs/common';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HomeDirectoryResolver } from '../config/home-directory.resolver';
import { assertValidRunId } from './run-id';

export interface RunEvent {
  readonly type: string;
  readonly at: string;
  readonly [key: string]: unknown;
}

@Injectable()
export class EventLogService {
  constructor(
    @Inject(HomeDirectoryResolver)
    private readonly homeDirectoryResolver: HomeDirectoryResolver,
  ) {}

  append(runId: string, event: RunEvent): void {
    const directory = this.runDirectory(runId);
    mkdirSync(directory, { recursive: true });
    appendFileSync(join(directory, 'events.jsonl'), `${JSON.stringify(event)}\n`, 'utf8');
  }

  read(runId: string): RunEvent[] {
    const path = join(this.runDirectory(runId), 'events.jsonl');
    if (!existsSync(path)) {
      return [];
    }

    const content = readFileSync(path, 'utf8');
    const lines = content.split('\n');
    const hasTrailingNewline = content.endsWith('\n');
    const events: RunEvent[] = [];
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (line.length === 0) continue;
      try {
        events.push(JSON.parse(line) as RunEvent);
      } catch (error) {
        // A process can be interrupted while appending the final JSON line.
        // Keep the durable prefix readable, but never hide corruption in a
        // complete record or in the middle of the log.
        if (!hasTrailingNewline && index === lines.length - 1) break;
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`Invalid event log for run ${runId} at line ${index + 1}: ${detail}`, { cause: error });
      }
    }
    return events;
  }

  private runDirectory(runId: string): string {
    assertValidRunId(runId);
    return join(this.homeDirectoryResolver.resolve(), 'runs', runId);
  }
}
