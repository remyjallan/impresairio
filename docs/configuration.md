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
    skills:
      feature-design: superpowers:brainstorming
  codex:
    provider: codex
  opencode-glm:
    provider: opencode
    modelAlias: glm-5.2
  opencode-kimi:
    provider: opencode
    modelAlias: kimi-3

models:
  glm-5.2: openrouter/z-ai/glm-5.2
  kimi-3: openrouter/moonshotai/kimi-k2

execution:
  agentTimeoutSeconds: 1800
```

`documentationTargets` describes where documentation is delivered. The only
V0 kind is `filesystem`, and the only V0 format is `markdown`. A target may
point at an Obsidian vault, but Impresairio has no Obsidian runtime dependency;
it only writes Markdown files to the configured directory.

`agentProfiles` separates a stable profile name from the technical provider.
The built-in providers are `claude-code`, `codex`, and `opencode`. An
`opencode` profile must refer to a key in `models`; the alias and resolved model
identifier are retained by later run-state functionality.

Every profile may define an optional `skills` mapping from a capability
identifier (the free-form `capability`/`reviewCapability` value declared on a
workflow step) to a locally installed skill name. The default is an empty
mapping. Profile and skill mappings are resolved and frozen at run start;
changing `config.yaml` does not alter an in-progress run.

## Capability resolution

A workflow step's `capability` is a free identifier: it names work the step's
bound actor must perform, not a value from a fixed enum. At `start`, Impresairio
resolves each `capability` to a concrete method for the profile actually bound
to that step's actor, trying each of the following in order and stopping at the
first match:

1. the bound profile's `skills` map (`agentProfiles.<profile>.skills.<capability>`)
   — the frozen method is a native skill reference;
2. `<IMPRESAIRIO_HOME>/prompts/<capability>.md` — a personal, machine-local
   override, read once and frozen as prompt content;
3. the packaged prompt shipped with Impresairio for that capability
   (`prompts/builtins/<capability>.md` in the installed package) — frozen the
   same way.

If none of the three resolves, `start` fails before any run state is written,
naming the actor, its bound profile and the unresolved capability:

```text
actor "<actor>" (profile "<profileName>") has no method for capability "<capability>"; declare a skill in the profile or provide prompts/<capability>.md
```

No `prompts/` directory is required by default: the twelve built-in workflow
capabilities (`feature-design`, `adversarial-review`, `specification`,
`spec-review`, `integration-plan`, `plan-review`, `implementation`,
`final-review`, `final-report`, `investigate`, `implement`, `verification`)
all resolve through the packaged fallback prompts, so a bare `agentProfiles`
entry with no `skills` mapping is enough to run the built-in `feature` and
`quick-fix` workflows. A global `<IMPRESAIRIO_HOME>/prompts/<id>.md` file must
not be empty; an empty file is a start-time error. The resolved method (skill
reference, or the exact frozen prompt text and its source) is written into
`state.json` at start and never re-resolved: editing a skill mapping or a
prompt file afterward only affects runs started later.

`execution.agentTimeoutSeconds` limits each provider process launched by
`advance`. It is an integer from 1 through 86400 seconds and defaults to 1800
(30 minutes). The resolved value is frozen into a run at `start`; changing the
global configuration affects only new runs. Runs created before this setting
existed also read with the 1800-second default. A timeout marks the active step
`failed`, after which it can be resumed through `retry`.

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
