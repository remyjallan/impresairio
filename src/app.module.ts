import { Module } from '@nestjs/common';
import { CompleteCommand } from './commands/complete.command';
import { ApproveCommand } from './commands/approve.command';
import { NextCommand, NEXT_WRITER } from './commands/next.command';
import { ImpresairioRootCommand } from './commands/root.command';
import { RequestChangesCommand } from './commands/request-changes.command';
import { RetryCommand } from './commands/retry.command';
import { StartCommand, START_WRITER } from './commands/start.command';
import { StatusCommand, STATUS_WRITER } from './commands/status.command';
import { UnlockCommand } from './commands/unlock.command';
import { ListCommand, LIST_WRITER } from './commands/list.command';
import { AdvanceCommand } from './commands/advance.command';
import { DoctorCommand, DOCTOR_WRITER } from './commands/doctor.command';
import { ConfigService } from './config/config.service';
import { HomeDirectoryResolver } from './config/home-directory.resolver';
import { ArtifactService } from './documentation/artifact.service';
import { FilesystemDocumentationTarget } from './documentation/filesystem-documentation.target';
import { PathRendererService } from './documentation/path-renderer.service';
import {
  COMPLETION_RUN_STORE,
  COMPLETION_CLOCK,
  COMPLETION_LOCK,
  COMPLETION_POLICY,
  CompletionService,
  OUTPUT_VERIFIER,
} from './runs/completion.service';
import { EventLogService } from './runs/event-log.service';
import { FILE_STATE_OPERATIONS, FileStateStore } from './runs/file-state.store';
import { RUN_LOCK_RUNTIME, RunLockService } from './runs/run-lock.service';
import { RUN_CLOCK, RunService } from './runs/run.service';
import {
  WORKFLOW_REGISTRY_RUNTIME,
  WorkflowRegistryService,
} from './workflows/workflow-registry.service';
import { GateService } from './workflows/gate.service';
import { GATE_CLOCK, StaleInvalidationService } from './workflows/stale-invalidation.service';
import { WORKFLOW_CLOCK, WorkflowRunnerService } from './workflows/workflow-runner.service';
import { AgentProfileService } from './agents/agent-profile.service';
import { AgentDispatchService } from './agents/agent-dispatch.service';
import { AGENT_PROCESS_RUNNER, PlannedAgentProcessRunner } from './agents/agent-provider';
import { ClaudeCodeProvider } from './agents/claude-code.provider';
import { CodexProvider } from './agents/codex.provider';
import { OpenCodeProvider } from './agents/opencode.provider';
import { AGENT_PROVIDERS, ProviderRegistryService } from './agents/provider-registry.service';
import { AGENT_COMMAND_EXECUTOR, AgentHealthService, LocalAgentCommandExecutor } from './agents/agent-health.service';
import { VerdictCompletionPolicy } from './workflows/verdict-completion.policy';

@Module({
  providers: [
    ImpresairioRootCommand,
    StatusCommand,
    StartCommand,
    UnlockCommand,
    ListCommand,
    AdvanceCommand,
    DoctorCommand,
    CompleteCommand,
    ApproveCommand,
    RequestChangesCommand,
    RetryCommand,
    NextCommand,
    AgentProfileService,
    AgentDispatchService,
    AgentHealthService,
    ProviderRegistryService,
    ClaudeCodeProvider,
    CodexProvider,
    OpenCodeProvider,
    {
      provide: HomeDirectoryResolver,
      useFactory: () => new HomeDirectoryResolver(),
    },
    ConfigService,
    PathRendererService,
    FilesystemDocumentationTarget,
    ArtifactService,
    CompletionService,
    FileStateStore,
    EventLogService,
    RunLockService,
    RunService,
    WorkflowRegistryService,
    WorkflowRunnerService,
    GateService,
    StaleInvalidationService,
    VerdictCompletionPolicy,
    {
      provide: FILE_STATE_OPERATIONS,
      useValue: {},
    },
    {
      provide: WORKFLOW_REGISTRY_RUNTIME,
      useValue: {},
    },
    {
      provide: RUN_LOCK_RUNTIME,
      useValue: {},
    },
    {
      provide: RUN_CLOCK,
      useValue: () => new Date(),
    },
    {
      provide: WORKFLOW_CLOCK,
      useValue: () => new Date(),
    },
    {
      provide: GATE_CLOCK,
      useValue: () => new Date(),
    },
    {
      provide: COMPLETION_RUN_STORE,
      useExisting: FileStateStore,
    },
    {
      provide: OUTPUT_VERIFIER,
      useExisting: ArtifactService,
    },
    {
      provide: COMPLETION_CLOCK,
      useValue: () => new Date(),
    },
    {
      provide: COMPLETION_LOCK,
      useExisting: RunLockService,
    },
    {
      provide: COMPLETION_POLICY,
      useExisting: VerdictCompletionPolicy,
    },
    {
      provide: STATUS_WRITER,
      useValue: (line: string) => process.stdout.write(line),
    },
    {
      provide: START_WRITER,
      useValue: (line: string) => process.stdout.write(line),
    },
    {
      provide: NEXT_WRITER,
      useValue: (line: string) => process.stdout.write(line),
    },
    {
      provide: LIST_WRITER,
      useValue: (line: string) => process.stdout.write(line),
    },
    {
      provide: DOCTOR_WRITER,
      useValue: (line: string) => process.stdout.write(line),
    },
    {
      provide: AGENT_COMMAND_EXECUTOR,
      useClass: LocalAgentCommandExecutor,
    },
    {
      provide: AGENT_PROVIDERS,
      useFactory: (
        claude: ClaudeCodeProvider,
        codex: CodexProvider,
        opencode: OpenCodeProvider,
      ) => [claude, codex, opencode],
      inject: [ClaudeCodeProvider, CodexProvider, OpenCodeProvider],
    },
    {
      provide: AGENT_PROCESS_RUNNER,
      useClass: PlannedAgentProcessRunner,
    },
  ],
})
export class AppModule {}
