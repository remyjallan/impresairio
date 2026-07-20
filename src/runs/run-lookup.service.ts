import { Injectable } from '@nestjs/common';
import type {
  CompletionEvent,
  CompletionRecord,
  CompletionRun,
  CompletionRunStore,
} from './completion.service';

export interface RunSummary {
  readonly id: string;
}

@Injectable()
export class RunLookupService implements CompletionRunStore {
  findById(_runId: string): RunSummary | undefined {
    return undefined;
  }

  find(_runId: string): CompletionRun | undefined {
    return undefined;
  }

  recordCompletion(_runId: string, _completion: CompletionRecord): void {
    // Task 4 persists this through the run state store. Task 3 exposes the
    // narrow port now so complete can be tested without inventing persistence.
  }

  appendEvent(_runId: string, _event: CompletionEvent): void {
    // Task 4 owns the durable JSONL event log.
  }
}
