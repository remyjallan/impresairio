import { Injectable } from '@nestjs/common';
import { homedir, platform } from 'node:os';
import { join, resolve } from 'node:path';

@Injectable()
export class HomeDirectoryResolver {
  constructor(
    private readonly environment: NodeJS.ProcessEnv = process.env,
    private readonly hostPlatform: NodeJS.Platform = platform(),
    private readonly userHomeDirectory: string = homedir(),
  ) {}

  resolve(): string {
    const configuredHome = this.environment.IMPRESAIRIO_HOME?.trim();

    if (configuredHome) {
      return resolve(configuredHome);
    }

    if (this.hostPlatform === 'win32') {
      const appData = this.environment.APPDATA?.trim();
      return appData
        ? join(appData, 'Impresairio')
        : join(this.userHomeDirectory, 'AppData', 'Roaming', 'Impresairio');
    }

    return join(this.userHomeDirectory, '.impresairio');
  }
}
