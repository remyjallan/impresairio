# Bounded dynamic implementation phases

Status: discovery decision for issue #69. This document describes a proposed
runtime increment; it does not add a user-facing workflow YAML feature yet.

## Problem

An approved plan can contain several sensitive changes, such as migrations,
concurrency, and locking. Sending that whole plan to one implementation agent
produces one large patch and gives the runner no stable boundary for verification
or recovery between changes.

## Decision

Impresairio will accept a single, data-only implementation phase manifest from a
planning artifact. It will never accept generated workflow YAML, shell commands,
provider commands, or arbitrary step definitions.

The manifest is a fenced JSON block named `impresairio-phase-manifest`. Its
schema is implemented in `src/workflows/implementation-phase-manifest.ts` and
enforces these limits:

- One to six ordered phases.
- A lowercase phase ID, objective, bounded scope list, and verification list.
- Dependencies can name only preceding phases, which prevents cycles and makes
  execution order deterministic.
- A retry budget from zero to two and an optional human gate flag.
- Plain text only: no template expressions or control characters.

## Materialization boundary

The follow-up runtime increment will materialize the manifest only when all of
these conditions hold:

1. The source planning artifact is complete and covered by an approved gate.
2. No generated phase has started.
3. The run owns the resulting sequence; it does not create a sub-run.
4. The sequence and its manifest hash are written atomically to run state and a
   `phase-manifest.materialized` audit event is appended.

Each generated phase will use a fixed implementation pattern supplied by the
static workflow contract: implementation patch, optional provider review, and
optional human gate. The manifest supplies only phase data; it cannot select
providers, capabilities, output locations, or commands.

## Change policy

Before the first generated phase begins, an operator may discard a materialized
sequence and materialize a corrected manifest through an explicit command with a
reason recorded in the event log. Once a phase begins, adding, removing, or
reordering phases requires a dedicated human gate and a new audited amendment
flow. The first runtime increment will reject those changes rather than infer a
safe rewrite.

## Non-goals

- Parallel or unbounded phases.
- Executable manifests, generated YAML, or inline shell verification.
- A generic scheduler or replacement for a provider's native subagents.
- Changing existing static workflows without an explicit opt-in.

## Next increment

Implement an opt-in static workflow placeholder whose completed, approved
planning artifact is parsed with this contract. The runner will replace only that
placeholder with the fixed, frozen phase sequence and retain the remaining static
workflow steps unchanged.
