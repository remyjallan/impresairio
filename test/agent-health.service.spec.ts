import { describe, expect, it } from 'vitest';
import { AgentHealthService, type AgentCommandExecutor } from '../src/agents/agent-health.service';
import type { LoadedConfiguration } from '../src/config/config.service';

const configuration: LoadedConfiguration = {
  homeDirectory: '/tmp/home',
  globalConfigPath: '/tmp/home/config.yaml',
  repositoryConfigPath: '/tmp/repo/.impresairio.yaml',
  project: { name: 'Test', slug: 'test' },
  documentation: {
    target: { name: 'docs', kind: 'filesystem', root: '/tmp/docs', defaultFormat: 'markdown' },
    featurePath: 'Specs/{{ feature.id }}', format: 'markdown',
  },
  agentProfiles: {
    claude: { provider: 'claude-code' },
    'opencode-glm': { provider: 'opencode', modelAlias: 'glm-5.2', model: 'openrouter/z-ai/glm-5.2' },
  },
  models: { 'glm-5.2': 'openrouter/z-ai/glm-5.2' },
  execution: { agentTimeoutSeconds: 1_800 },
};

function service(executor: AgentCommandExecutor) {
  return new AgentHealthService(
    { load: () => configuration } as never,
    {
      get: (name: string) => ({
        prepareHealthCheck: ({ live, agent }: { live: boolean; agent: { model?: string } }) => ({
          command: name === 'opencode' ? 'opencode' : 'claude',
          args: live && name === 'opencode' ? ['run', '--model', agent.model!] : ['--version'],
          ...(live ? { input: 'Reply with exactly OK.' } : {}),
        }),
      }),
    } as never,
    executor,
  );
}

describe('AgentHealthService', () => {
  it('checks every configured profile without sending a model request by default', () => {
    const calls: string[] = [];
    const results = service({
      execute: (command, args) => {
        calls.push(`${command} ${args.join(' ')}`);
        return { status: 0, stdout: '1.2.3\n', stderr: '' };
      },
    }).check('/tmp/repo', [], false);

    expect(calls).toEqual(['claude --version', 'opencode --version']);
    expect(results).toEqual([
      expect.objectContaining({ profile: 'claude', ok: true, detail: '1.2.3' }),
      expect.objectContaining({ profile: 'opencode-glm', model: 'openrouter/z-ai/glm-5.2', ok: true }),
    ]);
  });

  it('uses the resolved OpenCode model for a selected live probe', () => {
    const calls: Array<{ command: string; args: readonly string[]; input?: string }> = [];
    const results = service({
      execute: (command, args, input) => {
        calls.push({ command, args, input });
        return { status: 0, stdout: 'OK\n', stderr: '' };
      },
    }).check('/tmp/repo', ['opencode-glm'], true);

    expect(calls).toEqual([{
      command: 'opencode', args: ['run', '--model', 'openrouter/z-ai/glm-5.2'], input: 'Reply with exactly OK.',
    }]);
    expect(results[0]).toMatchObject({ ok: true, detail: 'live probe succeeded' });
  });

  it('reports a missing configured profile without aborting the other checks', () => {
    const results = service({ execute: () => ({ status: 0, stdout: '', stderr: '' }) })
      .check('/tmp/repo', ['missing'], false);

    expect(results).toEqual([expect.objectContaining({ profile: 'missing', ok: false, provider: 'unknown' })]);
  });
});
