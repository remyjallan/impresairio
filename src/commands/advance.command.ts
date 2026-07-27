import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { Command, CommandRunner, Option } from 'nest-commander';
import { AgentDispatchService } from '../agents/agent-dispatch.service';
import { HostHandoffService } from '../agents/host-handoff.service';
import { agentSettingsForEvent, type PreparedAgentInvocation } from '../agents/agent-provider';
import { CompletionService } from '../runs/completion.service';
import { EventLogService } from '../runs/event-log.service';
import { WorkflowRunnerService } from '../workflows/workflow-runner.service';
import { FileStateStore } from '../runs/file-state.store';
import { ArtifactService } from '../documentation/artifact.service';
import { RunLockService } from '../runs/run-lock.service';
import { describeOpenCodeRunOutput, readOpenCodeRunOutput } from '../agents/opencode.provider';

const MAX_AGENT_OUTPUT_BYTES = 16 * 1024 * 1024;
const MAX_DIAGNOSTIC_CHARS = 1_000;
const HEARTBEAT_INTERVAL_MS = 30_000;

export const ADVANCE_PROGRESS_WRITER = Symbol('ADVANCE_PROGRESS_WRITER');
export const ADVANCE_HEARTBEAT_INTERVAL_MS = Symbol('ADVANCE_HEARTBEAT_INTERVAL_MS');
export const ADVANCE_DETACHED_ENTRYPOINT = Symbol('ADVANCE_DETACHED_ENTRYPOINT');

interface AdvanceOptions {
  readonly onlyPreAuthorized?: boolean;
  readonly untilGate?: boolean;
  readonly detach?: boolean;
}

export interface AgentExecution {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly timedOut: boolean;
  readonly outputLimitExceeded: boolean;
  readonly durationMs: number;
  readonly spawnError?: Error;
}

export class ProviderExecutionError extends Error {
  constructor(
    message: string,
    readonly diagnostic: {
      readonly command: string;
      readonly exitCode: number | null;
      readonly signal: NodeJS.Signals | null;
      readonly timedOut: boolean;
      readonly outputLimitExceeded: boolean;
      readonly stderr: string;
      readonly stdout: string;
    },
  ) {
    super(message);
    this.name = 'ProviderExecutionError';
  }
}

@Injectable()
@Command({ name: 'advance', arguments: '<run-id>', description: 'Execute pre-authorized work and at most one explicitly authorized agent step.' })
export class AdvanceCommand extends CommandRunner {
  constructor(
    private readonly workflow: WorkflowRunnerService,
    private readonly dispatch: AgentDispatchService,
    private readonly completion: CompletionService,
    private readonly stateStore: FileStateStore,
    private readonly artifacts: ArtifactService,
    private readonly locks: RunLockService,
    private readonly events: EventLogService,
    @Inject(ADVANCE_PROGRESS_WRITER) private readonly writeProgress: (line: string) => void,
    @Optional() @Inject(HostHandoffService) private readonly hostHandoffs?: HostHandoffService,
    @Optional() @Inject(ADVANCE_HEARTBEAT_INTERVAL_MS) private readonly heartbeatIntervalMs = HEARTBEAT_INTERVAL_MS,
    @Optional() @Inject(ADVANCE_DETACHED_ENTRYPOINT) private readonly detachedEntrypoint = process.argv[1] ?? '',
  ) { super(); }

