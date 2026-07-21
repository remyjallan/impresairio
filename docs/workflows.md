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

The repository is the current directory by default and may be supplied with
`--repository`. A higher-precedence file completely replaces a lower-precedence
file with the same ID. `start` also reads the repository configuration and its
selected global documentation target. It requires explicit `--feature-id` and
`--feature-slug` values for the fixed V0 bindings, plus a non-empty `--request`
of at most 20,000 characters describing the work to perform.

At start, Impresairio validates the selected file, recursively resolves any
composed workflows, and creates an immutable leaf-step snapshot. It writes the
SHA-256 of the exact root YAML plus an ordered manifest containing the source
and SHA-256 of every resolved workflow definition to `state.json`. It freezes
the work request, resolved documentation target root,
repository `featurePath`, project bindings, feature bindings and run ID at the
same time. The snapshot includes each agent role, its resolved capability method
or prompt reference, declared output, and each gate artifact reference. Every
handoff receives the frozen request before its accumulated artifact context and
human feedback. When an agent step starts, its declared output is resolved from
that frozen context into the exact filesystem output contract used by
`complete`. Existing runs never reread workflow or configuration files; editing
either only affects a subsequently started run.

## Grammar

Only these root keys are accepted:

```yaml
id: quick-fix
name: Quick fix
steps: []
```

`id`, step IDs and output IDs use lowercase letters, digits and hyphens, and begin with a letter. `actor` is a free identifier: a workflow may name any actor it needs (`launcher`, `product-author`, `skeptic`, ...), and the set of actors a run must bind is derived from the workflow's own steps — there is no fixed enum of role names.

An `agent` step declares its role, **exactly one** method, and exactly one Markdown output:

```yaml
- id: investigate
  type: agent
  actor: launcher
  capability: investigate
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

`capability` is also a free identifier, not a fixed enum: it names work the bound
actor must be able to perform, and it is resolved to a concrete method — a
native provider skill or a fallback prompt — through the actor's bound profile
when the run starts. See "Capability resolution" in `docs/configuration.md` for
the exact lookup order. An optional output `template`
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

## Parameters

A workflow may declare primitive parameters. Names use the normal workflow identifier
syntax. `start` accepts each root value through repeatable `--param name=value`
options; resolved values, including defaults, are frozen in the run state.

```yaml
parameters:
  quality-mode:
    type: enum
    values: [light, standard, strict]
    default: standard
  require-review:
    type: boolean
    default: true
  max-files:
    type: integer
    minimum: 1
    maximum: 500
    default: 80
```

Supported types are `string`, `boolean`, `integer`, and `enum`. A string is a
single-line literal; booleans are exactly `true` or `false`; and integers are base-10
integers. Unknown names, duplicate values, invalid types, out-of-range values, and a
missing parameter without a default stop `start` before a run is created. Parameters
are persisted and included in handoffs, so they must not contain secrets.

## Structured results and conditions

An agent may declare a small, strict result object in addition to its Markdown output.
It appends exactly one fenced `impresairio-result` JSON block; `complete` and
`advance` validate it before marking the step complete.

```yaml
- id: classify
  type: agent
  actor: implementer
  capability: change-classification
  output:
    id: classification
    filename: "00 - Classification.md"
    storage: internal
  result:
    fields:
      complexity:
        type: enum
        values: [trivial, standard, complex]
```

````text
```impresairio-result
{"complexity":"standard"}
```
````

Result fields use the same four primitive types but cannot define defaults. A missing,
duplicate, malformed, or invalid block leaves the step `in_progress` so its artifact
can be corrected and `complete` repeated. It does not silently coerce data or consume
a retry.

`when` is available only on direct `agent` steps. It accepts `equals`, `notEquals`,
`all`, `any`, and `not`, and may read only an effective parameter or a declared result
field from an earlier agent step:

```yaml
when:
  notEquals:
    left:
      result:
        step: classify
        field: complexity
    right: trivial
