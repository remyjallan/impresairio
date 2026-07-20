import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentDispatchService } from '../src/agents/agent-dispatch.service';
import type { AgentProcessRunner, PreparedAgentInvocation } from '../src/agents/agent-provider';
import { ClaudeCodeProvider } from '../src/agents/claude-code.provider';
import { CodexProvider } from '../src/agents/codex.provider';
import { OpenCodeProvider } from '../src/agents/opencode.provider';
import { ProviderRegistryService } from '../src/agents/provider-registry.service';
import { ArtifactService } from '../src/documentation/artifact.service';
import { FilesystemDocumentationTarget } from '../src/documentation/filesystem-documentation.target';
import { PathRendererService } from '../src/documentation/path-renderer.service';
import { HomeDirectoryResolver } from '../src/config/home-directory.resolver';
import { EventLogService } from '../src/runs/event-log.service';
import { FileStateStore } from '../src/runs/file-state.store';
import { RunLockService } from '../src/runs/run-lock.service';
import { createRunState } from '../src/runs/run-state.schema';
import { StaleInvalidationService } from '../src/workflows/stale-invalidation.service';
import { WorkflowRunnerService } from '../src/workflows/workflow-runner.service';
import { NextCommand } from '../src/commands/next.command';

const directories: string[] = [];

class FakeProcessRunner implements AgentProcessRunner {
  readonly calls: PreparedAgentInvocation[] = [];

  prepare(invocation: PreparedAgentInvocation): PreparedAgentInvocation {
    this.calls.push(invocation);
    return invocation;
  }
}

function setup(actor: 'launcher' | 'implementer') {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'impresairio-agent-dispatch-')));
  directories.push(home);
  const resolver = new HomeDirectoryResolver({ IMPRESAIRIO_HOME: home });
  const store = new FileStateStore(resolver);
  const events = new EventLogService(resolver);
  const locks = new RunLockService(store, events, {
    hostname: 'local-machine', pid: 4242, isPidActive: () => false,
    now: () => new Date('2026-07-20T10:00:00.000Z'),
  });
  const artifactService = new ArtifactService(new PathRendererService(), new FilesystemDocumentationTarget());
  const profile = actor === 'launcher'
    ? { profile: 'claude', provider: 'claude-code' as const }
    : {
        profile: 'opencode-glm', provider: 'opencode' as const,
        modelAlias: 'glm-5.2', model: 'z-ai/glm-5.2',
      };
  store.create(createRunState({
    id: 'run-agent', workflowId: 'feature', workflowSha256: 'a'.repeat(64),
    roles: { [actor]: profile.profile }, resolvedActors: { [actor]: profile },
    documentation: {
      target: { name: 'test', kind: 'filesystem', root: home, defaultFormat: 'markdown' },
      featurePath: 'Features/{{ feature.id }}',
      bindings: {
        project: { name: 'Test', slug: 'test' },
        feature: { id: 'IMP-1', slug: 'dispatch' }, run: { id: 'run-agent' },
      },
    },
    steps: [{
      id: 'work', kind: 'agent', actor, action: actor === 'launcher' ? 'feature-design' : 'implementation',
      output: { id: 'report', filename: '01 - Report.md' },
    }],
    now: '2026-07-20T10:00:00.000Z',
  }));
  const runner = new WorkflowRunnerService(
    store, events, locks, artifactService,
    new StaleInvalidationService(store, events, artifactService, () => new Date('2026-07-20T10:01:00.000Z')),
    () => new Date('2026-07-20T10:01:00.000Z'),
  );
  const processRunner = new FakeProcessRunner();
  const dispatch = new AgentDispatchService(
    store,
    new ProviderRegistryService([new ClaudeCodeProvider(), new CodexProvider(), new OpenCodeProvider()]),
    events,
    processRunner,
  );
  return { store, events, runner, processRunner, dispatch };
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('AgentDispatchService', () => {
  it('returns a launcher handoff without asking a process runner to execute anything', () => {
    const { runner, dispatch, processRunner } = setup('launcher');

    const handoff = dispatch.prepare('run-agent', runner.next('run-agent'));

    expect(handoff).toMatchObject({
      mode: 'interactive-handoff',
      instruction: { kind: 'native-skill', skill: 'superremy-codex:brainstorming' },
      expectedOutput: { id: 'report' },
    });
    expect(processRunner.calls).toEqual([]);
  });

  it('renders the launcher result from next as structured handoff JSON', async () => {
    const { runner, dispatch, processRunner } = setup('launcher');
    const output: string[] = [];

    await new NextCommand(runner, dispatch, (line) => output.push(line)).run(['run-agent']);

    expect(JSON.parse(output.join(''))).toMatchObject({
      kind: 'agent', mode: 'interactive-handoff', stepId: 'work',
    });
    expect(processRunner.calls).toEqual([]);
  });

  it('prepares OpenCode with its frozen model and records that preparation', () => {
    const { runner, dispatch, processRunner, events } = setup('implementer');

    const handoff = dispatch.prepare('run-agent', runner.next('run-agent'));

    expect(handoff).toMatchObject({
      mode: 'prepared-non-interactive',
      provider: 'opencode',
      invocation: { command: 'opencode', args: ['run', '--model', 'z-ai/glm-5.2'] },
    });
    expect(processRunner.calls).toHaveLength(1);
    expect(events.read('run-agent')).toContainEqual(expect.objectContaining({
      type: 'agent.invocation.prepared', modelAlias: 'glm-5.2', model: 'z-ai/glm-5.2',
    }));
  });
});
