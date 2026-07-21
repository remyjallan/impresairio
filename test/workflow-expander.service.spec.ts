import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { HomeDirectoryResolver } from '../src/config/home-directory.resolver';
import { WorkflowExpanderService } from '../src/workflows/workflow-expander.service';
import {
  WorkflowError,
  WorkflowRegistryService,
} from '../src/workflows/workflow-registry.service';

const temporaryDirectories: string[] = [];

function createHarness() {
  const root = mkdtempSync(join(tmpdir(), 'impresairio-expander-'));
  temporaryDirectories.push(root);
  const home = join(root, 'home');
  const repository = join(root, 'repository');
  const packageDirectory = join(root, 'package');
  mkdirSync(join(repository, '.impresairio', 'workflows'), { recursive: true });
  mkdirSync(join(home, 'workflows'), { recursive: true });
  mkdirSync(packageDirectory, { recursive: true });
  const registry = new WorkflowRegistryService(
    new HomeDirectoryResolver({ IMPRESAIRIO_HOME: home }),
    { packageWorkflowsDirectory: packageDirectory, currentDirectory: () => repository },
  );
  return {
    repository,
    packageDirectory,
    registry,
    expander: new WorkflowExpanderService(registry),
    writePackage(id: string, yaml: string): void {
      writeFileSync(join(packageDirectory, `${id}.yaml`), yaml, 'utf8');
    },
    writeRepository(id: string, yaml: string): void {
      writeFileSync(join(repository, '.impresairio', 'workflows', `${id}.yaml`), yaml, 'utf8');
    },
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('WorkflowExpanderService', () => {
  it('expands a child workflow with actor mapping, namespaces and frozen provenance', () => {
    const harness = createHarness();
    harness.writePackage('child', `
id: child
name: Child
steps:
  - id: write
    type: agent
    actor: author
    capability: drafting
    output:
      id: draft
      filename: "01 - Draft.md"
  - id: approve
    type: gate
    artifact: draft
`);
    harness.writeRepository('parent', `
id: parent
name: Parent
steps:
  - id: design
    uses: workflow:child
    actors:
      author: launcher
`);

    const root = harness.registry.resolve('parent', harness.repository);
    const plan = harness.expander.expand(root, harness.repository);

    expect(plan.steps.map((step) => step.id)).toEqual([
      'design--write',
      'design--approve',
    ]);
    expect(plan.steps[0]).toMatchObject({
      type: 'agent',
      actor: 'launcher',
      output: { id: 'design--draft', filename: '01 - Draft.md' },
    });
    expect(plan.steps[1]).toMatchObject({
      type: 'gate',
      artifact: 'design--draft',
    });
    expect(plan.definitions).toEqual([
      expect.objectContaining({ instanceId: 'root', workflowId: 'parent', source: 'repository' }),
      expect.objectContaining({ instanceId: 'mount:design', workflowId: 'child', source: 'package' }),
    ]);
  });

  it('composes nested role mappings and rewrites review-cycle and verdict references', () => {
    const harness = createHarness();
    harness.writePackage('leaf', `
id: leaf
name: Leaf
steps:
  - id: implement
    type: agent
    actor: builder
    capability: implementation
    output:
      id: implementation
      filename: "07 - Implementation.md"
  - id: verify
    type: agent
    actor: reviewer
    capability: verification
    output:
      id: verification
      filename: "08 - Verification.md"
    verdictPolicy:
      changesRequested:
        retryFrom: implement
        maxIterations: 2
`);
    harness.writePackage('middle', `
id: middle
name: Middle
steps:
  - id: delivery
    uses: workflow:leaf
    actors:
      builder: implementer
      reviewer: technical-reviewer
  - id: design
    type: review-cycle
    actor: implementer
    reviewer: technical-reviewer
    capability: feature-design
    reviewCapability: adversarial-review
    maxIterations: 2
    output:
      id: design
      filename: "01 - Design.md"
    gateId: approve-design
`);
    harness.writeRepository('root-workflow', `
id: root-workflow
name: Root workflow
steps:
  - id: implementation
    uses: workflow:middle
    actors:
      technical-reviewer: adversary
`);

    const plan = harness.expander.expand(
      harness.registry.resolve('root-workflow', harness.repository),
      harness.repository,
    );
    const implement = plan.steps.find((step) => step.id === 'implementation--delivery--implement');
    const verify = plan.steps.find((step) => step.id === 'implementation--delivery--verify');
    expect(implement).toMatchObject({ type: 'agent', actor: 'implementer' });
    expect(verify).toMatchObject({
      type: 'agent',
      actor: 'adversary',
      verdictPolicy: {
        changesRequested: {
          retryFrom: 'implementation--delivery--implement',
        },
      },
    });
    expect(plan.steps.map((step) => step.id)).toContain('implementation--design-review-1');
    expect(plan.steps.map((step) => step.id)).toContain('implementation--design-consolidate-1');
    expect(plan.steps.at(-1)).toMatchObject({
      id: 'implementation--approve-design',
      type: 'gate',
      artifact: 'implementation--design',
    });
  });

  it('rejects direct and indirect composition cycles with the complete chain', () => {
    const harness = createHarness();
    harness.writeRepository('first', `
id: first
name: First
steps:
  - id: second
    uses: workflow:second
`);
    harness.writeRepository('second', `
id: second
name: Second
steps:
  - id: back
    uses: workflow:first
`);

    expect(() => harness.expander.expand(
      harness.registry.resolve('first', harness.repository),
      harness.repository,
    )).toThrow('Workflow composition cycle detected: first -> second -> first');
  });

  it('rejects actor mapping keys not exposed by the child', () => {
    const harness = createHarness();
    harness.writePackage('child', `
id: child
name: Child
steps:
  - id: work
    type: agent
    actor: author
    capability: drafting
    output: { id: draft, filename: "Draft.md" }
`);
    harness.writeRepository('parent', `
id: parent
name: Parent
steps:
  - id: child
    uses: workflow:child
    actors:
      missing: launcher
`);

    expect(() => harness.expander.expand(
      harness.registry.resolve('parent', harness.repository),
      harness.repository,
    )).toThrow('does not expose actor "missing"');
  });

  it('rejects a role mapping that collapses a review-cycle author and reviewer', () => {
    const harness = createHarness();
    harness.writePackage('child', `
id: child
name: Child
steps:
  - id: design
    type: review-cycle
    actor: author
    reviewer: reviewer
    capability: feature-design
    reviewCapability: adversarial-review
    maxIterations: 1
    output: { id: design, filename: "Design.md" }
    gateId: approve
`);
    harness.writeRepository('parent', `
id: parent
name: Parent
steps:
  - id: child
    uses: workflow:child
    actors:
      author: launcher
      reviewer: launcher
`);

    expect(() => harness.expander.expand(
      harness.registry.resolve('parent', harness.repository),
      harness.repository,
    )).toThrow('maps review-cycle "design" author and reviewer to actor "launcher"');
  });

  it('rejects generated identifier collisions after expansion', () => {
    const harness = createHarness();
    harness.writePackage('child', `
id: child
name: Child
steps:
  - id: work
    type: agent
    actor: launcher
    capability: drafting
    output: { id: draft, filename: "Draft.md" }
`);
    harness.writeRepository('parent', `
id: parent
name: Parent
steps:
  - id: child--work
    type: agent
    actor: launcher
    capability: drafting
    output: { id: root-draft, filename: "Root Draft.md" }
  - id: child
    uses: workflow:child
`);

    expect(() => harness.expander.expand(
      harness.registry.resolve('parent', harness.repository),
      harness.repository,
    )).toThrow(WorkflowError);
    expect(() => harness.expander.expand(
      harness.registry.resolve('parent', harness.repository),
      harness.repository,
    )).toThrow('Expanded step ID collision "child--work"');
  });

  it('accepts mounting the same child twice under distinct namespaces', () => {
    const harness = createHarness();
    harness.writePackage('child', `
id: child
name: Child
steps:
  - id: work
    type: agent
    actor: launcher
    capability: drafting
    output: { id: draft, filename: "Draft.md" }
`);
    harness.writeRepository('parent', `
id: parent
name: Parent
steps:
  - id: first
    uses: workflow:child
  - id: second
    uses: workflow:child
`);

    const plan = harness.expander.expand(
      harness.registry.resolve('parent', harness.repository),
      harness.repository,
    );
    expect(plan.steps.map((step) => step.id)).toEqual(['first--work', 'second--work']);
  });

  it('rejects ambiguous nested mount paths before provenance can contain duplicate instance IDs', () => {
    const harness = createHarness();
    harness.writePackage('leaf', `
id: leaf
name: Leaf
steps:
  - id: work
    type: agent
    actor: launcher
    capability: drafting
    output: { id: draft, filename: "Draft.md" }
`);
    harness.writePackage('middle', `
id: middle
name: Middle
steps:
  - id: b
    uses: workflow:leaf
`);
    harness.writeRepository('parent', `
id: parent
name: Parent
steps:
  - id: a--b
    uses: workflow:leaf
  - id: a
    uses: workflow:middle
`);

    expect(() => harness.expander.expand(
      harness.registry.resolve('parent', harness.repository),
      harness.repository,
    )).toThrow('Workflow instance ID collision "mount:a--b"');
  });

  it('allows a root-level composition step named root without colliding with root provenance', () => {
    const harness = createHarness();
    harness.writePackage('child', `
id: child
name: Child
steps:
  - id: work
    type: agent
    actor: launcher
    capability: drafting
    output: { id: draft, filename: "Draft.md" }
`);
    harness.writeRepository('parent', `
id: parent
name: Parent
steps:
  - id: root
    uses: workflow:child
`);

    const plan = harness.expander.expand(
      harness.registry.resolve('parent', harness.repository),
      harness.repository,
    );
    expect(plan.steps[0].id).toBe('root--work');
    expect(plan.definitions.map((definition) => definition.instanceId)).toEqual([
      'root',
      'mount:root',
    ]);
  });
});
