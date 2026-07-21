# V0 dogfooding protocol

V0 earns further abstraction only if two real runs demonstrate that durable state, explicit gates and cross-agent handoffs reduce friction. This document turns that decision into a small, comparable experiment rather than a feeling.

## Runs to perform

Run exactly two representative pieces of work before extending the runtime:

1. One non-trivial `feature` workflow, from design through final report.
2. One scoped `quick-fix` workflow, from investigation through verification.

Use the agents that reflect normal practice: a launcher (Claude Code or Codex), an independent adversary, and an OpenCode implementer profile with a pinned model when appropriate. Use the explicit `advance` command when testing execution, but do not bypass human gates or add a provider solely for the experiment.

## Record sheet

For each run, record the following in the final report or a separate local note. Times are elapsed minutes; do not count normal human product deliberation as tool friction.

| Measure | Definition |
| --- | --- |
| Completion | Did the run reach its final step without editing `state.json` or abandoning the run? |
| Manual recovery count | Number of `unlock --force`, state repair, duplicate `next`, or equivalent recovery actions. |
| Handoff correction count | Number of times an agent needed an extra manual instruction because the prepared handoff/output contract was unclear. |
| Gate overhead | Minutes spent locating the right artifact, understanding gate state or recovering an invalidated approval. |
| Gate value | Concrete issue found by the adversary or human gate that would likely have reached implementation. |
| Documentation accuracy | Whether every artifact arrived at the expected external path, with no unexpected file written. |
| Profile/model accuracy | Whether the frozen provider and OpenCode model in the handoff matched the intended run configuration. |

## Decision criteria

Treat V0 as successful when both runs complete without state-file repair or unexpected documentation writes, and the recorded gate value outweighs the observed gate overhead for the feature workflow.

Investigate before extending V0 when either run requires more than one manual recovery, a handoff repeatedly loses essential context, or the human cannot determine the next safe command from `status` and the emitted handoff.

Only then select the smallest response to the observed problem. Examples:

- Repeated inability to audit or choose the right provider model/effort may justify
  the narrowly scoped profile controls described in `docs/roadmap.md`.
- Repeated provider invocation mistakes may justify a narrowly scoped provider adapter or fallback policy.
- Repeated workflow duplication may justify one reusable YAML component.
- Repeated path configuration mistakes may justify another documentation target kind.
- No observed problem does **not** justify a generic provider API, expression engine, database, UI, marketplace or new runtime.

Keep the record with the dogfooded feature material so the V0 verdict can be reviewed independently.
