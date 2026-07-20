# Configuration

Impresairio uses two YAML files. The global file contains user-specific
destinations and agent profiles; the repository file identifies a project and
selects one of those destinations. Impresairio reads these files but never
rewrites them.

## Global configuration

The global file is `<IMPRESAIRIO_HOME>/config.yaml` when the environment
variable is set. Otherwise it is stored in `~/.impresairio/config.yaml` on
macOS and Linux, or `%APPDATA%/Impresairio/config.yaml` on Windows. The
environment variable is useful for tests, portable installations, or separate
personal and work configurations.

```yaml
documentationTargets:
  personal-vault:
    kind: filesystem
    root: /Users/alex/Documents/Obsidian/Work/Dev
    defaultFormat: markdown

agentProfiles:
  claude:
    provider: claude-code
  codex:
    provider: codex
  opencode-glm:
    provider: opencode
    modelAlias: glm-5.2
  opencode-kimi:
    provider: opencode
    modelAlias: kimi-3

models:
  glm-5.2: z-ai/glm-5.2
  kimi-3: moonshotai/kimi-k2
```

`documentationTargets` describes where documentation is delivered. The only
V0 kind is `filesystem`, and the only V0 format is `markdown`. A target may
point at an Obsidian vault, but Impresairio has no Obsidian runtime dependency;
it only writes Markdown files to the configured directory.

`agentProfiles` separates a stable profile name from the technical provider.
The built-in providers are `claude-code`, `codex`, and `opencode`. An
`opencode` profile must refer to a key in `models`; the alias and resolved model
identifier are retained by later run-state functionality.

## Repository configuration

Every participating repository commits `.impresairio.yaml` in its root:

```yaml
project:
  name: Impresairio
  slug: impresairio

documentation:
  target: personal-vault
  featurePath: "Impresairio/Specs/{{ feature.id }} - {{ feature.slug }}"
  format: markdown
```

`documentation.target` must name a global `documentationTargets` entry.
`project.slug` is stable and uses lowercase letters, numbers, hyphens, or
underscores.

## Fixed path bindings

`featurePath` and workflow output filenames can use only these substitutions:

- `{{ project.name }}`
- `{{ project.slug }}`
- `{{ feature.id }}`
- `{{ feature.slug }}`
- `{{ run.id }}`

Bindings are literal substitutions, not an expression language. Environment
variables, functions, and unknown bindings are rejected. Rendered child paths
cannot be absolute, contain `..`, or resolve outside the selected filesystem
target root. During path rendering, Impresairio also rejects a configured
target root or any existing output ancestor that is a symbolic link. This keeps
the configured filesystem boundary from being silently redirected before a
later document write.

## Errors

Configuration errors identify the source file and field, for example:

```text
.../.impresairio.yaml: documentation.target: references unknown documentation target "team-docs"
```

Correct the YAML and run the command again; no configuration is silently
ignored or inferred.