  async run([runId]: string[], options: AdvanceOptions = {}): Promise<void> {
    if (options.detach) {
      if (!this.detachedEntrypoint) throw new Error('advance --detach requires a Node CLI entrypoint');
      const release = this.locks.acquireReentrant(runId, 'advance.detach');
      try {
        const child = spawn(process.execPath, detachedAdvanceArguments(runId, options, this.detachedEntrypoint), {
          cwd: process.cwd(), detached: true, stdio: 'ignore',
        });
        child.unref();
        if (!child.pid) throw new Error('Unable to start detached advance process');
        this.events.append(runId, { type: 'advance.detached', at: new Date().toISOString(), pid: child.pid });
        process.stdout.write(`detached: ${child.pid}\n`);
      } finally {
        release();
      }
      return;
    }
    const release = this.locks.acquireReentrant(runId, 'advance');
    let activeStepId: string | undefined;
    let activeHandoff: ReturnType<AgentDispatchService['prepare']> | undefined;
    let failedAgentOutput: string | undefined;
    try {
      for (;;) {
        const result = this.workflow.next(runId);
        if (result.kind === 'gate') {
          for (const warning of result.warnings ?? []) process.stdout.write(`warning: ${warning}\n`);
          process.stdout.write(`gate: ${result.stepId}\n`);
          return;
        }
        if (result.kind === 'complete') { process.stdout.write('complete\n'); return; }
        if (result.kind === 'blocked') {
          for (const warning of result.warnings) process.stdout.write(`warning: ${warning}\n`);
          process.stdout.write(`blocked: ${result.stepId}\n`);
          return;
        }
        if (result.kind === 'host-handoff') {
          const handoff = this.hostHandoffs?.prepare(runId, result);
          if (!handoff) throw new Error(`No host handoff for ${result.stepId}`);
          process.stdout.write(`${JSON.stringify(handoff)}\n`);
          return;
        }
        if (result.kind === 'external-agent-output') {
          process.stdout.write(`external-agent-output: ${result.stepId}\n`);
          return;
        }
        if (result.kind === 'phase-manifest') {
          this.writeProgress(`phase-manifest: ${result.stepId} materialized\n`);
          continue;
        }
        activeStepId = result.stepId;
        const handoff = this.dispatch.prepare(runId, result);
        if (options.onlyPreAuthorized && handoff?.executionAuthorization !== 'pre-authorized') {
          activeStepId = undefined;
          process.stdout.write(`explicit-authorization-required: ${result.stepId}\n`);
          return;
        }
        activeHandoff = handoff;
        if (!handoff?.invocation) throw new Error(`No executable invocation for ${result.stepId}`);
        const runDirectory = this.stateStore.runDirectory(runId);
        if (isInternalArtifact(runDirectory, handoff.expectedOutput.path)
          && existsSync(handoff.expectedOutput.path)
          && readFileSync(handoff.expectedOutput.path, 'utf8').trim().length > 0) {
          this.writeProgress(`step: ${result.stepId} reusing existing internal artifact\n`);
          this.completion.complete(runId, result.stepId);
          activeStepId = undefined;
          continue;
        }
        const stagingPath = join(runDirectory, 'staging', result.stepId, 'artifact.md');
        mkdirSync(dirname(stagingPath), { recursive: true });
        rmSync(stagingPath, { force: true });
        const invocation = prepareExecutionInvocation(handoff.invocation, handoff.expectedOutput.path, stagingPath);
        const currentRun = this.stateStore.findState(runId);
        if (!currentRun) throw new Error(`Run not found while executing ${result.stepId}: ${runId}`);
        this.writeProgress(`${formatAgentProgress('started', result.stepId, handoff)}\n`);
        this.events.append(runId, {
          type: 'agent.execution.started', at: new Date().toISOString(), stepId: result.stepId,
          actor: handoff.actor, profile: handoff.profile, provider: handoff.provider,
          authorization: handoff.executionAuthorization,
          ...agentSettingsForEvent(handoff.invocation),
        });
        const child = await executeAgentProcess(invocation, {
          cwd: executionDirectory(currentRun.repositoryDirectory),
          timeoutMs: currentRun.execution.agentTimeoutSeconds * 1_000,
          heartbeatIntervalMs: this.heartbeatIntervalMs,
          onHeartbeat: (elapsedMs) => {
            this.writeProgress(`${formatAgentProgress('running', result.stepId, handoff, elapsedMs)}\n`);
            this.events.append(runId, {
              type: 'agent.execution.progress', at: new Date().toISOString(), stepId: result.stepId,
              elapsedSeconds: Math.max(1, Math.floor(elapsedMs / 1_000)),
            });
          },
        });
        failedAgentOutput = child.stdout || child.stderr || undefined;
        if (child.spawnError) throw createProviderExecutionError(invocation.command, result.stepId, child);
        // Claude can finish generating a structured answer then fail only
        // because it attempted an unnecessary Write tool call. Preserve that
        // complete answer when it is present; other non-zero exits remain failures.
        const recoveredContent = child.exitCode !== 0
          ? extractDeniedWriteContent(child.stderr || child.stdout, stagingPath)
          : undefined;
        const openCodeOutput = handoff.provider === 'opencode'
          ? readOpenCodeRunOutput(child.stdout)
          : undefined;
        if ((child.exitCode !== 0 || child.timedOut || child.outputLimitExceeded) && !recoveredContent) {
          throw createProviderExecutionError(
            invocation.command,
            result.stepId,
            child,
            openCodeOutput && openCodeOutput.kind !== 'text'
              ? describeOpenCodeRunOutput(openCodeOutput)
              : undefined,
          );
        }
        const content = existsSync(stagingPath) && readFileSync(stagingPath, 'utf8').trim().length > 0
          ? readFileSync(stagingPath, 'utf8')
          : recoveredContent ?? (openCodeOutput
            ? (openCodeOutput.kind === 'text' ? openCodeOutput.content : '')
            : extractContent(child.stdout));
        // Staging is only a transport location. It must satisfy the same
        // completeness contract as stdout before the runner publishes it.
        const completeContent = extractCompleteArtifact(content);
        failedAgentOutput = completeContent || failedAgentOutput;
        if (!completeContent.trim()) throw createProviderExecutionError(
          invocation.command,
          result.stepId,
          child,
          openCodeOutput ? describeOpenCodeRunOutput(openCodeOutput) : 'returned no artifact content',
        );
        const current = this.stateStore.findState(runId);
        const step = current?.steps.find((candidate) => candidate.id === result.stepId);
        if (!step || step.kind !== 'agent' || !step.expectedOutput) {
          throw new Error(`Step ${result.stepId} has no resolved output to publish`);
        }
        this.artifacts.publishMarkdown(step.expectedOutput, completeContent.endsWith('\n') ? completeContent : `${completeContent}\n`);
        this.completion.complete(runId, result.stepId);
        this.writeProgress(`${formatAgentProgress('completed', result.stepId, handoff, child.durationMs)}\n`);
        activeStepId = undefined;
        activeHandoff = undefined;
        if (handoff.executionAuthorization === 'explicit' && !options.untilGate) {
          process.stdout.write(`authorization-boundary: ${result.stepId}\n`);
          return;
        }
      }
    } catch (error) {
      if (activeStepId) {
        this.stateStore.markFailed(
          runId,
          activeStepId,
          error instanceof Error ? error.message : String(error),
          failedAgentOutput,
        );
      }
      if (activeStepId && error instanceof ProviderExecutionError) {
        this.events.append(runId, {
          type: 'agent.execution.failed', at: new Date().toISOString(), stepId: activeStepId,
          ...(activeHandoff ? {
            actor: activeHandoff.actor,
            profile: activeHandoff.profile,
            provider: activeHandoff.provider,
            ...agentSettingsForEvent(activeHandoff.invocation ?? {}),
          } : {}),
          ...error.diagnostic,
        });
        this.writeProgress(`step: ${activeStepId} failed (${error.message})\n`);
      }
      throw error;
    } finally {
      release();
    }
  }

