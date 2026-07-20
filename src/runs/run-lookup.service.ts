import { Injectable } from '@nestjs/common';

export interface RunSummary {
  readonly id: string;
}

@Injectable()
export class RunLookupService {
  findById(_runId: string): RunSummary | undefined {
    return undefined;
  }
}
