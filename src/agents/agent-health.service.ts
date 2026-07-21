import { spawnSync } from 'node:child_process';
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService, type LoadedConfiguration, type ResolvedAgentProfile } from '../config/config.service';
import { ProviderRegistryService } from './provider-registry.service';

export interface AgentCommandResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly error?: Error;
}

export interface AgentCommandExecutor {
  execute(command: string, args: readonly string[], input?: string): AgentCommandResult;
}

export const AGENT_COMMAND_EXECUTOR = Symbol('AGENT_COMMAND_EXECUTOR');

export class LocalAgentCommandExecutor implements AgentCommandExecutor {
  execute(command: string, args: readonly string[], input?: string): AgentCommandResult {
    const result = spawnSync(command, args, {
      encoding: 'utf8',
      input,
      timeout: 90_000,
    });
    return {
      status: result.status,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
      ...(result.error ? { error: result.error } : {}),
    };
  }
}

export interface AgentHealthResult {
  readonly profile: string;
  readonly provider: string;
  readonly model?: string;
  readonly ok: boolean;
  readonly detail: string;
}

@Injectable()
export class AgentHealthService {
  constructor(
    private readonly config: ConfigService,
    private readonly providers: ProviderRegistryService,
    @Inject(AGENT_COMMAND_EXECUTOR) private readonly executor: AgentCommandExecutor,
  ) {}

  check(repositoryDirectory: string, selectedProfiles: readonly string[], live: boolean): readonly AgentHealthResult[] {
    const configuration = this.config.load(repositoryDirectory);
    const names = selectedProfiles.length > 0 ? selectedProfiles : Object.keys(configuration.agentProfiles);
    return names.map((name) => this.checkProfile(name, configuration, live));
  }

  private checkProfile(name: string, configuration: LoadedConfiguration, live: boolean): AgentHealthResult {
    const agent = configuration.agentProfiles[name];
    if (!agent) {
      return { profile: name, provider: 'unknown', ok: false, detail: 'profile is not defined in global configuration' };
    }
    try {
      const provider = this.providers.get(agent.provider);
      const invocation = provider.prepareHealthCheck({ profile: name, agent: { profile: name, ...agent }, live });
      const result = this.executor.execute(invocation.command, invocation.args, invocation.input);
      if (result.error) {
        return { ...identity(name, agent), ok: false, detail: result.error.message };
      }
      if (result.status !== 0) {
        return { ...identity(name, agent), ok: false, detail: compact(result.stderr || result.stdout || `exited with ${result.status}`) };
      }
      return { ...identity(name, agent), ok: true, detail: live ? 'live probe succeeded' : compact(result.stdout || 'executable available') };
    } catch (error) {
      return { ...identity(name, agent), ok: false, detail: error instanceof Error ? error.message : String(error) };
    }
  }
}

function identity(profile: string, agent: ResolvedAgentProfile): Pick<AgentHealthResult, 'profile' | 'provider' | 'model'> {
  return {
    profile,
    provider: agent.provider,
    ...(agent.provider === 'opencode' ? { model: agent.model } : {}),
  };
}

function compact(value: string): string {
  const collapsed = value.replaceAll(/\s+/g, ' ').trim();
  return collapsed.length > 180 ? `${collapsed.slice(0, 177)}...` : collapsed;
}
