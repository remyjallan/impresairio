# Impresairio

Impresairio is a local, durable CLI for coordinating AI-assisted engineering workflows. It keeps workflow state, human approvals and documentation contracts outside an application repository while allowing each repository to share small YAML workflow definitions.

V0 is intentionally pragmatic:

- Ordered `feature` and `quick-fix` workflows.
- Abstract roles (`launcher`, `adversary`, `implementer`) bound to Claude Code, Codex or OpenCode profiles at run start.
- Explicit human approval gates, retry and stale-artifact invalidation.
- Markdown output to a configurable local filesystem destination, including a folder that happens to be an Obsidian vault.
- Prepared handoffs plus explicit `advance` execution through the configured local CLIs.

It is **not** a hosted project-management tool, a generic workflow engine, an agent marketplace or an autonomous multi-agent runtime.

## Community

Read [CONTRIBUTING.md](CONTRIBUTING.md) before proposing a change, [SECURITY.md](SECURITY.md) to report vulnerabilities privately, and [SUPPORT.md](SUPPORT.md) for help channels. Participation is governed by the [Code of Conduct](CODE_OF_CONDUCT.md).

## Documentation

The [GitHub wiki](https://github.com/remyjallan/impresairio/wiki) is the canonical guide for CLI usage, YAML configuration, agent profiles, workflows, recovery, and documentation targets.

## Requirements and installation

- Node.js 22 or newer

Once published to npm:

```bash
npm install -g @impresairio/cli
impresairio --help
```

For local development:

```bash
git clone <your-fork-or-clone-url>
cd impresairio
corepack enable
pnpm install --frozen-lockfile
pnpm run verify
node dist/main.js --help
```

`npx @impresairio/cli --help` will also work after publication. pnpm is only required for repository development.

## Minimal configuration

Impresairio reads, but never rewrites, two YAML files. The global file is `~/.impresairio/config.yaml` on macOS/Linux or `%APPDATA%/Impresairio/config.yaml` on Windows. Override this location with `IMPRESAIRIO_HOME`.

```yaml
# ~/.impresairio/config.yaml
documentationTargets:
  personal-docs:
    kind: filesystem
    root: /Users/alex/Documents/Knowledge/Work/Dev
    defaultFormat: markdown

agentProfiles:
  claude:
    provider: claude-code
  codex:
    provider: codex
  opencode-glm:
    provider: opencode
    modelAlias: glm-5.2

models:
  glm-5.2: openrouter/z-ai/glm-5.2
```

Each participating repository commits its own `.impresairio.yaml`:

```yaml
project:
  name: Example
  slug: example

documentation:
  target: personal-docs
  featurePath: "Example/Specs/{{ feature.id }} - {{ feature.slug }}"
  format: markdown
```

This repository ships [.impresairio.example.yaml](.impresairio.example.yaml) for its own dogfooding; copy it to `.impresairio.yaml` after defining the named target in your global configuration.

The documentation location is simply a filesystem directory. Obsidian is never required; it is only one possible Markdown viewer. See [configuration](docs/configuration.md) and [documentation targets](docs/documentation-targets.md) for the fixed bindings, path validation and local-filesystem safety boundary.

## Run a workflow

Start a feature run with concrete profiles for the three logical roles:

```bash
impresairio start feature \
  --launcher claude \
  --adversary codex \
  --implementer opencode-glm \
  --feature-id IMP-42 \
  --feature-slug account-merge \
  --request "Allow an operator to merge two customer accounts safely."
```

The command prints a run ID. Execute configured agents until the next human gate:

```bash
impresairio advance <run-id>
impresairio approve <run-id> approve-design --comment "Reviewed"
impresairio advance <run-id>
```

For a manual handoff, continue one bounded step at a time instead:

```bash
impresairio next <run-id>
impresairio complete <run-id> design
impresairio next <run-id>
impresairio complete <run-id> design-review-1
impresairio next <run-id>
impresairio approve <run-id> approve-design --comment "Reviewed"
```

`next` emits a structured handoff containing a prepared invocation and the exact expected output path. After executing the handoff manually, record its artifact with `complete`. `advance` executes the same prepared invocations, publishes returned Markdown through the verified filesystem target, and always stops at a human gate, provider failure or workflow completion.

If an approval needs revision:

```bash
impresairio request-changes <run-id> approve-design \
  --comment "Clarify permissions and empty states"
impresairio retry <run-id> design
```

Run state and events live beneath `<impresairio-home>/runs/<run-id>/`. The work request, canonical repository directory, workflow, documentation context and resolved agent/model profiles are frozen at start, so later configuration edits or the directory from which `advance` is invoked do not change an in-progress run.

## Check agent connectivity

From a repository containing `.impresairio.yaml`, check that every configured CLI is installed and callable:

```bash
impresairio doctor
```

Use `--live` to send each selected profile a minimal `OK` request. This verifies authentication and, for OpenCode, the resolved model ID; it may consume provider credits.

```bash
impresairio doctor --live
impresairio doctor --live --profile opencode-glm
```

## Built-in workflows and customization

V0 includes `feature`, `quick-fix`, and the small `classification-smoke` dogfooding workflow. A repository may override any workflow ID with `.impresairio/workflows/<workflow-id>.yaml`; a global override lives in `<impresairio-home>/workflows/`. Workflows are a deliberately closed YAML grammar: no inline shell, provider selection, loops or dynamic expressions.

Workflows can also declare typed primitive parameters (`string`, `boolean`, `integer`,
and `enum`) and compose a child workflow with explicit `with` mappings. Supply root
values through repeatable `--param name=value`; resolved values are frozen into the
run. Agent steps may produce a validated JSON result block inside their Markdown and
later direct agent steps may use a safe `when` condition over declared results and
parameters. See [workflows](docs/workflows.md) for the complete YAML contract.

Read [workflows](docs/workflows.md) before adding an override. Read [agents](docs/agents.md) for the provider and OpenCode model contract, [the roadmap](docs/roadmap.md) for planned Claude Code and Codex model/effort profiles, and [gates and recovery](docs/gates-and-recovery.md) before running a feature with human approval gates.

## Dogfooding V0

The first two real runs are the decision point for further abstraction. Follow [the dogfooding protocol](docs/dogfooding.md), record the defined metrics, and only add runtime, provider or workflow complexity in response to observed friction.

## Development and release checks

```bash
pnpm run test:run
pnpm run typecheck
pnpm run lint
pnpm run build
pnpm run pack:check
```

GitHub Actions runs the verification suite on supported Node versions and builds a package artifact for manual release inspection. No workflow publishes to npm.

## License

[MIT](LICENSE)
