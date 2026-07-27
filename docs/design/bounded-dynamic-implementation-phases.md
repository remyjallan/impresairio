# Bounded dynamic implementation phases

Status: implemented runtime increment for #71, based on the discovery decision
in #69.

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

The runtime materializes the manifest only when all of these conditions hold:

1. The source planning artifact is complete and covered by an approved gate.
2. No generated phase has started.
3. The run owns the resulting sequence; it does not create a sub-run.
4. The sequence and its manifest hash are written to run state before a
   `phase-manifest.materialized` audit event is appended.

Each generated phase will use a fixed implementation pattern supplied by the
static workflow contract: implementation patch, optional provider review, and
optional human gate. The manifest supplies only phase data; it cannot select
providers, capabilities, output locations, or commands.

## Change policy

Once materialized, the sequence is immutable. A malformed, unavailable, or
unapproved source artifact leaves the placeholder pending without changing the
run. Correct the approved plan before materialization; after materialization,
abandon the run and start a new one rather than editing durable state.

## Non-goals

- Parallel or unbounded phases.
- Executable manifests, generated YAML, or inline shell verification.
- A generic scheduler or replacement for a provider's native subagents.
- Changing existing static workflows without an explicit opt-in.

## Static placeholder

`implementation-phases` is the opt-in static workflow placeholder. It names a
preceding approved artifact, a fixed implementation actor/capability, and an
optional fixed reviewer/capability. The manifest never chooses these values. The
runner replaces only this placeholder and retains the remaining static workflow
steps unchanged.
