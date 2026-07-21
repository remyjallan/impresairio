# Runs, locks and recovery

Impresairio V0 stores every run under its local home directory:

```text
<impresairio-home>/runs/<run-id>/
├── state.json
└── events.jsonl
```

The home directory is selected by the existing `IMPRESAIRIO_HOME` override, or
the platform default. A run state is JSON validated on every read and written by
replacing a sibling temporary file. `events.jsonl` is an append-only sequence of
one JSON event per line.

## Start and inspect a run

`start` resolves and validates a workflow, snapshots its ordered steps and
documentation context, and creates durable state. It also freezes the canonical
repository directory, selected agent profiles and resolved OpenCode model identifiers
for the run. `advance` therefore executes providers in the original repository even
when the command is invoked from another directory.

```bash
impresairio start quick-fix \
  --launcher claude \
  --adversary codex \
  --implementer opencode-glm \
  --run-id run-example \
  --feature-id BUG-42 \
  --feature-slug escaped-output \
  --request "Unknown commands containing a newline are printed without escaping."

impresairio status run-example
```

`status` is read-only. It reports the run identifier, recorded workflow,
current step, number of resolved steps and the status of every step. Use it to
identify stale or failed work before `retry`, then use `next` to prepare the
next agent handoff or reveal the next human approval gate.

Every new run requires `--request`. Impresairio trims, validates and freezes
that text in `state.json`, then supplies it to every agent handoff. Existing
runs created before this field was introduced remain readable and continue
without it. Requests are persisted in plaintext and may also remain in shell
history, so they must not contain credentials or other secrets.

Runs created before the repository directory was frozen also remain readable. For
those legacy runs only, invoke `advance` from the intended repository directory;
new runs are independent of the caller's current directory.

If a bounded review cycle reaches its final iteration with
`VERDICT: CHANGES_REQUESTED`, `status` shows a persistent warning until the
following gate is either approved or reopened through `request-changes`.
`events.jsonl` also records the corresponding `cycle.exhausted` event.
A `VERDICT: BLOCKED` review behaves the same way and records `cycle.blocked`.

## Verdict events

Steps that declare a `verdictPolicy` append dedicated events to
`events.jsonl`: `verdict.changes_requested` (with the reopened step),
`verdict.exhausted`, `verdict.blocked` and `verdict.acknowledged` (with the
human comment). When a halt is unresolved, `next` and `advance` print
`blocked: <step-id>` instead of progressing and `status` repeats the warning;
see [gates and recovery](gates-and-recovery.md) for the recovery commands.

## Single-writer lock

Mutating commands use a per-run `.lock` directory. Its `metadata.json` records
the process ID, hostname, command and creation time. Creating the directory is
atomic, so a second local process receives `run busy: <run-id>` instead of
modifying the same state concurrently.

On the same host, a lock whose recorded PID is no longer active is recovered
automatically. A lock owned by another host, or an active local PID, is never
removed implicitly. A missing or malformed `metadata.json` is also treated as
unsafe: it is left in place unless `--force` is explicitly supplied.

If you have confirmed the owner has stopped, remove that lock explicitly:

```bash
impresairio unlock run-example --force
```

Forced unlocks append a `run.unlock.forced` record to `events.jsonl`, including
the previous PID and hostname when available. Do not use `--force` while
another Impresairio command is still running for the run.

## Manual recovery

If a command stops unexpectedly, inspect the state first:

```bash
impresairio status run-example
```

Then use `unlock --force` only after checking the lock owner is not active. The
state file remains the source of truth; never edit it to work around a lock.
Run IDs are intentionally restricted to letters, numbers, `_` and `-`; paths,
separators and traversal-like IDs are rejected before any run file is accessed.

## Listing runs

Use `impresairio list` to find durable run IDs. It lists readable runs newest
first; a damaged state file does not hide the other runs.
