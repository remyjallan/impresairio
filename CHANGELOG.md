# Changelog

All notable changes to Impresairio are documented here.

The project follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and aims to follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Fixed

- Packaged fallback prompts and agent handoffs now require repository evidence, explicit assumptions, and truthful check reporting for repository-specific conclusions.
- Controlled patch application recalculates model-generated hunk lengths while retaining Git context and whitespace validation.
- Controlled patch application accepts standard unified diffs as well as diffs with optional `diff --git` headers.
- OpenCode execution now receives a path-free response contract, so sandboxed agents return Markdown to Impresairio instead of trying to access runner-owned artifact paths.
- OpenCode execution may inspect repository files while remaining unable to write or modify them.
- Codex execution now returns Markdown on stdout instead of attempting to write a runner-owned staging file from its read-only sandbox.

### Added

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