  @Option({ flags: '--only-pre-authorized', description: 'Execute only steps frozen with execution.authorization: pre-authorized; stop before explicit steps.' })
  parseOnlyPreAuthorized(): boolean { return true; }

  @Option({ flags: '--until-gate', description: 'After this explicit operator invocation, continue through all agent steps until the next human gate, failure, or completion.' })
  parseUntilGate(): boolean { return true; }

  @Option({ flags: '--detach', description: 'Run advance in a detached local process; use follow <run-id> to observe durable progress.' })
  parseDetach(): boolean { return true; }

}

export function detachedAdvanceArguments(
  runId: string,
  options: Pick<AdvanceOptions, 'onlyPreAuthorized' | 'untilGate'>,
  entrypoint?: string,
): string[] {
  const resolvedEntrypoint = entrypoint ?? process.argv[1] ?? '';
  if (!resolvedEntrypoint) throw new Error('advance --detach requires a Node CLI entrypoint');
  return [
    resolvedEntrypoint, 'advance', runId,
    ...(options.onlyPreAuthorized ? ['--only-pre-authorized'] : []),
    ...(options.untilGate ? ['--until-gate'] : []),
  ];
}

export function createProviderExecutionError(
  command: string,
  stepId: string,
  execution: AgentExecution,
  suffix?: string,
): ProviderExecutionError {
  const failure = execution.timedOut
    ? `timed out after ${Math.ceil(execution.durationMs / 1_000)}s`
    : execution.outputLimitExceeded
      ? 'exceeded the output limit'
      : execution.spawnError
        ? `could not start: ${execution.spawnError.message}`
        : execution.signal
          ? `terminated by ${execution.signal}`
          : `exited with status ${execution.exitCode ?? 'unknown'}`;
  return new ProviderExecutionError(
    `${command} failed for ${stepId}: ${suffix ?? failure}; inspect the run event log for bounded diagnostics`,
    {
      command,
      exitCode: execution.exitCode,
      signal: execution.signal,
      timedOut: execution.timedOut,
      outputLimitExceeded: execution.outputLimitExceeded,
      stderr: boundedDiagnostic(execution.stderr),
      stdout: boundedDiagnostic(execution.stdout),
    },
  );
}

