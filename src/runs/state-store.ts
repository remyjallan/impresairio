import type { RunState } from './run-state.schema';

export interface StateStore {
  create(state: RunState): void;
  findState(runId: string): RunState | undefined;
  save(state: RunState): void;
}

export const STATE_STORE = Symbol('STATE_STORE');
