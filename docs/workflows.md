# Workflows (V0)

Impresairio workflows are deliberately small YAML files. They define the ordered
work for a run; the TypeScript CLI owns state changes, locking, output
verification, gate integrity and stale invalidation. A workflow is not a
general-purpose automation language.

## Resolution and reproducibility

`impresairio start <workflow-id>` searches for `<workflow-id>.yaml` in this order:

1. `<repository>/.impresairio/workflows/`;
2. `<IMPRESAIRIO_HOME>/workflows/`;
3. the workflows shipped with the installed package.

The repository is the current directory by default and may be supplied with `--repository`. A higher-precedence file completely replaces a lower-precedence file with the same ID. `start` also reads the repository configuration and its selected global documentation target. It requires explicit `--feature-id` and `--feature-slug` values for the fixed V0 bindings.

At start, Impresairio validates the selected file, creates an immutable run-step snapshot from it, and writes the SHA-256 of the exact YAML content to `state.json`. It freezes the resolved documentation target root, repository `featurePath`, project bindings, feature bindings and run ID at the same time. The snapshot includes each agent role, its action or prompt reference, declared output, and each gate artifact reference. When an agent step starts, its declared output is resolved from that frozen context into the exact filesystem output contract used by `complete`. Existing runs never reread workflow or configuration files; editing either only affects a subsequently started run.

## Grammar

Only these root keys are accepted:

```yaml
id: quick-fix
name: Quick fix
steps: []
```

`id`, step IDs and output IDs use lowercase letters, digits and hyphens, and begin with a letter. IDs must be unique. The V0 role names are exactly `launcher`, `adversary` and `implementer`.

An `agent` step declares its role, **exactly one** method, and exactly one Markdown output:

```yaml
- id: investigate
  type: agent
  actor: launcher
  action: investigate
  output:
    id: investigation
    filename: "01 - Investigation.md"
```

The method may instead refer to a versioned Markdown prompt file located below the workflow directory:

```yaml
- id: domain-analysis
  type: agent
  actor: launcher
  promptFile: prompts/domain-analysis.md
  output:
    id: analysis
    filename: "01 - Domain Analysis.md"
```

`action` is limited to the built-in V0 action names. Agent-provider behavior is
resolved separately from the workflow: a provider may offer a native skill, or
Impresairio supplies a packaged fallback prompt. An optional output `template`
is an approved template identifier, not a path:

```yaml
output:
  id: design
  filename: "01 - Feature Design.md"
  template: feature-design
```

A `gate` is a human approval boundary. It refers to an output from an earlier agent step:

```yaml
- id: approve-design
  type: gate
  artifact: design
```

The initial package workflows are `feature` and `quick-fix`. `feature` contains design, challenge, three human approval gates, specification, plan, implementation and cross-agent review/report steps. `quick-fix` contains investigate, implement and verify.

## Scheduling

`impresairio next <run-id>` is intentionally sequential:

- it starts only the first pending agent step;
- it returns an already in-progress current agent step without starting another;
- it reports the first pending gate and stops there;
- it returns `complete` only when every recorded step is complete.

`complete` remains the only way to mark an agent step complete. `approve`,
`request-changes` and `retry` own gate approval, stale invalidation and recovery.

## Security boundary

Validation is closed by default. Unknown YAML fields are errors. Therefore a workflow cannot add a `shell`, `provider`, `loop`, condition, arbitrary command or a dynamic expression. Inline prompts are not part of the grammar.

`promptFile` must be a relative `.md` path and cannot be absolute or contain traversal segments. Output filenames must be Markdown filenames, not paths. Template values are identifiers only. Bindings for documentation paths remain owned by the repository configuration rather than arbitrary workflow expressions. The V0 fixed keys are resolved during `start`, then stored in the run: `project.name`, `project.slug`, `feature.id`, `feature.slug` and `run.id`.

This protects the V0 workflow surface. It does not make locally installed workflow files trustworthy: teams should review repository workflow changes like source code.
