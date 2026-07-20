# Impresairio

Impresairio is a local, durable CLI for coordinating AI-assisted engineering workflows. It keeps workflow state, human approvals and documentation contracts outside an application repository while allowing each repository to share small YAML workflow definitions.

V0 is intentionally pragmatic:

- Ordered `feature` and `quick-fix` workflows.
- Abstract roles (`launcher`, `adversary`, `implementer`) bound to Claude Code, Codex or OpenCode profiles at run start.
- Explicit human approval gates, retry and stale-artifact invalidation.
- Markdown output to a configurable local filesystem destination, including a folder that happens to be an Obsidian vault.
- Handoff preparation only: V0 never starts an agent process itself.

It is **not** a hosted project-management tool, a generic workflow engine, an agent marketplace or an automatic multi-agent runtime.

## Requirements and installation

- Node.js 22 or newer
- npm 10 or newer

Once published to npm:

```bash
npm install -g @impresairio/cli
impresairio --help
```

For local development:

```bash
git clone <your-fork-or-clone-url>
cd impresairio
npm ci
npm run verify
node dist/main.js --help
```

`npx @impresairio/cli --help` will also work after publication.

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
  glm-5.2: z-ai/glm-5.2
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

The documentation location is simply a filesystem directory. Obsidian is never required; it is only one possible Markdown viewer. See [configuration](docs/configuration.md) and [documentation targets](docs/documentation-targets.md) for the fixed bindings, path validation and local-filesystem safety boundary.

## Run a workflow

Start a feature run with concrete profiles for the three logical roles:

```bash
impresairio start feature \
  --launcher claude \
  --adversary codex \
  --implementer opencode-glm \
  --feature-id IMP-42 \
  --feature-slug account-merge
```

The command prints a run ID. Continue it one bounded step at a time:

```bash
impresairio next <run-id>
impresairio complete <run-id> design
impresairio next <run-id>
impresairio complete <run-id> challenge
impresairio next <run-id>
impresairio approve <run-id> approve-design --comment "Reviewed"
```

`next` emits a structured handoff containing the exact expected output path. The active agent writes that Markdown file, then the human or agent session runs `complete`. A launcher handoff is interactive; adversary and implementer handoffs also contain a prepared invocation, but V0 does not execute it.

If an approval needs revision:

```bash
impresairio request-changes <run-id> approve-design \
  --comment "Clarify permissions and empty states"
impresairio retry <run-id> design
```

Run state and events live beneath `<impresairio-home>/runs/<run-id>/`. The workflow, documentation context and resolved agent/model profiles are frozen at start, so later configuration edits do not change an in-progress run.

## Built-in workflows and customization

V0 includes `feature` and `quick-fix`. A repository may override either one with `.impresairio/workflows/<workflow-id>.yaml`; a global override lives in `<impresairio-home>/workflows/`. Workflows are a deliberately closed YAML grammar: no inline shell, provider selection, loops or dynamic expressions.

Read [workflows](docs/workflows.md) before adding an override. Read [agents](docs/agents.md) for the provider and OpenCode model contract, and [gates and recovery](docs/gates-and-recovery.md) before running a feature with human approval gates.

## Dogfooding V0

The first two real runs are the decision point for further abstraction. Follow [the dogfooding protocol](docs/dogfooding.md), record the defined metrics, and only add runtime, provider or workflow complexity in response to observed friction.

## Development and release checks

```bash
npm run test:run
npm run typecheck
npm run lint
npm run build
npm run pack:check
```

GitHub Actions runs the verification suite on supported Node versions and builds a package artifact for manual release inspection. No workflow publishes to npm.

## License

[MIT](LICENSE)
