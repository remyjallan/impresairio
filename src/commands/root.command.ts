import { Injectable } from '@nestjs/common';
import { CommandRunner, RootCommand as Root } from 'nest-commander';

/** Sets the stable executable name used by all generated help output. */
@Injectable()
@Root({
  name: 'impresairio',
  description: 'Coordinate durable, human-gated AI-assisted engineering workflows.',
})
export class ImpresairioRootCommand extends CommandRunner {
  async run(): Promise<void> {
    this.command.outputHelp();
  }
}
