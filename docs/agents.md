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
  glm-5.2: openrouter/z-ai/glm-5.2
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
  --feature-slug account-merge \
  --request "Allow an operator to merge two customer accounts safely."
```

Every actor required by the chosen workflow must have a profile. Unknown profile,
provider or OpenCode model alias values fail before a run is created.

## Execution and handoffs

`impresairio next <run-id>` prepares a structured handoff without executing it.
This is useful when a human wants to keep the agent interaction in their existing
Claude Code, Codex or OpenCode session.

`impresairio advance <run-id>` executes successive agent steps through the configured
local CLI until it reaches a human gate, a provider failure, or workflow completion.
The runner owns artifact persistence: agents return Markdown, which is then saved to
the expected documentation location. `complete` remains available when a handoff was
executed manually.

## Actions and prompt files

An action uses the provider's native skill only when that provider declares one.
For example, Claude Code can hand off `feature-design` to
a user-configured skill name. If no skill is configured, Impresairio supplies
a packaged fallback prompt for the declared action. This keeps workflows portable
without claiming that Claude, Codex and OpenCode have identical capabilities.

`promptFile` is different: its Markdown content is read and frozen at `start`.
The handoff carries that exact content, so an edit to the workflow directory later
does not silently change an in-progress run.

## OpenCode models

OpenCode profiles must name a model alias, and the alias must resolve through the
global `models` map. The prepared invocation always contains the resolved model ID,
for example `openrouter/z-ai/glm-5.2`; it never relies on a mutable default model. The
`agent.invocation.prepared` event records the alias and resolved ID before any
execution occurs.

## Connectivity checks

Run `impresairio doctor` from a configured repository to validate that each configured
provider executable is installed. Add `--live` to submit a minimal request, checking
authentication and the resolved OpenCode model ID as well. A live check may consume
provider credits.

```bash
impresairio doctor
impresairio doctor --live --profile opencode-glm
```

## Optional local skills

Impresairio has no bundled skill dependency. A profile may opt into skills that
already exist on the local machine; otherwise its action uses the portable
fallback prompt.

```yaml
agentProfiles:
  claude:
    provider: claude-code
    skills:
      feature-design: my-local-brainstorming-skill
```