```

A false condition becomes an explicit `skipped` step and emits an event. It is reset
when the source step is retried or becomes stale. Conditions cannot execute code, read
files or environment variables, inspect raw Markdown, or apply to gates, review
cycles, or composed steps.

The package workflows are `feature`, `quick-fix`, and the small dogfooding workflow
`classification-smoke`. `feature` contains
bounded author/reviewer cycles for design, specification and integration plan,
each followed by a human approval gate, then implementation, final review and
report steps. Its public documents retain the historical sequence numbers 01,
03, 05, 07, 08 and 09; generated reviews are internal rather than occupying
02, 04 and 06. `quick-fix` contains investigate, implement and verify.

## Migration: `action` renamed to `capability`

Older workflow YAML used `action` on an `agent` step and `action`/`reviewAction`
on a `review-cycle` step. Both were renamed: `action` is now `capability`, and
`reviewAction` is now `reviewCapability`. A workflow file that still declares
the old key fails to parse with a dedicated error naming the offending file:

```text
<path>: "action" was renamed to "capability"; update the workflow step
<path>: "reviewAction" was renamed to "reviewCapability"; update the workflow step
```

Update the workflow file to the new key with the same value; no other change
is required. This migration is a parse-time rename only. Runs already frozen
by an earlier Impresairio version are unaffected: their `state.json` keeps
whatever method shape (including the legacy `{ action }` form) was resolved
when that run started, and `next`/`complete`/`advance` continue to dispatch it
exactly as before.

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

Validation is closed by default. Unknown YAML fields are errors. Therefore a workflow cannot add a `shell`, `provider`, loop, arbitrary command, dynamic expression, or inline prompt. `when` is a deliberately closed condition grammar over declared parameters and structured results only.

`promptFile` must be a relative `.md` path and cannot be absolute or contain traversal segments. Output filenames must be Markdown filenames, not paths. Template values are identifiers only. Bindings for documentation paths remain owned by the repository configuration rather than arbitrary workflow expressions. The V0 fixed keys are resolved during `start`, then stored in the run: `project.name`, `project.slug`, `feature.id`, `feature.slug` and `run.id`.

This protects the V0 workflow surface. It does not make locally installed workflow files trustworthy: teams should review repository workflow changes like source code.

## Workflow composition

A workflow may insert another workflow as an ordered step:

```yaml
id: full-feature
name: Full feature
steps:
  - id: design
    uses: workflow:feature-design
    actors:
      author: launcher
      reviewer: adversary

  - id: implementation
    uses: workflow:proportional-implementation
    actors:
      reviewer: adversary
```

`uses` accepts only `workflow:<id>`. The referenced workflow uses the same
repository, global, then package precedence as a directly started workflow.
References may be nested; direct and indirect composition cycles fail `start`
with the complete cycle chain. Composition is sequential in this release and
does not accept artifact exports or parallel branches.

A composed step may pass primitive parameters to its direct child with `with`.
Values are either literals or an explicit reference to an immediate parent parameter:

```yaml
parameters:
  quality-mode:
    type: enum
    values: [light, strict]
    default: light
steps:
  - id: implementation
    uses: workflow:proportional-implementation
    with:
      quality-mode:
        fromParameter: quality-mode
