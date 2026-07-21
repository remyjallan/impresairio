import { describe, expect, it } from 'vitest';
import { AgentProfileError, AgentProfileService } from '../src/agents/agent-profile.service';

describe('AgentProfileService', () => {
  const service = new AgentProfileService();

  it('freezes the selected profile and resolved OpenCode model for every workflow actor', () => {
    expect(service.resolveForActors(
      { launcher: 'claude', adversary: 'codex', implementer: 'opencode-glm' },
      ['launcher', 'adversary', 'implementer'],
      {
        claude: { provider: 'claude-code' },
        codex: { provider: 'codex' },
        'opencode-glm': { provider: 'opencode', modelAlias: 'glm-5.2', model: 'z-ai/glm-5.2' },
      },
    )).toEqual({
      launcher: { profile: 'claude', provider: 'claude-code' },
      adversary: { profile: 'codex', provider: 'codex' },
      implementer: {
        profile: 'opencode-glm', provider: 'opencode', modelAlias: 'glm-5.2', model: 'z-ai/glm-5.2',
      },
    });
  });

  it('rejects a missing profile selected by a workflow actor', () => {
    expect(() => service.resolveForActors(
      { launcher: 'unknown' },
      ['launcher'],
      {},
    )).toThrow(new AgentProfileError('Actor launcher references unknown agent profile "unknown"'));
  });

  it('rejects a workflow actor without a profile binding', () => {
    expect(() => service.resolveForActors({}, ['launcher'], {
      claude: { provider: 'claude-code' },
    })).toThrow(new AgentProfileError('Actor launcher requires an agent profile'));
  });

  it('rejects a role binding for an actor the workflow does not declare', () => {
    expect(() => service.resolveForActors(
      { launcher: 'claude', 'product-author': 'claude' },
      ['launcher'],
      { claude: { provider: 'claude-code' } },
    )).toThrow(new AgentProfileError(
      'Unknown workflow roles: product-author; this workflow declares: launcher',
    ));
  });

  it('freezes configured fallback profiles without inheriting their own fallback chains', () => {
    expect(service.resolveForActors(
      { implementer: 'opencode-glm' },
      ['implementer'],
      {
        'opencode-glm': {
          provider: 'opencode', modelAlias: 'glm-5.2', model: 'openrouter/z-ai/glm-5.2',
          fallbackProfiles: ['codex'],
        },
        codex: { provider: 'codex', fallbackProfiles: ['claude'] },
        claude: { provider: 'claude-code' },
      },
    )).toEqual({
      implementer: {
        profile: 'opencode-glm', provider: 'opencode', modelAlias: 'glm-5.2', model: 'openrouter/z-ai/glm-5.2',
        fallbacks: [{ profile: 'codex', provider: 'codex' }],
      },
    });
  });
});