export async function executeAgentProcess(
  invocation: PreparedAgentInvocation,
  options: {
    readonly cwd: string;
    readonly timeoutMs: number;
    readonly heartbeatIntervalMs?: number;
    readonly onHeartbeat?: (elapsedMs: number) => void;
  },
): Promise<AgentExecution> {
  return new Promise((resolveExecution) => {
    const startedAt = Date.now();
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let outputLimitExceeded = false;
    let spawnError: Error | undefined;
    const child = spawn(invocation.command, invocation.args, { cwd: options.cwd, stdio: 'pipe' });
    const append = (current: string, chunk: Buffer): string => {
      const next = current + chunk.toString('utf8');
      if (Buffer.byteLength(next, 'utf8') <= MAX_AGENT_OUTPUT_BYTES) return next;
      outputLimitExceeded = true;
      child.kill('SIGTERM');
      return next.slice(0, MAX_AGENT_OUTPUT_BYTES);
    };
    child.stdout.on('data', (chunk: Buffer) => { stdout = append(stdout, chunk); });
    child.stderr.on('data', (chunk: Buffer) => { stderr = append(stderr, chunk); });
    child.on('error', (error) => { spawnError = error; });
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, options.timeoutMs);
    const heartbeat = setInterval(() => options.onHeartbeat?.(Date.now() - startedAt), options.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS);
    child.on('close', (exitCode, signal) => {
      clearTimeout(timeout);
      clearInterval(heartbeat);
      resolveExecution({
        stdout,
        stderr,
        exitCode,
        signal,
        timedOut,
        outputLimitExceeded,
        durationMs: Date.now() - startedAt,
        ...(spawnError ? { spawnError } : {}),
      });
    });
    child.stdin.end(invocation.input);
  });
}

export function formatAgentProgress(
  phase: 'started' | 'running' | 'completed',
  stepId: string,
  handoff: {
    readonly provider: string;
    readonly profile: string;
    readonly invocation?: { readonly model?: string; readonly reasoningEffort?: string };
  },
  elapsedMs?: number,
): string {
  const context = [
    `provider: ${handoff.provider}`,
    `profile: ${handoff.profile}`,
    ...(handoff.invocation?.model ? [`model: ${handoff.invocation.model}`] : []),
    ...(handoff.invocation?.reasoningEffort ? [`reasoning effort: ${handoff.invocation.reasoningEffort}`] : []),
  ].join(', ');
  const elapsed = elapsedMs === undefined ? '' : `, elapsed: ${Math.max(1, Math.floor(elapsedMs / 1_000))}s`;
  return `step: ${stepId} ${phase} (${context}${elapsed})`;
}

export function boundedDiagnostic(value: string): string {
  const normalized = value.trim();
  const redacted = normalized
    .replace(/\b(api[_-]?key|access[_-]?token|token|password|secret)\b\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+/gi, 'Bearer [REDACTED]');
  return redacted.length <= MAX_DIAGNOSTIC_CHARS
    ? redacted
    : `${redacted.slice(0, MAX_DIAGNOSTIC_CHARS - 3)}...`;
}

