# Impresairio

Impresairio is a CLI for coordinating AI-assisted engineering workflows.

V0 is a **Nest standalone CLI** built with `nest-commander`; it does not run an HTTP server.

## Requirements

- Node.js 22 or newer
- npm 10 or newer

## Local development

```bash
npm install
npm test -- --run
npm run build
npm run typecheck
npm run lint
node dist/main.js status unknown-run
```

The current `status` command intentionally reports an error for an unknown run. Run persistence is added in a later increment.

## Installation

When published, the CLI will be available through npm:

```bash
npm install -g @impresairio/cli
impresairio status unknown-run
```
