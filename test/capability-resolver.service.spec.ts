import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HomeDirectoryResolver } from '../src/config/home-directory.resolver';
import {
  CapabilityResolutionError,
  CapabilityResolverService,
} from '../src/agents/capability-resolver.service';
import type { ResolvedAgentProfile } from '../src/config/config.service';

const temporaryDirectories: string[] = [];

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function createResolver(home: string, packagePromptsDirectory: string): CapabilityResolverService {
  return new CapabilityResolverService(
    new HomeDirectoryResolver({ IMPRESAIRIO_HOME: home }),
    { packagePromptsDirectory },
  );
}

function writeGlobalPrompt(home: string, capability: string, content: string): void {
  mkdirSync(join(home, 'prompts'), { recursive: true });
  writeFileSync(join(home, 'prompts', `${capability}.md`), content);
}

function writePackagePrompt(packagePromptsDirectory: string, capability: string, content: string): void {
  mkdirSync(packagePromptsDirectory, { recursive: true });
  writeFileSync(join(packagePromptsDirectory, `${capability}.md`), content);
}

const claudeProfile: ResolvedAgentProfile & { readonly profile?: string } = {
  provider: 'claude-code',
  profile: 'claude',
};

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('CapabilityResolverService', () => {
  it('resolves a profile skill even when a global prompt also exists', () => {
    const home = temporaryDirectory('impresairio-capability-home-');
    const packageDirectory = temporaryDirectory('impresairio-capability-package-');
    writeGlobalPrompt(home, 'threat-review', 'Challenge it (global).');
    const resolver = createResolver(home, packageDirectory);

    const method = resolver.resolve('threat-review', 'skeptic', 'claude', {
      ...claudeProfile,
      skills: { 'threat-review': 'local:review-skill' },
    });

    expect(method).toEqual({ capability: 'threat-review', skill: 'local:review-skill' });
  });

  it('resolves a global prompt over a package prompt when there is no skill', () => {
    const home = temporaryDirectory('impresairio-capability-home-');
    const packageDirectory = temporaryDirectory('impresairio-capability-package-');
    writeGlobalPrompt(home, 'threat-model', 'Model the threat (global).');
    writePackagePrompt(packageDirectory, 'threat-model', 'Model the threat (package).');
    const resolver = createResolver(home, packageDirectory);

    const method = resolver.resolve('threat-model', 'product-author', 'claude', claudeProfile);

    expect(method).toEqual({
      capability: 'threat-model',
      promptSource: 'global',
      content: 'Model the threat (global).',
    });
  });

  it('falls back to a packaged prompt when there is no skill or global prompt', () => {
    const home = temporaryDirectory('impresairio-capability-home-');
    const packageDirectory = temporaryDirectory('impresairio-capability-package-');
    writePackagePrompt(packageDirectory, 'implement', 'Implement the correction (package).');
    const resolver = createResolver(home, packageDirectory);

    const method = resolver.resolve('implement', 'implementer', 'claude', claudeProfile);

    expect(method).toEqual({
      capability: 'implement',
      promptSource: 'package',
      content: 'Implement the correction (package).',
    });
  });

  it('rejects an empty global prompt file', () => {
    const home = temporaryDirectory('impresairio-capability-home-');
    const packageDirectory = temporaryDirectory('impresairio-capability-package-');
    writeGlobalPrompt(home, 'threat-model', '   \n  ');
    const resolver = createResolver(home, packageDirectory);

    expect(() => resolver.resolve('threat-model', 'product-author', 'claude', claudeProfile))
      .toThrow(CapabilityResolutionError);
  });

  it('names the actor, profile and capability when nothing resolves', () => {
    const home = temporaryDirectory('impresairio-capability-home-');
    const packageDirectory = temporaryDirectory('impresairio-capability-package-');
    const resolver = createResolver(home, packageDirectory);

    expect(() => resolver.resolve('unknown-capability', 'product-author', 'claude', claudeProfile))
      .toThrow(/actor "product-author" \(profile "claude"\) has no method for capability "unknown-capability"/);
  });
});
