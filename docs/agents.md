# Agent profiles and hybrid handoffs

Impresairio V0 has exactly three provider implementations:

- `claude-code`
- `codex`
- `opencode`

They are fixed application providers. V0 does not discover plugins, execute arbitrary
shell commands from workflow YAML, or provide a generic provider marketplace.

## Global profiles

Profiles live in the global `config.yaml`. A repository workflow binds its
actors — free identifiers derived from the workflow's own steps, not a fixed
set — to profile names when a run starts.

```yaml
agentProfiles:
  claude:
    provider: claude-code
  codex:
    provider: codex
  opencode-glm:
    provider: opencode
    modelAlias: glm-5.2

models:
  glm-5.2: openrouter/z-ai/glm-5.2
```

The run freezes the selected profile name, provider and, for OpenCode, both the
model alias and resolved model ID. Later edits to global configuration cannot change
an active run. The same snapshot is recorded in the `run.started` event.

Bind roles with the repeatable `--actor <role>=<profile>` flag:

```bash
impresairio start feature \
  --actor launcher=claude \
  --actor adversary=codex \
  --actor implementer=opencode-glm \
  --feature-id IMP-42 \
  --feature-slug account-merge \
  --request "Allow an operator to merge two customer accounts safely."
```

The three original V0 flags — `--launcher`, `--adversary` and `--implementer` —
remain as shortcuts for the `launcher`, `adversary` and `implementer` roles and
may be freely mixed with `--actor`; binding the same role twice with
conflicting profiles (whether through repeated `--actor` bindings or a shortcut
flag) is an error. This is what makes custom workflows with invented role names
possible, for example a workflow that declares `actor: product-author` and
`reviewer: skeptic`:

```bash
impresairio start threat-model \
  --actor product-author=codex \
  --actor skeptic=claude \
  --feature-id IMP-51 \
  --feature-slug threat-model \
  --request "Threat-model the new export endpoint."
```

Every actor the chosen workflow declares must have a profile binding, and every
binding must name an actor the workflow actually declares — an unknown role
fails before a run is created, naming the offending role and the workflow's
declared roles. Unknown profile, provider or OpenCode model alias values also
fail before a run is created.

## Execution and handoffs

`impresairio next <run-id>` prepares a structured handoff without executing it.
This is useful when a human wants to keep the agent interaction in their existing
Claude Code, Codex or OpenCode session.

`impresairio advance <run-id>` executes successive agent steps through the configured
local CLI until it reaches a human gate, a provider failure, or workflow completion.
New runs freeze the repository's canonical directory at `start`, and every provider
process executes from that directory even when `advance` is invoked elsewhere.
Runs created by an older Impresairio version have no frozen repository field and
retain the legacy behavior of using the `advance` caller's current directory.
The runner owns artifact persistence: agents return Markdown, which is then saved to
the expected documentation location. Provider prompts must not ask an agent to read
or write an artifact path: the path can be outside the agent's repository sandbox,
and only Impresairio may publish it. `complete` remains available when a handoff was
executed manually.

## Capabilities and prompt files

A workflow step's `capability` is a free identifier resolved through the actor's
bound profile at `start`: a profile `skills` mapping, then a personal
`<IMPRESAIRIO_HOME>/prompts/<capability>.md` override, then the packaged
fallback prompt for that capability, in that order — see "Capability
resolution" in `docs/configuration.md`. The resolved method is frozen into the
run before any agent runs. This keeps workflows portable without claiming that
Claude, Codex and OpenCode have identical native abilities.

`promptFile` is different: its Markdown content is read and frozen at `start`.
The handoff carries that exact content, so an edit to the workflow directory later
does not silently change an in-progress run.

## Current model selection

OpenCode profiles must name a model alias, and the alias must resolve through the
global `models` map. The prepared invocation always contains the resolved model ID,
for example `openrouter/z-ai/glm-5.2`; it never relies on a mutable default model. The
`agent.invocation.prepared` event records the alias and resolved ID before any
execution occurs.

Several OpenCode profiles can resolve independently from the same global model map,
for example `opencode-glm` and `opencode-kimi`. A workflow still names only an
abstract actor; `start --actor <role>=<profile>` makes the profile choice explicit
and freezes its full provider-qualified model ID for that run.

Claude Code and Codex profiles currently use the respective CLI defaults. They do
not yet accept a configured model or reasoning-effort setting. The planned extension
is tracked in [issue #9](https://github.com/remyjallan/impresairio/issues/9).

## Planned profile selection by task complexity

The roadmap deliberately extends profiles rather than adding automatic provider
routing. A user will be able to define several profiles for the same provider — for
example `codex-luna`, `codex-terra`, and `codex-sol` — with an explicit model and
reasoning effort for each. The person starting a run then binds the appropriate
profile to each workflow role with `--actor` (or an existing role shortcut).

This keeps the complexity decision visible, reviewable, and frozen at run start;
workflow YAML continues to bind abstract roles and must not select a provider,
model, or profile itself. See [issue #9](https://github.com/remyjallan/impresairio/issues/9)
for the proposed configuration contract, validation, and execution requirements.

## Connectivity checks

Run `impresairio doctor` from a configured repository to validate that each configured
provider executable is installed. Add `--live` to submit a minimal request, checking
authentication and the resolved OpenCode model ID as well. A live check may consume
provider credits.

```bash
impresairio doctor
impresairio doctor --live --profile opencode-glm
```

OpenCode invocations use its JSON event format so Impresairio publishes only final
assistant text, never progress events. If OpenCode returns no text event or requests
permission instead, the step fails with a bounded diagnostic. Impresairio never adds
OpenCode's `--auto` flag or changes its permission configuration; review focused local
permission rules or run the handoff manually before retrying.

## Optional local skills

Impresairio has no bundled skill dependency. A profile may opt into skills that
already exist on the local machine; otherwise its capability uses the portable
fallback prompt.

```yaml
agentProfiles:
  claude:
    provider: claude-code
    skills:
      feature-design: my-local-brainstorming-skill
```
