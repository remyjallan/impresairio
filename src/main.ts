#!/usr/bin/env node
import 'reflect-metadata';
import { CommandFactory } from 'nest-commander';
import { AppModule } from './app.module';

export async function bootstrap(): Promise<void> {
  await CommandFactory.run(AppModule, {
    cliName: 'impresairio',
    logger: false,
    serviceErrorHandler: (error) => {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    },
  });
}

void bootstrap().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
