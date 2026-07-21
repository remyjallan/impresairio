# Documentation targets and outputs

Impresairio separates a documentation destination from the workflow that
produces a document. V0 supports one destination kind: a local filesystem
directory containing Markdown files. It may happen to be an Obsidian vault,
but Impresairio has no Obsidian dependency or vault-specific behavior.

## Configure a filesystem target

Define named targets in the global `config.yaml`:

```yaml
documentationTargets:
  personal-docs:
    kind: filesystem
    root: /Users/alex/Documents/Knowledge/Work/Dev
    defaultFormat: markdown
```

Then select it in a repository's `.impresairio.yaml`:

```yaml
project:
  name: Example Project
  slug: example-project

documentation:
  target: personal-docs
  featurePath: "Example Project/Specs/{{ feature.id }} - {{ feature.slug }}"
  format: markdown
```

`featurePath` is always relative to the target root. Its fixed substitutions
are documented in [configuration.md](configuration.md). Paths may not be
absolute or contain `..` segments.

## Workflow output naming

An agent step declares exactly one V0 output. The full path is deterministic:

```text
<documentation target root>/<rendered featurePath>/<rendered filename>
```

For example:

```yaml
- id: design
  type: agent
  actor: launcher
  action: feature-design
  output:
    id: design
    filename: "01 - Feature Design.md"
    template: feature-design
```

The `filename` must end in `.md`. The agent never selects a destination path;
`impresairio complete <run-id> <step-id>` uses the expected path recorded for
that step.

## Templates

`template` is optional. It identifies a packaged Markdown skeleton and is not
the prompt sent to an agent:

```yaml
output:
  id: design
  filename: "01 - Feature Design.md"
  template: feature-design
```

Impresairio creates the skeleton only when the output file is absent. It never
overwrites a document already at that path. Without `template`, it creates the
output directory but leaves the Markdown file for the agent to create freely.

V0 ships `feature-design` and `generic-markdown` templates. A workflow with an
unknown template is rejected.

## Completion checks and filesystem safety

Completion requires an existing, non-empty regular Markdown file. Impresairio
records its SHA-256 hash, path and format, then appends a `step.completed`
event through the run store.

Before every directory creation and every template write, the filesystem
target resolves the target root again and checks the root plus every existing
ancestor for symbolic links. The same validation runs before reading an output
for completion. This is intentionally repeated after initial path rendering:
an external process could replace a previously safe directory with a symlink
between the two operations. A detected symlink or an out-of-target path is
refused before the corresponding directory creation, write, or completion
read proceeds.

These checks are a best-effort protection for a trusted local filesystem. They
are not an atomic filesystem primitive and do not guarantee safety against a
hostile concurrent process that can replace a path after validation and before
the operating-system write call. V0 assumes the documentation target is under
the user's control; it rejects symlinks that it observes at render, directory
creation, write, or completion time. A stronger hostile-filesystem security
model is outside V0's scope.

V0 writes only to local filesystem targets and only in Markdown. Other
documentation systems and formats are deferred.
