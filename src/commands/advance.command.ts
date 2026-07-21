import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { Injectable } from '@nestjs/common';
import { Command, CommandRunner } from 'nest-commander';
import { AgentDispatchService } from '../agents/agent-dispatch.service';
import { CompletionService } from '../runs/completion.service';
import { WorkflowRunnerService } from '../workflows/workflow-runner.service';
import { FileStateStore } from '../runs/file-state.store';
import { ArtifactService } from '../documentation/artifact.service';
import { RunLockService } from '../runs/run-lock.service';

@Injectable()
@Command({ name: 'advance', arguments: '<run-id>', description: 'Execute agent steps until the next human gate, failure, or workflow completion.' })
export class AdvanceCommand extends CommandRunner {
  constructor(
    private readonly workflow: WorkflowRunnerService,
    private readonly dispatch: AgentDispatchService,
    private readonly completion: CompletionService,
    private readonly stateStore: FileStateStore,
    private readonly artifacts: ArtifactService,
    private readonly locks: RunLockService,
  ) { super(); }

  async run([runId]: string[]): Promise<void> {
    const release = this.locks.acquireReentrant(runId, 'advance');
    let activeStepId: string | undefined;
    try {
      for (;;) {
        const result = this.workflow.next(runId);
        if (result.kind === 'gate') {
          for (const warning of result.warnings ?? []) process.stdout.write(`warning: ${warning}\n`);
          process.stdout.write(`gate: ${result.stepId}\n`);
          return;
        }
        if (result.kind === 'complete') { process.stdout.write('complete\n'); return; }
        activeStepId = result.stepId;
        const handoff = this.dispatch.prepare(runId, result);
        if (!handoff?.invocation) throw new Error(`No executable invocation for ${result.stepId}`);
        const runDirectory = this.stateStore.runDirectory(runId);
        if (isInternalArtifact(runDirectory, handoff.expectedOutput.path)
          && existsSync(handoff.expectedOutput.path)
          && readFileSync(handoff.expectedOutput.path, 'utf8').trim().length > 0) {
          this.completion.complete(runId, result.stepId);
          activeStepId = undefined;
          continue;
        }
        const stagingPath = join(runDirectory, 'staging', `${result.stepId}.md`);
        mkdirSync(dirname(stagingPath), { recursive: true });
        rmSync(stagingPath, { force: true });
        const invocation = {
          ...handoff.invocation,
          args: [
            ...handoff.invocation.args.map((value) => value.replaceAll(handoff.expectedOutput.path, stagingPath)),
            ...(handoff.invocation.command === 'codex' ? ['--add-dir', runDirectory] : []),
          ],
          input: handoff.invocation.input.replaceAll(handoff.expectedOutput.path, stagingPath),
        };
        const currentRun = this.stateStore.findState(runId);
        if (!currentRun) throw new Error(`Run not found while executing ${result.stepId}: ${runId}`);
        const child = spawnSync(invocation.command, invocation.args, {
          encoding: 'utf8', cwd: executionDirectory(currentRun.repositoryDirectory), input: invocation.input,
          timeout: currentRun.execution.agentTimeoutSeconds * 1_000, maxBuffer: 16 * 1024 * 1024,
        });
        if (child.error) throw child.error;
        // Claude can finish generating a structured answer then fail only
        // because it attempted an unnecessary Write tool call. Preserve that
        // complete answer when it is present; other non-zero exits remain failures.
        const recoveredContent = child.status !== 0
          ? extractDeniedWriteContent(child.stderr || child.stdout, stagingPath)
          : undefined;
        if (child.status !== 0 && !recoveredContent) {
          throw new Error(`${handoff.invocation.command} failed for ${result.stepId}: ${child.stderr || child.stdout}`);
        }
        const content = existsSync(stagingPath) && readFileSync(stagingPath, 'utf8').trim().length > 0
          ? readFileSync(stagingPath, 'utf8')
          : recoveredContent ?? extractContent(child.stdout);
        if (!content.trim()) throw new Error(`${handoff.invocation.command} returned no artifact content for ${result.stepId}`);
        const current = this.stateStore.findState(runId);
        const step = current?.steps.find((candidate) => candidate.id === result.stepId);
        if (!step || step.kind !== 'agent' || !step.expectedOutput) {
          throw new Error(`Step ${result.stepId} has no resolved output to publish`);
        }
        this.artifacts.publishMarkdown(step.expectedOutput, content.endsWith('\n') ? content : `${content}\n`);
        this.completion.complete(runId, result.stepId);
        activeStepId = undefined;
      }
    } catch (error) {
      if (activeStepId) {
        this.stateStore.markFailed(runId, activeStepId, error instanceof Error ? error.message : String(error));
      }
      throw error;
    } finally {
      release();
    }
  }
}

/** Old run states predate the frozen repository field and retain V0's caller-CWD behavior. */
export function executionDirectory(repositoryDirectory: string | undefined, fallback = process.cwd()): string {
  return repositoryDirectory ?? fallback;
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

/**
 * Recover a completed Claude response from its documented JSON diagnostic
 * when the only failed operation was writing the already-generated artifact.
 * This is intentionally narrow: it never treats arbitrary provider errors as
 * successful work.
 */
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
