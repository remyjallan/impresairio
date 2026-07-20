import { Module } from '@nestjs/common';
import { CompleteCommand } from './commands/complete.command';
import { StatusCommand } from './commands/status.command';
import { ConfigService } from './config/config.service';
import { HomeDirectoryResolver } from './config/home-directory.resolver';
import { ArtifactService } from './documentation/artifact.service';
import { FilesystemDocumentationTarget } from './documentation/filesystem-documentation.target';
import { PathRendererService } from './documentation/path-renderer.service';
import {
  COMPLETION_RUN_STORE,
  CompletionService,
  OUTPUT_VERIFIER,
} from './runs/completion.service';
import { RunLookupService } from './runs/run-lookup.service';

@Module({
  providers: [
    RunLookupService,
    StatusCommand,
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
    {
      provide: COMPLETION_RUN_STORE,
      useExisting: RunLookupService,
    },
    {
      provide: OUTPUT_VERIFIER,
      useExisting: ArtifactService,
    },
  ],
})
export class AppModule {}
