# Agent profiles and hybrid handoffs

Impresairio V0 has exactly three provider implementations:

- `claude-code`
- `codex`
- `opencode`

They are fixed application providers. V0 does not discover plugins, execute arbitrary
shell commands from workflow YAML, or provide a generic provider marketplace.

## Global profiles

Profiles live in the global `config.yaml`. A repository workflow binds its logical
actors (`launcher`, `adversary`, `implementer`) to profile names when a run starts.

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
  glm-5.2: z-ai/glm-5.2
```

The run freezes the selected profile name, provider and, for OpenCode, both the
model alias and resolved model ID. Later edits to global configuration cannot change
an active run. The same snapshot is recorded in the `run.started` event.

Start a built-in feature workflow with explicit bindings:

```bash
impresairio start feature \
  --launcher claude \
  --adversary codex \
  --implementer opencode-glm \
  --feature-id IMP-42 \
  --feature-slug account-merge
```

Every actor required by the chosen workflow must have a profile. Unknown profile,
provider or OpenCode model alias values fail before a run is created.

## Hybrid execution

`impresairio next <run-id>` deliberately prepares work; it does not launch an
agent process in V0.

- A `launcher` step emits a structured `interactive-handoff`: the existing Claude
  Code or Codex conversation can use the instructions and create the expected file.
- A non-launcher step emits a `prepared-non-interactive` handoff. The provider
  produces a structured command, arguments and input, but V0 does not execute it.
  This is the boundary where an explicitly enabled automatic mode can be added later.

In both cases the output path is part of the handoff. When the agent has written it,
finish the step with `impresairio complete <run-id> <step-id>`.

## Actions and prompt files

An action uses the provider's native skill only when that provider declares one.
For example, Claude Code can hand off `feature-design` to
`superremy-codex:brainstorming`. If no native skill is known, Impresairio supplies
a packaged fallback prompt for the declared action. This keeps workflows portable
without claiming that Claude, Codex and OpenCode have identical capabilities.

`promptFile` is different: its Markdown content is read and frozen at `start`.
The handoff carries that exact content, so an edit to the workflow directory later
does not silently change an in-progress run.

## OpenCode models

OpenCode profiles must name a model alias, and the alias must resolve through the
global `models` map. The prepared invocation always contains the resolved model ID,
for example `z-ai/glm-5.2`; it never relies on a mutable default model. The
`agent.invocation.prepared` event records the alias and resolved ID before any
future automatic execution could happen.
