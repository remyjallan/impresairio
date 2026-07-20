import { Module } from '@nestjs/common';
import { StatusCommand } from './commands/status.command';
import { RunLookupService } from './runs/run-lookup.service';

@Module({
  providers: [RunLookupService, StatusCommand],
})
export class AppModule {}
