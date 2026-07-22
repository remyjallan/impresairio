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

  it('freezes independently selected OpenCode profiles for different workflow actors', () => {
    expect(service.resolveForActors(
      { implementer: 'opencode-glm', reviewer: 'opencode-kimi' },
      ['implementer', 'reviewer'],
      {
        'opencode-glm': {
          provider: 'opencode', modelAlias: 'glm-5.2', model: 'openrouter/z-ai/glm-5.2',
        },
        'opencode-kimi': {
          provider: 'opencode', modelAlias: 'kimi-3', model: 'openrouter/moonshotai/kimi-k2',
        },
      },
    )).toEqual({
      implementer: {
        profile: 'opencode-glm', provider: 'opencode',
        modelAlias: 'glm-5.2', model: 'openrouter/z-ai/glm-5.2',
      },
      reviewer: {
        profile: 'opencode-kimi', provider: 'opencode',
        modelAlias: 'kimi-3', model: 'openrouter/moonshotai/kimi-k2',
      },
    });
  });

  it('freezes independently selected Claude Code and Codex model and reasoning settings', () => {
    expect(service.resolveForActors(
      { launcher: 'claude-fast', adversary: 'codex-sol', implementer: 'codex-terra' },
      ['launcher', 'adversary', 'implementer'],
      {
        'claude-fast': { provider: 'claude-code', model: 'sonnet', reasoningEffort: 'medium' },
        'codex-sol': { provider: 'codex', model: 'gpt-5.6-sol', reasoningEffort: 'xhigh' },
        'codex-terra': { provider: 'codex', model: 'gpt-5.6-terra', reasoningEffort: 'high' },
      },
    )).toEqual({
      launcher: {
        profile: 'claude-fast', provider: 'claude-code', model: 'sonnet', reasoningEffort: 'medium',
      },
      adversary: {
        profile: 'codex-sol', provider: 'codex', model: 'gpt-5.6-sol', reasoningEffort: 'xhigh',
      },
      implementer: {
        profile: 'codex-terra', provider: 'codex', model: 'gpt-5.6-terra', reasoningEffort: 'high',
      },
    });
  });
});
