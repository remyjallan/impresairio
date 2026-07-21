# Contributing to Impresairio

Thanks for contributing. Before opening an issue or pull request, please read the README and existing issues.

## Development

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm run verify
```

Use focused tests for a behavior change, then run `pnpm run verify` before submitting. Keep pull requests small, explain the user-visible effect, and update documentation when behavior or configuration changes. Read [AGENTS.md](AGENTS.md) for the shared contributor rules, especially the YAML configuration contract.

## Scope

V0 intentionally avoids a hosted service, a generic workflow language and autonomous agent execution. Propose an issue before adding a broad abstraction or a provider.

## Pull requests

Use a descriptive title, link the issue when applicable, include tests, and do not commit secrets, local configuration, generated tarballs or `state.json` runs.
