# AGENTS INSTRUCTIONS

This document provides context for AI Assistants and Agents working with the `emdash-sync-cli` codebase.

## Codebase Context
- This is a standalone CLI tool published to be used via `npx`.
- `index.js` is a thin bootstrap (shebang); all logic lives in `lib/`, one concern per module:
  - `cli.js` — flag parsing and command dispatch (today: `pull`, the default command).
  - `pull.js` — orchestrates the sync flow; `config.js` — wrangler discovery and project paths.
  - `wrangler.js` — every `wrangler` invocation (single choke point); `tables.js` — D1 table discovery.
  - `state.js` — local emulator state (dev server, backups, wipe); `sql.js` — pure dump reordering.
  - `media.js` — media download into local R2; `ui.js` — console output helpers.
- It is designed exclusively for Astro + EmDash projects that utilize Cloudflare D1 and R2 via Wrangler.

## Design Principles
1. **Zero-Config**: The script must NEVER require the user to pass arguments or configure URLs. It must dynamically infer configuration by parsing `wrangler.toml/json/jsonc` via regex and by directly querying the imported D1 database (`emdash:site_url` from the `options` table).
2. **Path Context**: Because it is invoked via `npx`, it runs from the global npm cache. You must **NEVER** use `__dirname` to reference project files (like `wrangler.toml` or `tabela.sql`). Always use `process.cwd()`.
3. **Immutability of Production**: All remote commands (`wrangler d1 export --remote` and `fetch(GET)`) must be strictly read-only.
4. **Sanitization**: All temporary files (e.g., `tabela.sql`, temporary image buffers from `os.tmpdir()`) must be deleted in a `finally` block, regardless of execution success or failure.

## Testing Locally
Because project files are always resolved from `process.cwd()`, you can run the CLI from any target EmDash project without copying anything:
```bash
node /path/to/emdash-sync-cli/index.js
```
Alternatively, push a branch and test the remote execution flow:
```bash
npx github:Sena/emdash-sync-cli#<branch>
```
Note: a full run kills the dev server on port 4321, wipes the local D1/R2 and re-imports everything from production.
