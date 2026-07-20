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

    return readFileSync(path, 'utf8')
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as RunEvent);
  }

  private runDirectory(runId: string): string {
    assertValidRunId(runId);
    return join(this.homeDirectoryResolver.resolve(), 'runs', runId);
  }
}
