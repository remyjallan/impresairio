#!/usr/bin/env node
import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CommandFactory } from 'nest-commander';
import { AppModule } from './app.module';

const version = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')).version as string;

export async function bootstrap(): Promise<void> {
  if (process.argv.length === 3 && (process.argv[2] === '--version' || process.argv[2] === '-V')) {
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
