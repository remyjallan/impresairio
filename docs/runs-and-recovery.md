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
documentation context, and creates durable state. It also freezes the selected
agent profiles and resolved OpenCode model identifiers for the run.

```bash
impresairio start quick-fix \
  --launcher claude \
  --adversary codex \
  --implementer opencode-glm \
  --run-id run-example

impresairio status run-example
```

`status` is read-only. It reports the run identifier, recorded workflow,
current step and number of resolved steps. Use `next` to prepare the next agent
handoff or reveal the next human approval gate.

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
