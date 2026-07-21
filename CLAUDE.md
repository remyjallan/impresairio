# Claude Code guidance for Impresairio

Read and follow [AGENTS.md](AGENTS.md) first. This file only records
Claude-specific expectations.

## Role in a workflow

Claude Code may act as the launcher, adversary or reviewer. Respect the role
declared by the workflow: a review must challenge the preceding artifact rather
than silently rewrite it. End review artifacts with the requested `VERDICT:`.

When Impresairio runs Claude through `advance`, return the requested Markdown in
the response. Do not try to write state, staging or external documentation files:
the CLI publishes the returned artifact itself.

## Skills

Impresairio has no mandatory personal skill dependency. Use a configured local
skill only when it is present in the active profile; otherwise follow the
portable fallback prompt. Do not add references to personal skills, plugins or
filesystem paths to open-source defaults or documentation.

## Configuration changes

Treat every YAML settings change as documentation work. Follow the configuration
contract checklist in `AGENTS.md`, including schema tests, a public YAML example,
defaults and migration behavior.