/** Old run states predate the frozen repository field and retain V0's caller-CWD behavior. */
export function executionDirectory(repositoryDirectory: string | undefined, fallback = process.cwd()): string {
  return repositoryDirectory ?? fallback;
}

export function prepareExecutionInvocation(
  invocation: PreparedAgentInvocation,
  expectedOutputPath: string,
  stagingPath: string,
): PreparedAgentInvocation {
  return {
    ...invocation,
    args: [
      ...invocation.args.map((value) => value.replaceAll(expectedOutputPath, stagingPath)),
      ...(invocation.command === 'codex' ? ['--add-dir', dirname(stagingPath)] : []),
    ],
    input: invocation.input.replaceAll(expectedOutputPath, stagingPath),
  };
}

export function extractContent(stdout: string): string {
  try {
    const parsed = JSON.parse(stdout) as { result?: unknown };
    const result = typeof parsed.result === 'string' ? parsed.result : stdout;
    try {
      const structured = JSON.parse(result) as { markdown?: unknown; verdict?: unknown };
      if (typeof structured.markdown === 'string' && typeof structured.verdict === 'string') {
        return `${structured.markdown}\n\nVERDICT: ${structured.verdict}`;
      }
    } catch { /* normal non-structured agent output */ }
    return result;
  } catch { return stdout; }
}

const ARTIFACT_START = '<!-- IMPRESAIRIO_ARTIFACT_START -->';
const ARTIFACT_END = '<!-- IMPRESAIRIO_ARTIFACT_END -->';

/**
 * Accept only an explicitly closed agent artifact. A provider truncated at its
 * own output limit must fail the step and preserve diagnostics, never replace
 * a previous published revision with a plausible-looking fragment.
 */
export function extractCompleteArtifact(content: string): string {
  const normalized = content.trim();
  if (!normalized.startsWith(ARTIFACT_START)) {
    throw new Error('Provider output is incomplete: expected a closed Impresairio artifact envelope');
  }
  const endIndex = normalized.lastIndexOf(ARTIFACT_END);
  if (endIndex < ARTIFACT_START.length) {
    throw new Error('Provider output is incomplete: expected a closed Impresairio artifact envelope');
  }
  const suffix = normalized.slice(endIndex + ARTIFACT_END.length);
  if (suffix.trim() && !/^VERDICT: (?:APPROVED|CHANGES_REQUESTED|BLOCKED)$/.test(suffix.trim())) {
    throw new Error('Provider output is incomplete: unexpected content after the Impresairio artifact envelope');
  }
  let markdown = normalized.slice(ARTIFACT_START.length, endIndex);
  if (markdown.startsWith('\n')) markdown = markdown.slice(1);
  if (markdown.endsWith('\n')) markdown = markdown.slice(0, -1);
  if (!markdown.trim()) throw new Error('Provider output contains an empty Impresairio artifact envelope');
  return `${markdown}${suffix}`;
}

/** Recover only a completed Claude response from its documented Write denial. */
export function extractDeniedWriteContent(output: string, expectedPath: string): string | undefined {
  try {
    const parsed = JSON.parse(output) as {
      subtype?: unknown;
      permission_denials?: Array<{ tool_name?: unknown; tool_input?: { file_path?: unknown; content?: unknown } }>;
    };
    if (parsed.subtype !== 'error_during_execution') return undefined;
    const deniedWrite = parsed.permission_denials?.find((denial) => denial.tool_name === 'Write'
      && typeof denial.tool_input?.file_path === 'string'
      && resolve(denial.tool_input.file_path) === resolve(expectedPath));
    return typeof deniedWrite?.tool_input?.content === 'string' && deniedWrite.tool_input.content.trim().length > 0
      ? deniedWrite.tool_input.content
      : undefined;
  } catch {
    return undefined;
  }
}

function isInternalArtifact(runDirectory: string, outputPath: string): boolean {
  const relativePath = relative(runDirectory, outputPath);
  return relativePath === 'artifacts' || relativePath.startsWith(`artifacts${sep}`);
}
