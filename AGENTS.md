# Impresairio contributor guide

This file is the shared working agreement for Codex, Claude Code, OpenCode and
human contributors. `CLAUDE.md` adds only Claude-specific guidance; these rules
remain the source of truth.

## Project boundary

Impresairio is a local CLI for durable, human-gated engineering workflows. Keep
V0 pragmatic: do not introduce a hosted service, a generic workflow engine, a
marketplace, or a broad provider abstraction without a demonstrated use case.

The application owns persisted run state and artifact publication. Agent CLIs
return content; they must not be asked to write into Impresairio state or an
external documentation target directly.

## Repository language

All repository-maintained content must be written in English. This includes
source identifiers and comments, CLI help and errors, tests and fixtures, YAML
configuration and workflows, templates, documentation, contribution files,
commit messages and pull-request content. Do not add French text or bilingual
duplicates to the repository. Generated workflow artifacts may follow the
language requested by the run because they are user output, not repository
source material.

## Development workflow

- Use pnpm through Corepack: `corepack enable && pnpm install --frozen-lockfile`.
- Run focused tests while changing behavior, then run `pnpm run verify` before
  handoff.
- Preserve existing user changes. Do not reset, overwrite or delete unrelated
  work.
- Do not commit credentials, personal config, local runs, generated archives or
  files outside the repository.
- Keep changes small, typed and tested. Prefer an observed dogfooding need over
  a speculative abstraction.

## Configuration and YAML are public contracts

Any change affecting a settings or workflow YAML file is a user-facing contract
change. This includes global `config.yaml`, repository `.impresairio.yaml`, and
workflow files under `.impresairio/workflows/` or `src/workflows/builtins/`.

For every such change:

1. Update the relevant Zod/schema validation and add or update tests.
2. Document the field in the appropriate user-facing reference:
   `README.md`, `docs/configuration.md`, `docs/documentation-targets.md`, or
   `docs/workflows.md`.
3. Include a valid YAML example and describe defaults, validation failures,
   compatibility or migration behavior, and the effect on an in-progress run.
4. Update `.impresairio.example.yaml` when the repository example should expose
   the setting.

Never document a personal path, private skill, local plugin or provider secret
as though it were part of the open-source default configuration.

## Agent providers and execution

- Workflows bind abstract roles; they do not hard-code a user’s personal setup.
- OpenCode model aliases resolve from global configuration and must preserve the
  full provider-qualified model ID, for example `openrouter/z-ai/glm-5.2`.
- `impresairio doctor` checks configured local CLIs. `--live` intentionally
  spends a small provider request, so use it only when validating connectivity.
- `next` prepares a handoff. `advance` is the explicit execution path and must
  stop at human gates unless the caller has explicitly approved an automation
  scenario.

## Documentation and handoff

When behavior changes, update docs in the same change. Document user-visible
commands, configuration, failure recovery and security implications. In the
final handoff, state the verification actually run and any known limitation.
