import { describe, expect, it } from 'vitest';
import { ClaudeCodeProvider } from '../src/agents/claude-code.provider';
import { CodexProvider } from '../src/agents/codex.provider';
import { OpenCodeProvider } from '../src/agents/opencode.provider';
import { ProviderRegistryError, ProviderRegistryService } from '../src/agents/provider-registry.service';

describe('ProviderRegistryService', () => {
  const registry = new ProviderRegistryService([
    new ClaudeCodeProvider(), new CodexProvider(), new OpenCodeProvider(),
  ]);

  it('returns fixed registered providers and refuses unknown names', () => {
    expect(registry.get('claude-code')).toBeInstanceOf(ClaudeCodeProvider);
    expect(() => registry.get('unknown' as 'codex')).toThrow(
      new ProviderRegistryError('Agent provider is not registered: unknown'),
    );
  });

  it('uses a native skill only when the provider declares the action', () => {
    expect(registry.get('claude-code').nativeSkillFor('feature-design')).toBeUndefined();
    expect(registry.get('codex').nativeSkillFor('feature-design')).toBeUndefined();
  });
});
