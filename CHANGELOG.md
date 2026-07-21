# Changelog

All notable changes to Impresairio are documented here.

The project follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and aims to follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

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
