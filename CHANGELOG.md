# Changelog

All notable changes to Impresairio are documented here.

The project follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and aims to follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- `abandon` command: audited, terminal abandonment of a run that can no longer proceed.
- `amend-host-handoff` command: reopen a completed host-handoff step (up to 20 times) before its dependents execute, archiving each prior revision.
- Manual/interactive host-handoff steps with `submit-host-output` for host-authored artifacts.
- External patch recovery: `prepare-external-agent-output` and `submit-agent-output` let a host author a runner-validated, runner-applied unified-diff patch when an agent patch step fails.
- Per-profile pinned model and reasoning effort for Claude Code and Codex profiles.
- Declared workflow execution authorization, surfaced through `advance --only-pre-authorized`.

### Fixed

- Controlled patch application validates the unified-diff `---/+++` body paths (the files Git actually writes) and requires any `diff --git` header to match, closing a header/body path-confusion that could modify or audit-misreport a different file.
- External agent recovery refuses to prepare against an abandoned run, and its double-submit guard is keyed on the current recovery so a legitimately re-armed recovery is no longer wedged.
- Amend, request-changes and retry persist the reopened run state before discarding a live internal artifact, so a save failure cannot orphan a completed step against a deleted file.
- Host output sources are read through a single file descriptor (no is-file/size read race), and pinned model identifiers are charset-validated and may not start with a hyphen.

- OpenCode now uses its JSON event output so progress is never published as a
  Markdown artifact; empty and permission-only responses fail with actionable,
  bounded diagnostics that preserve the frozen profile and model in the event log.
- Packaged fallback prompts and agent handoffs now require repository evidence, explicit assumptions, and truthful check reporting for repository-specific conclusions.
- Controlled patch application recalculates model-generated hunk lengths while retaining Git context and whitespace validation.
- Controlled patch application accepts standard unified diffs as well as diffs with optional `diff --git` headers.
- OpenCode execution now receives a path-free response contract, so sandboxed agents return Markdown to Impresairio instead of trying to access runner-owned artifact paths.
- OpenCode execution may inspect repository files while remaining unable to write or modify them.
- Codex execution now returns Markdown on stdout instead of attempting to write a runner-owned staging file from its read-only sandbox.

### Added

- Read-only `impresairio report <run-id>` reports for local run duration,
  agent attempts, human-gate waits, and recovery signals, with a JSON form for
  scripts.
- `advance` now reports safe agent progress on stderr and records bounded, redacted provider failure diagnostics in the run event log.
- Explicit, audited failed-step agent fallbacks through frozen global profile candidates and `impresairio fallback`.
- A narrow `patch: apply-unified-diff` workflow contract that lets Impresairio validate and apply agent-returned diffs to existing tracked files, with durable patch provenance.
- Typed workflow parameters, explicit composed-workflow `with` mappings, structured Markdown results, and safe conditional agent steps.
- Sequential YAML workflow composition through `uses: workflow:<id>`, including nested role mappings, frozen definition provenance, cycle detection and collision-safe artifacts.
- Free workflow capabilities and actor roles with start-time method resolution (`action` renamed to `capability`).
- Declarative terminal verdict policies with bounded retries, halted-run surfacing and an audited `acknowledge` command.
- V0 local CLI foundation for durable, human-gated engineering workflows.
- Built-in `feature` and `quick-fix` YAML workflows.
- Frozen Claude Code, Codex and OpenCode profile resolution, including OpenCode model aliases.
- Filesystem Markdown documentation targets with fixed path bindings.
- Durable run state, event logs, locks, approval integrity and stale recovery.
- `advance` execution with bounded review/consolidation cycles and explicit human gates.
- `doctor` provider diagnostics and `list` run discovery commands.
- Request-change feedback propagation, failed-step recovery and safe artifact publication.
- Visible exhausted or blocked review-cycle warnings and configurable agent execution timeouts.
- Frozen `--request` input supplied to every agent handoff for new runs.

## [0.1.0] - 2026-07-20

Initial dogfooding release candidate. It is intentionally limited to the V0 scope described in the README and documentation.
