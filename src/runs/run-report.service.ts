import { Inject, Injectable } from '@nestjs/common';
import { EventLogService, type RunEvent } from './event-log.service';
import { FileStateStore, RunStateError } from './file-state.store';
import type { RunState } from './run-state.schema';

interface ReportAttempt {
  readonly number: number;
  readonly durationMs?: number;
  readonly outcome: 'complete' | 'failed' | 'in-progress' | 'unavailable';
}

export interface RunReport {
  readonly run: {
    readonly id: string;
    readonly workflow: string;
    readonly status: 'complete' | 'in-progress' | 'failed' | 'blocked';
    readonly startedAt: string;
    readonly endedAt?: string;
    readonly durationMs: number;
  };
  readonly agentSteps: readonly {
    readonly id: string;
    readonly status: string;
    readonly provider: string;
    readonly profile: string;
    readonly model?: string;
    readonly reasoningEffort?: string;
    readonly attempts: readonly ReportAttempt[];
    readonly durationMs?: number;
  }[];
  readonly gates: readonly {
    readonly id: string;
    readonly status: string;
    readonly reachedAt?: string;
    readonly waitMs?: number;
  }[];
  readonly recovery: {
    readonly providerFailures: number;
    readonly technicalRetries: number;
    readonly fallbacks: number;
    readonly productChangeRequests: number;
  };
  readonly availability: readonly string[];
}

export const REPORT_CLOCK = Symbol('REPORT_CLOCK');

@Injectable()
export class RunReportService {
  constructor(
    @Inject(FileStateStore) private readonly stateStore: FileStateStore,
    @Inject(EventLogService) private readonly events: EventLogService,
    @Inject(REPORT_CLOCK) private readonly now: () => Date = () => new Date(),
  ) {}

  create(runId: string): RunReport {
    const state = this.stateStore.findState(runId);
    if (!state) throw new RunStateError(`Run not found: ${runId}`);
    const events = this.events.read(runId);
    const startedAt = firstEventAt(events, 'run.started') ?? state.createdAt;
    const runStatus = reportStatus(state);
    const endedAt = runStatus === 'in-progress' ? undefined : latestEventAt(events) ?? state.updatedAt;
    const reportEnd = endedAt ?? this.now().toISOString();
    const availability: string[] = [];
    const agentSteps = state.steps.flatMap((step) => {
      if (step.kind !== 'agent') return [];
      const actor = step.agentOverride ?? state.resolvedActors[step.actor];
      if (!actor) {
        availability.push(`agent ${step.id}: actor profile is unavailable`);
        return [];
      }
      const attempts = step.attempts.map((attempt) => attemptReport(
        attempt,
        step.id,
        events,
        reportEnd,
        runStatus,
      ));
      const unavailable = attempts.some((attempt) => attempt.durationMs === undefined);
      if (unavailable) availability.push(`agent ${step.id}: one or more attempt durations are unavailable`);
      const durationMs = unavailable ? undefined : attempts.reduce((total, attempt) => total + (attempt.durationMs ?? 0), 0);
      return [{
        id: step.id,
        status: step.status,
        provider: actor.provider,
        profile: actor.profile,
        ...(actor.model ? { model: actor.model } : {}),
        ...('reasoningEffort' in actor && actor.reasoningEffort ? { reasoningEffort: actor.reasoningEffort } : {}),
        attempts,
        ...(durationMs === undefined ? {} : { durationMs }),
      }];
    });
    const gates = state.steps.flatMap((step) => {
      if (step.kind !== 'gate') return [];
      const reachedAt = step.reachedAt ?? lastGateReachedAt(events, step.id);
      if (!reachedAt) {
        availability.push(`gate ${step.id}: wait duration is unavailable (run predates gate.reached)`);
        return [{ id: step.id, status: step.status }];
      }
      const resolvedAt = firstGateResolutionAt(events, step.id, reachedAt);
      return [{
        id: step.id,
        status: step.status,
        reachedAt,
        waitMs: durationBetween(reachedAt, resolvedAt ?? reportEnd),
      }];
    });
    return {
      run: {
        id: state.id,
        workflow: state.workflow.id,
        status: runStatus,
        startedAt,
        ...(endedAt ? { endedAt } : {}),
        durationMs: durationBetween(startedAt, reportEnd),
      },
      agentSteps,
      gates,
      recovery: {
        providerFailures: events.filter((event) => event.type === 'agent.execution.failed').length,
        technicalRetries: events.filter((event) => event.type === 'step.retry_requested').length,
        fallbacks: events.filter((event) => event.type === 'agent.fallback.selected').length,
        productChangeRequests: productChangeRequests(state, events),
      },
      availability,
    };
  }
}

