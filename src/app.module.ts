import { Module } from '@nestjs/common';
import { CompleteCommand } from './commands/complete.command';
import { StartCommand, START_WRITER } from './commands/start.command';
import { StatusCommand, STATUS_WRITER } from './commands/status.command';
import { UnlockCommand } from './commands/unlock.command';
import { ConfigService } from './config/config.service';
import { HomeDirectoryResolver } from './config/home-directory.resolver';
import { ArtifactService } from './documentation/artifact.service';
import { FilesystemDocumentationTarget } from './documentation/filesystem-documentation.target';
import { PathRendererService } from './documentation/path-renderer.service';
import {
  COMPLETION_RUN_STORE,
  COMPLETION_CLOCK,
  COMPLETION_LOCK,
  CompletionService,
  OUTPUT_VERIFIER,
} from './runs/completion.service';
import { EventLogService } from './runs/event-log.service';
import { FILE_STATE_OPERATIONS, FileStateStore } from './runs/file-state.store';
import { RUN_LOCK_RUNTIME, RunLockService } from './runs/run-lock.service';
import { RUN_CLOCK, RunService } from './runs/run.service';

@Module({
  providers: [
    StatusCommand,
    StartCommand,
    UnlockCommand,
    CompleteCommand,
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
    {
      provide: FILE_STATE_OPERATIONS,
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
      provide: STATUS_WRITER,
      useValue: (line: string) => process.stdout.write(line),
    },
    {
      provide: START_WRITER,
      useValue: (line: string) => process.stdout.write(line),
    },
  ],
})
export class AppModule {}
