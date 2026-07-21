import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigService, ConfigurationError } from '../src/config/config.service';
import { HomeDirectoryResolver } from '../src/config/home-directory.resolver';

const fixtureDirectory = join(__dirname, 'fixtures');
const createdDirectories: string[] = [];

function createDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'impresairio-config-'));
  createdDirectories.push(directory);
  return directory;
}

function copyFixture(name: string, destination: string): void {
  writeFileSync(
    destination,
    readFileSync(join(fixtureDirectory, name), 'utf8'),
    'utf8',
  );
}

function writeValidConfiguration(home: string, repository: string): void {
  mkdirSync(home, { recursive: true });
  copyFixture('global-config.yaml', join(home, 'config.yaml'));
  copyFixture('repository-config.yaml', join(repository, '.impresairio.yaml'));
}

afterEach(() => {
  for (const directory of createdDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('ConfigService', () => {
  it('loads validated global and repository configuration', () => {
    const home = createDirectory();
    const repository = createDirectory();
    writeValidConfiguration(home, repository);
    const service = new ConfigService(new HomeDirectoryResolver({
      IMPRESAIRIO_HOME: home,
    }));

    const configuration = service.load(repository);

    expect(configuration.homeDirectory).toBe(home);
    expect(configuration.project).toEqual({
      name: 'Example Project',
      slug: 'example-project',
    });
    expect(configuration.documentation.target.name).toBe('personal-vault');
    expect(configuration.documentation.target.root).toBe('/tmp/impresairio-documents');
    expect(configuration.agentProfiles['opencode-glm']).toEqual({
      provider: 'opencode',
      modelAlias: 'glm-5.2',
      model: 'openrouter/z-ai/glm-5.2',
    });
    expect(configuration.agentProfiles.claude.skills).toEqual({ 'feature-design': 'example:brainstorming' });
    expect(configuration.execution).toEqual({ agentTimeoutSeconds: 1_800 });
  });

  it('uses IMPRESAIRIO_HOME instead of the operating-system default', () => {
    const overrideHome = createDirectory();
    const repository = createDirectory();
    writeValidConfiguration(overrideHome, repository);
    const resolver = new HomeDirectoryResolver({
      IMPRESAIRIO_HOME: overrideHome,
    });

    expect(resolver.resolve()).toBe(overrideHome);
    expect(new ConfigService(resolver).load(repository).homeDirectory).toBe(
      overrideHome,
    );
  });

  it('loads a configured agent timeout', () => {
    const home = createDirectory();
    const repository = createDirectory();
    writeValidConfiguration(home, repository);
    writeFileSync(
      join(home, 'config.yaml'),
      `${readFileSync(join(home, 'config.yaml'), 'utf8')}\nexecution:\n  agentTimeoutSeconds: 3600\n`,
      'utf8',
    );

    expect(new ConfigService(new HomeDirectoryResolver({ IMPRESAIRIO_HOME: home }))
      .load(repository).execution).toEqual({ agentTimeoutSeconds: 3_600 });
  });

  it('rejects an out-of-range agent timeout', () => {
    const home = createDirectory();
    const repository = createDirectory();
    writeValidConfiguration(home, repository);
    writeFileSync(
      join(home, 'config.yaml'),
      `${readFileSync(join(home, 'config.yaml'), 'utf8')}\nexecution:\n  agentTimeoutSeconds: 0\n`,
      'utf8',
    );

    expect(() => new ConfigService(new HomeDirectoryResolver({ IMPRESAIRIO_HOME: home })).load(repository))
      .toThrow(`${join(home, 'config.yaml')}: execution.agentTimeoutSeconds`);
  });

  it('reports the repository source when its documentation target is unknown', () => {
    const home = createDirectory();
    const repository = createDirectory();
    writeValidConfiguration(home, repository);
    writeFileSync(
      join(repository, '.impresairio.yaml'),
      readFileSync(join(fixtureDirectory, 'repository-config.yaml'), 'utf8').replace(
        'personal-vault',
        'missing-target',
      ),
      'utf8',
    );
    const service = new ConfigService(new HomeDirectoryResolver({
      IMPRESAIRIO_HOME: home,
    }));

    expect(() => service.load(repository)).toThrow(ConfigurationError);
    expect(() => service.load(repository)).toThrow(
      `${join(repository, '.impresairio.yaml')}: documentation.target`,
    );
  });

  it('rejects a prototype property used as a documentation target', () => {
    const home = createDirectory();
    const repository = createDirectory();
    writeValidConfiguration(home, repository);
    writeFileSync(
      join(repository, '.impresairio.yaml'),
      readFileSync(join(fixtureDirectory, 'repository-config.yaml'), 'utf8').replace(
        'personal-vault',
        'toString',
      ),
      'utf8',
    );
    const service = new ConfigService(new HomeDirectoryResolver({
      IMPRESAIRIO_HOME: home,
    }));

    expect(() => service.load(repository)).toThrow(
      `${join(repository, '.impresairio.yaml')}: documentation.target`,
    );
  });

  it('reports the source file and field for invalid YAML values', () => {
    const home = createDirectory();
    const repository = createDirectory();
    writeValidConfiguration(home, repository);
    writeFileSync(
      join(home, 'config.yaml'),
      readFileSync(join(fixtureDirectory, 'global-config.yaml'), 'utf8').replace(
        'root: /tmp/impresairio-documents',
        'root: 42',
      ),
      'utf8',
    );
    const service = new ConfigService(new HomeDirectoryResolver({
      IMPRESAIRIO_HOME: home,
    }));

    expect(() => service.load(repository)).toThrow(ConfigurationError);
    expect(() => service.load(repository)).toThrow(
      `${join(home, 'config.yaml')}: documentationTargets.personal-vault.root`,
    );
  });

  it('rejects an OpenCode profile whose model alias is not configured', () => {
    const home = createDirectory();
    const repository = createDirectory();
    writeValidConfiguration(home, repository);
    writeFileSync(
      join(home, 'config.yaml'),
      readFileSync(join(fixtureDirectory, 'global-config.yaml'), 'utf8').replace(
        'modelAlias: glm-5.2',
        'modelAlias: missing-model',
      ),
      'utf8',
    );
    const service = new ConfigService(new HomeDirectoryResolver({
      IMPRESAIRIO_HOME: home,
    }));

    expect(() => service.load(repository)).toThrow(
      `${join(home, 'config.yaml')}: agentProfiles.opencode-glm.modelAlias`,
    );
  });

  it('rejects an unregistered provider name in global configuration', () => {
    const home = createDirectory();
    const repository = createDirectory();
    writeValidConfiguration(home, repository);
    writeFileSync(
      join(home, 'config.yaml'),
      readFileSync(join(fixtureDirectory, 'global-config.yaml'), 'utf8').replace(
        'provider: codex',
        'provider: unknown-provider',
      ),
      'utf8',
    );
    const service = new ConfigService(new HomeDirectoryResolver({ IMPRESAIRIO_HOME: home }));

    expect(() => service.load(repository)).toThrow(
      `${join(home, 'config.yaml')}: agentProfiles.codex.provider`,
    );
  });

  it('rejects a prototype property used as an OpenCode model alias', () => {
    const home = createDirectory();
    const repository = createDirectory();
    writeValidConfiguration(home, repository);
    writeFileSync(
      join(home, 'config.yaml'),
      readFileSync(join(fixtureDirectory, 'global-config.yaml'), 'utf8').replace(
        'modelAlias: glm-5.2',
        'modelAlias: toString',
      ),
      'utf8',
    );
    const service = new ConfigService(new HomeDirectoryResolver({
      IMPRESAIRIO_HOME: home,
    }));

    expect(() => service.load(repository)).toThrow(
      `${join(home, 'config.yaml')}: agentProfiles.opencode-glm.modelAlias`,
    );
  });
});
