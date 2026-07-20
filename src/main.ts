#!/usr/bin/env node
import 'reflect-metadata';
import { CommandFactory } from 'nest-commander';
import { AppModule } from './app.module';

const version = '0.1.0';

export async function bootstrap(): Promise<void> {
  if (process.argv.slice(2).includes('--version') || process.argv.slice(2).includes('-V')) {
    process.stdout.write(`${version}\n`);
    return;
  }
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
