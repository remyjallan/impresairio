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

The initial package workflows are `feature` and `quick-fix`. `feature` contains
bounded author/reviewer cycles for design, specification and integration plan,
each followed by a human approval gate, then implementation, final review and
report steps. Its public documents retain the historical sequence numbers 01,
03, 05, 07, 08 and 09; generated reviews are internal rather than occupying
02, 04 and 06. `quick-fix` contains investigate, implement and verify.

## Scheduling

`impresairio next <run-id>` is intentionally sequential:

- it starts only the first pending agent step;
- it returns an already in-progress current agent step without starting another;
- it reports the first pending gate and stops there;
- it ignores review-cycle steps explicitly marked `skipped`;
- it returns `complete` only when every recorded step is complete or skipped.

`complete` records manually executed agent output. `advance` executes prepared
agent invocations and calls the same completion path automatically. `approve`,
`request-changes` and `retry` own gate approval, stale invalidation and recovery.

## Security boundary

Validation is closed by default. Unknown YAML fields are errors. Therefore a workflow cannot add a `shell`, `provider`, `loop`, condition, arbitrary command or a dynamic expression. Inline prompts are not part of the grammar.

`promptFile` must be a relative `.md` path and cannot be absolute or contain traversal segments. Output filenames must be Markdown filenames, not paths. Template values are identifiers only. Bindings for documentation paths remain owned by the repository configuration rather than arbitrary workflow expressions. The V0 fixed keys are resolved during `start`, then stored in the run: `project.name`, `project.slug`, `feature.id`, `feature.slug` and `run.id`.

This protects the V0 workflow surface. It does not make locally installed workflow files trustworthy: teams should review repository workflow changes like source code.

## Bounded review cycles

`review-cycle` keeps a single canonical documentation artifact while repeating
an author/reviewer exchange up to `maxIterations` times. Reviewer outputs are
stored under the run directory, not in the documentation target. A reviewer
must end its output with `VERDICT: APPROVED`, `VERDICT: CHANGES_REQUESTED`, or
`VERDICT: BLOCKED`. Approval or blocking skips remaining cycle work and reaches
the named human gate; changes requested advances to the next consolidation.
If the final allowed review still requests changes, the cycle is marked
exhausted and emits `cycle.exhausted`. `next` and `advance` print a warning
before the gate, and `status` retains that warning so the human cannot mistake
the exhausted cycle for reviewer approval. A `BLOCKED` verdict similarly emits
`cycle.blocked` and remains visible through the same commands. The gate remains
a deliberate human decision point: approve the current artifact or request
changes to reopen it.
Generated `<id>-review-N`, `<id>-consolidate-N`, and `gateId` values are reserved
step IDs. Generated review output IDs are also reserved and cannot collide with
explicit workflow outputs.

```yaml
- id: design
  type: review-cycle
  actor: launcher
  reviewer: adversary
  action: feature-design
  reviewAction: adversarial-review
  maxIterations: 3
  output:
    id: design
    filename: "01 - Feature Design.md"
    template: feature-design
  gateId: approve-design
```

`maxIterations` is required and accepts values from 1 through 10. There is no
implicit default. `reviewer` must differ from `actor`. The canonical output uses
`storage: documentation` by default. Setting `storage: internal` stores it beneath
the run directory instead; generated review artifacts always use internal storage.
Workflow YAML is expanded and frozen when a run starts, so edits to these fields do
not migrate or alter an existing run.
