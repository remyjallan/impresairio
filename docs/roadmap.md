# Roadmap

This roadmap records approved next-step product work. It is intentionally narrow:
items become implementation work only when their acceptance criteria are met without
expanding Impresairio into an automatic agent runtime or a generic provider layer.

## Provider-specific model and reasoning profiles

**Status:** planned; not supported by the current release.

### Problem

Claude Code and Codex profiles currently invoke each CLI with its mutable default
model and reasoning configuration. That prevents a run from expressing the intended
cost, latency, and capability trade-off, and it makes it awkward to choose a lighter
or stronger instance of the same provider for work of different complexity.

### Goal

Allow a global agent profile to pin the model and reasoning effort for Claude Code
and Codex, just as an OpenCode profile already pins its model. Multiple profiles may
use the same provider, so a human can make the complexity decision explicitly when
starting a run.

The target configuration shape is:

```yaml
agentProfiles:
  claude-fast:
    provider: claude-code
    model: <Claude Code model identifier>
    reasoningEffort: <Claude Code supported effort>
  codex-luna:
    provider: codex
    model: <Codex model identifier>
    reasoningEffort: <Codex supported effort>
  codex-terra:
    provider: codex
    model: <Codex model identifier>
    reasoningEffort: <Codex supported effort>
  codex-sol:
    provider: codex
    model: <Codex model identifier>
    reasoningEffort: <Codex supported effort>
```

The identifiers are intentionally provider-owned values, rather than a shared
Impresairio model catalogue. This avoids conflating provider-specific availability,
model naming, and effort scales. The implementation documentation must show valid
values for the supported local CLI versions before this becomes a public contract.

Profiles are selected at run start, for example:

```bash
impresairio start feature \
  --actor launcher=codex-terra \
  --actor adversary=codex-sol \
  --actor implementer=claude-fast \
  --feature-id IMP-42 \
  --feature-slug account-merge \
  --request "Allow an operator to merge two customer accounts safely."
```

This selection is explicit and may differ by role. It is not an automatic
complexity classifier or dynamic fallback mechanism.

### Scope and compatibility

- Add optional `model` and `reasoningEffort` fields only to `claude-code` and
  `codex` agent profiles. Omitted fields preserve today's CLI-default behaviour.
- Preserve OpenCode's existing `modelAlias` and resolved-model contract. Do not
  replace it with the new fields as part of this work.
- Continue to allow any number of named profiles per provider. Profile names are
  user-defined and are the only values workflows receive through role bindings.
- Keep model, effort, and provider selection out of workflow YAML. This preserves
  portable workflows and prevents configuration changes from being hidden inside a
  repository workflow.
- Do not add automatic routing based on task complexity, cost, token count, or a
  model catalogue. A human chooses the profile when creating the run.

### Acceptance criteria

1. The global configuration schema validates the new fields and reports the exact
   profile field on invalid values. Validation is provider-specific and accepts only
   values supported by the corresponding installed CLI contract.
2. Claude Code and Codex provider adapters pass the selected model and reasoning
   effort to their native CLI invocation. `doctor --live` uses the same settings as
   `advance`, so a profile can be checked before a run spends substantive work.
3. `start` resolves and freezes the profile name, provider, model, and reasoning
   effort in `state.json` and the `run.started` event. A prepared invocation records
   the same effective settings. Editing `config.yaml` cannot affect an active run.
4. `next`, `advance`, retry, and status display enough profile information to audit
   which model and effort are being used without exposing credentials or mutable CLI
   defaults.
5. Tests cover schema validation, invocation arguments, live health-check planning,
   run-state freezing, omitted-field compatibility, and multiple Codex profiles in
   one configuration.
6. `README.md`, `docs/configuration.md`, and `docs/agents.md` document the final
   provider-specific YAML syntax, defaults, failures, migration behaviour, and the
   effect on an in-progress run.

### Implementation order

1. Confirm the stable Claude Code and Codex CLI flags and their supported effort
   values for the versions Impresairio supports.
2. Extend the configuration and resolved-profile types, then add provider adapter
   tests before modifying command construction.
3. Persist the effective values in run state and events, and verify retry and manual
   handoff behaviour.
4. Publish the configuration documentation and run the full verification suite.
