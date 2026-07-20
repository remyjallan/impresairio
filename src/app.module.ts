import { Module } from '@nestjs/common';
import { StatusCommand } from './commands/status.command';
import { ConfigService } from './config/config.service';
import { HomeDirectoryResolver } from './config/home-directory.resolver';
import { PathRendererService } from './documentation/path-renderer.service';
import { RunLookupService } from './runs/run-lookup.service';

@Module({
  providers: [
    RunLookupService,
    StatusCommand,
    {
      provide: HomeDirectoryResolver,
      useFactory: () => new HomeDirectoryResolver(),
    },
    ConfigService,
    PathRendererService,
  ],
})
export class AppModule {}
