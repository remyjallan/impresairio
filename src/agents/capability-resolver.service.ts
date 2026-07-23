import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Inject, Injectable } from '@nestjs/common';
import { HomeDirectoryResolver } from '../config/home-directory.resolver';
import type { ResolvedAgentProfile } from '../config/config.service';

export class CapabilityResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CapabilityResolutionError';
  }
}

export type ResolvedCapabilityMethod =
  | { readonly capability: string; readonly skill: string }
  | { readonly capability: string; readonly promptSource: 'global' | 'package'; readonly content: string };

export type CapabilityProfile = ResolvedAgentProfile & { readonly profile: string };

export interface CapabilityResolverRuntime {
  readonly packagePromptsDirectory: string;
}

export const CAPABILITY_RESOLVER_RUNTIME = Symbol('CAPABILITY_RESOLVER_RUNTIME');

const nativeRuntime: CapabilityResolverRuntime = {
  packagePromptsDirectory: join(__dirname, '..', 'prompts', 'builtins'),
};

@Injectable()
export class CapabilityResolverService {
  private readonly runtime: CapabilityResolverRuntime;

  constructor(
    private readonly homeDirectoryResolver: HomeDirectoryResolver,
    @Inject(CAPABILITY_RESOLVER_RUNTIME) runtime: Partial<CapabilityResolverRuntime> = {},
  ) {
    this.runtime = { ...nativeRuntime, ...runtime };
  }

  resolve(capability: string, actor: string, profile: CapabilityProfile): ResolvedCapabilityMethod {
    const skill = profile.skills?.[capability];
    if (skill) return { capability, skill };
    const globalPrompt = this.readPrompt(join(this.homeDirectoryResolver.resolve(), 'prompts', `${capability}.md`));
    if (globalPrompt !== undefined) return { capability, promptSource: 'global', content: globalPrompt };
    const packagePrompt = this.readPrompt(join(this.runtime.packagePromptsDirectory, `${capability}.md`));
    if (packagePrompt !== undefined) return { capability, promptSource: 'package', content: packagePrompt };
    throw new CapabilityResolutionError(
      `actor "${actor}" (profile "${profile.profile}") has no method for capability "${capability}"; ` +
      `declare a skill in the profile or provide prompts/${capability}.md`,
    );
  }

  private readPrompt(path: string): string | undefined {
    if (!existsSync(path)) return undefined;
    const content = readFileSync(path, 'utf8');
    if (content.trim().length === 0) {
      throw new CapabilityResolutionError(`${path}: capability prompt must not be empty`);
    }
    return content;
  }
}
