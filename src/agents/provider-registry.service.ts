import { Inject, Injectable } from '@nestjs/common';
import type { AgentProvider, AgentProviderName } from './agent-provider';

export const AGENT_PROVIDERS = Symbol('AGENT_PROVIDERS');

export class ProviderRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderRegistryError';
  }
}

@Injectable()
export class ProviderRegistryService {
  private readonly providers: ReadonlyMap<AgentProviderName, AgentProvider>;

  constructor(@Inject(AGENT_PROVIDERS) providers: readonly AgentProvider[]) {
    this.providers = new Map(providers.map((provider) => [provider.name, provider]));
  }

  get(name: AgentProviderName): AgentProvider {
    const provider = this.providers.get(name);
    if (!provider) {
      throw new ProviderRegistryError(`Agent provider is not registered: ${name}`);
    }
    return provider;
  }
}
