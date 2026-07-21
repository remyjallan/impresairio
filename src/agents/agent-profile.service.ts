import { Injectable } from '@nestjs/common';
import type { ResolvedAgentProfile } from '../config/config.service';
import type { RunState } from '../runs/run-state.schema';

export class AgentProfileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentProfileError';
  }
}

export type ResolvedActorProfiles = RunState['resolvedActors'];

@Injectable()
export class AgentProfileService {
  resolveForActors(
    roleBindings: Readonly<Record<string, string>>,
    actors: readonly string[],
    profiles: Readonly<Record<string, ResolvedAgentProfile>>,
  ): ResolvedActorProfiles {
    const declared = new Set(actors);
    const unknown = Object.keys(roleBindings).filter((role) => !declared.has(role));
    if (unknown.length > 0) {
      throw new AgentProfileError(
        `Unknown workflow roles: ${unknown.join(', ')}; this workflow declares: ${[...declared].join(', ')}`,
      );
    }
    return Object.fromEntries(actors.map((actor) => {
      const profileName = roleBindings[actor];
      if (!profileName) {
        throw new AgentProfileError(`Actor ${actor} requires an agent profile`);
      }
      const profile = profiles[profileName];
      if (!profile) {
        throw new AgentProfileError(
          `Actor ${actor} references unknown agent profile "${profileName}"`,
        );
      }
      return [actor, { profile: profileName, ...profile }];
    }));
  }
}