export function formatRunReport(report: RunReport): string {
  return [
    `Run: ${report.run.id} (${report.run.workflow})`,
    `Status: ${report.run.status}`,
    `Duration: ${formatDuration(report.run.durationMs)}`,
    '',
    'Agent steps',
    ...(report.agentSteps.length === 0 ? ['- none'] : report.agentSteps.map((step) => {
      const agent = `${step.profile} / ${step.provider}${step.model ? ` / ${step.model}` : ''}${step.reasoningEffort ? ` / effort=${step.reasoningEffort}` : ''}`;
      const duration = step.durationMs === undefined ? 'unavailable' : formatDuration(step.durationMs);
      return `- ${step.id}: ${agent}; ${duration}; ${step.status}; attempts: ${step.attempts.length}`;
    })),
    '',
    'Human gates',
    ...(report.gates.length === 0 ? ['- none'] : report.gates.map((gate) => `- ${gate.id}: ${gate.waitMs === undefined ? 'unavailable' : formatDuration(gate.waitMs)} waiting; ${gate.status}`)),
    '',
    'Recovery',
    `- provider failures: ${report.recovery.providerFailures}`,
    `- technical retries: ${report.recovery.technicalRetries}`,
    `- fallbacks: ${report.recovery.fallbacks}`,
    `- product change requests: ${report.recovery.productChangeRequests}`,
    ...(report.availability.length > 0 ? ['', 'Availability', ...report.availability.map((item) => `- ${item}`)] : []),
    '',
  ].join('\n');
}

function attemptReport(
  attempt: { readonly number: number; readonly startedAt: string; readonly completedAt?: string },
  stepId: string,
  events: readonly RunEvent[],
  reportEnd: string,
  runStatus: RunReport['run']['status'],
): ReportAttempt {
  if (attempt.completedAt) {
    return { number: attempt.number, durationMs: durationBetween(attempt.startedAt, attempt.completedAt), outcome: 'complete' };
  }
  const failedAt = firstEventAt(events, 'step.failed', stepId, attempt.startedAt);
  if (failedAt) {
    return { number: attempt.number, durationMs: durationBetween(attempt.startedAt, failedAt), outcome: 'failed' };
  }
  if (runStatus === 'in-progress') {
    return { number: attempt.number, durationMs: durationBetween(attempt.startedAt, reportEnd), outcome: 'in-progress' };
  }
  return { number: attempt.number, outcome: 'unavailable' };
}

function reportStatus(state: RunState): RunReport['run']['status'] {
  if (state.steps.some((step) => step.status === 'failed')) return 'failed';
  if (state.steps.some((step) => step.kind === 'agent'
    && step.reviewOutcome
    && (step.reviewOutcome.verdict === 'BLOCKED' || step.reviewOutcome.exhausted)
    && !step.acknowledgment)) return 'blocked';
  if (state.steps.every((step) => step.status === 'complete' || step.status === 'skipped')) return 'complete';
  return 'in-progress';
}

function firstEventAt(events: readonly RunEvent[], type: string, stepId?: string, notBefore?: string): string | undefined {
  const threshold = notBefore ? Date.parse(notBefore) : Number.NEGATIVE_INFINITY;
  return events.find((event) => event.type === type
    && (stepId === undefined || event.stepId === stepId)
    && Date.parse(event.at) >= threshold)?.at;
}

function firstGateResolutionAt(events: readonly RunEvent[], gateId: string, reachedAt: string): string | undefined {
  const threshold = Date.parse(reachedAt);
  return events.find((event) => (event.type === 'gate.approved' || event.type === 'gate.changes_requested')
    && event.gateId === gateId && Date.parse(event.at) >= threshold)?.at;
}

function lastGateReachedAt(events: readonly RunEvent[], gateId: string): string | undefined {
  return events.filter((event) => event.type === 'gate.reached' && event.gateId === gateId).at(-1)?.at;
}

function latestEventAt(events: readonly RunEvent[]): string | undefined {
  return events.reduce<string | undefined>((latest, event) => (
    !latest || event.at > latest ? event.at : latest
  ), undefined);
}

function productChangeRequests(state: RunState, events: readonly RunEvent[]): number {
  const gateRequests = events.filter((event) => event.type === 'gate.changes_requested').length;
  const policyRequests = events.filter((event) => event.type === 'verdict.changes_requested').length;
  const cycleRequests = state.steps.filter((step) => step.kind === 'agent'
    && step.cycle?.role === 'review'
    && step.reviewOutcome?.verdict === 'CHANGES_REQUESTED').length;
  return gateRequests + policyRequests + cycleRequests;
}

function durationBetween(start: string, end: string): number {
  return Math.max(0, Date.parse(end) - Date.parse(start));
}

export function formatDuration(durationMs: number): string {
  const seconds = Math.floor(durationMs / 1_000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}
