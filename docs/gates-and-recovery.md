# Gates, approvals and recovery

Impresairio gates are durable state transitions. They are not conversational
instructions: the gate state and its approval hash live in the run's
`state.json` and every mutation is protected by the run lock.

## Approving a gate

When `next` reports a gate, inspect the referenced document and approve it:

```bash
impresairio approve <run-id> <gate-id> --comment "Reviewed with product"
```

`approve` verifies that all preceding work is complete, reads the gate's
declared artifact from its resolved filesystem path, and records its SHA-256
hash, timestamp and optional comment. It does not accept a user-supplied path.

Before both `approve` and `next`, Impresairio re-hashes every previously
approved artifact. If one changed, disappeared or is no longer a regular safe
file, its approval is cleared, its producer and completed downstream work become
`stale`, and the command stops. Retry the affected work before progressing.

For an agent step, `next` records hashes of all completed earlier artifacts it
uses as inputs. If a design is edited after a review completed but before the
design gate is approved, approval detects the mismatch and stales that review.
The review must be retried against the revised design.

## Requesting changes

At a gate, send the artifact back to its producer with durable feedback:

```bash
impresairio request-changes <run-id> <gate-id> --comment "Clarify permissions and empty-state behavior"
```

This resets the producer to `pending`, stores the comment on the gate, clears
the gate approval, and recursively marks completed or in-progress successors
`stale`. Previously skipped review-cycle work is returned to `pending`, and the
feedback is injected into the producer's next handoff. Pending work stays pending. V0 derives this recursive relationship from
the fixed ordered workflow stored in the run; it is not a user-configurable DAG
or rules engine.

## Retrying stale work

Only an agent step in `stale` or `failed` state can be retried:

```bash
impresairio retry <run-id> <step-id>
impresairio next <run-id>
```

`retry` returns the step to `pending`, clears its current output metadata and
keeps its prior attempt records. The next `next` call creates a new attempt and
captures fresh input hashes. Gates cannot be retried directly.

An invalid or missing agent output, including a review without a final verdict,
makes `complete` or `advance` return an error and marks the step `failed`. The
failed attempt remains in history; correct the cause, run `retry`, then `next`
or `advance` to create a new attempt. This is intentionally different from a
validation error that leaves an in-progress step untouched.

If an earlier approval was invalidated, its gate is initially `stale`. Once the
ordered prerequisite sequence has been retried and completed, `next` reopens
that gate as `pending`; its old approval is never restored and the human must
approve the rebuilt artifact again.

## Halted verdicts

A step with a `verdictPolicy` halts the run when it ends with
`VERDICT: BLOCKED`, or when it ends with `VERDICT: CHANGES_REQUESTED` after its
retry budget is exhausted. `next` and `advance` then print a persistent warning
followed by `blocked: <step-id>`, and `status` repeats the warning until a
human resolves the halt. The run can never complete while an unresolved halt
exists.

Two audited recovery paths exist:

```bash
impresairio retry <run-id> <step-id>
impresairio acknowledge <run-id> <step-id> --comment "Verified locally outside the sandbox"
```

`retry` reruns the verification itself: the step returns to `pending`, its
verdict is cleared, and the next `next` or `advance` executes it again. Use it
when the underlying cause (for example a sandbox restriction) has been fixed.

`acknowledge` records a required human comment on the step, appends a
`verdict.acknowledged` event, and lets the run continue. The negative verdict
and its artifact remain in the state and event log for audit; acknowledging is
an explicit human decision, not a retroactive approval.

## Manual documents and filesystem scope

The V0 filesystem target is designed for a trusted local documentation folder.
It revalidates containment and rejects symlinks observed when it reads or
writes. It deliberately does not claim protection against a hostile process
replacing a filesystem entry between checks. If an integrity error occurs,
correct the local document or path, inspect `impresairio status <run-id>`, then
retry the stale producer.
