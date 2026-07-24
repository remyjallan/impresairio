# Safe execution isolation and baselines

Status: discovery decision from issue #19, with the Git-baseline increment
implemented by #74. It adds no user-facing YAML setting, worktree, hook, or
autonomous execution mode.

## Observed boundary

Before #74, runs froze the repository directory at start, and patch application
required the Git worktree to be clean before the first runner-applied patch. It
then recorded a hash of the runner-owned working-tree diff and rejected a later
patch when that diff changed outside the run.

That protects patch application, but it does not preserve a Git revision at run
start. A commit, reset, branch switch, or pre-existing test failure cannot be
distinguished reliably from the runner's own changes after a long-running run.
The runner also has no safe ownership, cleanup, resume, or merge contract for
Git worktrees. Steps execute serially under a per-run lock; there is no parallel
scheduler or hook executor.

## Implemented boundary

The first runtime increment adds a clean Git baseline only for workflows that
contain a repository-patch step. It runs before the durable run is created,
without changing the repository. The start command:

1. Resolve the frozen repository directory to the Git worktree root.
2. Require both the index and working tree to be clean. It will never stash,
   reset, commit, or otherwise repair operator work.
3. Capture the resolved `HEAD` commit ID and a stable fingerprint of the clean
   repository state in immutable run state.
4. Append a baseline-captured event containing only audit-safe identifiers.

Before every patch application, the runner requires the current repository
revision to match the captured baseline and continue to verify the
runner-owned diff hash after each successful patch. A drift is a safe failure:
no patch is attempted and the operator must reconcile the repository outside
the run or use an explicit future recovery flow.

Non-Git repositories and artifact-only workflows remain supported. They do not
claim a Git baseline, and cannot use repository-patch steps.

## Verification baseline

Impresairio will not run tests automatically merely to label failures as
pre-existing. Shared workflow YAML intentionally cannot contain arbitrary shell
commands, and an implicit test command would be repository-specific and
unreliable.

A later, separately approved contract may introduce a small typed verifier with
an allowlisted command and persisted input, output, timeout, and exit status.
Only that contract could capture a before/after verification result. Until
then, agents may report checks in their artifacts, but the runner must not
present them as a machine-observed baseline.

## Isolation and parallelism

Git worktree isolation is deferred. It needs a durable ownership record for the
worktree path and source revision, recovery after interruption, explicit
cleanup, protection against an operator deleting or modifying it, and a clear
delivery rule for the resulting patch. Creating a worktree alone would not make
the current patch contract safe.

Parallel implementation is also deferred. It is valid only after a workflow
can declare independent bounded phases, explicit dependencies, disjoint
repository scopes, and deterministic merge or conflict behavior. The approved
phase-manifest work in #69 and its materialization follow-up #71 remain serial
by design.

`advance` remains explicitly human-gated. This decision adds no autonomous
mode, no background execution, and no provider permission expansion.

## Hooks

Shared workflow YAML will not receive arbitrary shell hooks. A future hook
proposal must define typed, allowlisted operations, bounded arguments, explicit
side-effect approval, durable audit events, and recovery semantics. That work
belongs with the external-effect and permission contracts tracked by #21.

## Deferred increments

Worktree isolation, typed verification baselines, parallel execution, and typed
hooks remain separate follow-ups. They require demonstrated use cases and their
own recovery, audit, and permission contracts.