```

Every `with` key must be declared by the child; omitted child parameters use their
own default or make `start` fail if required. Child mappings are type checked and
resolved recursively at `start`, not dynamically during execution.

The optional `actors` map is written from child role to parent role. An omitted
child role keeps its name, so mappings may be partial. In the example,
`reviewer` inside `feature-design` becomes the root `adversary`, while an
unmapped child role such as `implementer` remains `implementer`. The final set
of roles is derived after all nested mappings and must be bound with `--actor`
or a compatible role shortcut. Mapping a review-cycle author and reviewer onto
the same final role is rejected.

Child leaf IDs are namespaced with the mount ID and `--`:

```text
implementation--classify
implementation--implement
implementation--review-review-1
```

Step IDs, output IDs, gate artifact references, verdict retry targets and
review-cycle generated IDs are rewritten together. Root step IDs are unchanged.
The expanded agent/gate steps are the only executable steps persisted in
`state.json`; `workflow.definitions` records the `root` definition and each
`mount:<namespace>` workflow instance, its resolution source and its exact YAML
hash. Absolute definition paths are not persisted. Existing runs without that optional manifest remain
readable. A child `promptFile` is read relative to the child YAML that declares
it, and its exact content is frozen before the run is created.

Gates remain owned by the child workflow that declares them. A parent cannot
reach into an unexported child output. Output filenames are deliberately not
namespaced, so the workflow author retains control over public document names.
Before persisting a run, Impresairio resolves every output destination and
rejects different logical outputs that would write to the same physical path.
The comparison is Unicode-normalized and case-insensitive so a workflow remains
safe when moved between Linux, macOS and Windows filesystems.
Canonical review-cycle consolidations may reuse their own output ID and path.
Mounting the same publishing workflow twice therefore requires distinct
filenames; parameterized filenames remain outside this workflow contract.

Example standalone child:

```yaml
id: feature-design
name: Feature design
steps:
  - id: design
    type: review-cycle
    actor: author
    reviewer: reviewer
    capability: feature-design
    reviewCapability: adversarial-review
    maxIterations: 2
    output:
      id: design
      filename: "01 - Feature Design.md"
    gateId: approve-design
```

The following errors stop `start` before state, events or documentation are
created: an unresolved child, invalid actor mapping key, composition cycle,
ambiguous mount namespace, post-expansion ID collision, output destination
collision, mapped author and reviewer equality, unresolved capability, or
invalid child prompt file.

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
  capability: feature-design
  reviewCapability: adversarial-review
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

## Terminal verdict policies

Any `agent` step may declare how its final `VERDICT:` line drives the workflow.
The policy is never inferred from a step name or capability; it must be
declared:

```yaml
- id: verify
  type: agent
  actor: adversary
  capability: verification
  output:
    id: verification
    filename: "03 - Verification.md"
  verdictPolicy:
    approved: continue          # optional; the only accepted value
    changesRequested:
      retryFrom: implement      # required; must name an earlier agent step
      maxIterations: 2          # required; integer from 1 through 10
    blocked: stop               # optional; the only accepted value
```

A step carrying a `verdictPolicy` must produce an artifact whose final line is
exactly one of `VERDICT: APPROVED`, `VERDICT: CHANGES_REQUESTED` or
`VERDICT: BLOCKED`. A missing or malformed verdict marks the step `failed`;
correct the artifact source and `retry`.

Defaults and behavior:

- Without a `verdictPolicy` block the step keeps the V0 behavior: no verdict is
  read.
- `APPROVED` lets the run continue (or complete).
- `CHANGES_REQUESTED` reopens the `retryFrom` step, returns the intermediate
  agent work and the verdict step itself to `pending` (gates in between are
  staled and reopen once their prerequisites are rebuilt), and injects the
  verdict artifact into the reopened step as reviewer feedback. Each pass consumes one of
  `maxIterations`; when the budget is exhausted the run halts for a human
  decision instead of completing. Without a `changesRequested` block a
  `CHANGES_REQUESTED` verdict halts immediately.
- `BLOCKED` always halts the run with a persistent warning and a
  `verdict.blocked` event. There is no implicit success.
- `verdictPolicy` is rejected on `gate` and `review-cycle` steps; bounded
  review cycles keep their built-in verdict handling.

The built-in `quick-fix` workflow declares a policy on `verify`
(`retryFrom: implement`) and the built-in `feature` workflow declares one on
`final-review` (`retryFrom: implementation`). Policies are frozen into the run
at `start`; editing a workflow file never changes an in-progress run.
