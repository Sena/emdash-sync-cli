# AGENTS INSTRUCTIONS

This document provides context for AI Assistants and Agents working with the `emdash-sync-cli` codebase.

## Codebase Context
- This is a standalone CLI tool published to be used via `npx`; everything (code, comments, output, docs) is written in English.
- `index.js` is a thin bootstrap (shebang); all logic lives in `lib/`, one concern per module:
  - `cli.js` — argv parsing and dispatch of the explicit commands (`pull`, `push`, `help`); a bare invocation prints the help.
  - `pull.js` — orchestrates production → local (dry-run plan + full sync); `push.js` — local → production schema plan/apply.
  - `schema.js` — pure planner diffing the seed against the remote schema; `seed.js` — seed loading (local DB via `emdash export-seed`, or `--seed`).
  - `api.js` — EmDash admin API client (auth, dev bypass, token refresh); `site-url.js` — production URL resolution.
  - `auth.js` — credential failure detection + interactive login recovery (Cloudflare and EmDash).
  - `config.js` — wrangler discovery and project paths; `wrangler.js` — every `wrangler` invocation (single choke point).
  - `tables.js` — retrying remote D1 table discovery + fallback list; `state.js` — local emulator state (dev server, backups, wipe).
  - `sql.js` — pure dump reordering; `media.js` — media download into local R2; `ui.js` — console output helpers.
- It is designed exclusively for Astro + EmDash projects that utilize Cloudflare D1 and R2 via Wrangler.

## Design Principles
1. **Explicit commands, dry-run by default**: nothing runs without `pull`/`push`/`help`, and flags without a command are an error. Every command only prints its plan unless `--apply` is passed.
2. **Zero-Config**: the script must NEVER require the user to pass arguments or configure URLs. It must dynamically infer configuration by parsing `wrangler.toml/json/jsonc` via regex and by querying the databases themselves (`emdash:site_url` from the `options` table; the production D1 for the push target).
3. **Path Context**: because it is invoked via `npx`, it runs from the global npm cache. You must **NEVER** use `__dirname` to reference project files (like `wrangler.jsonc` or `dump.sql`). Always use `process.cwd()`.
4. **Immutability of Production**: all remote read commands (`wrangler d1 export --remote`, `wrangler d1 execute --remote`, `fetch(GET)`) must be strictly read-only. The only production writes in the whole tool are the schema mutations performed by `push --apply` through the admin API.
5. **Push never carries data**: `seed.js` deletes any `content` payload in code, regardless of the seed source, and `schema.js` only reads `collections`, `blockTypes` and `taxonomies` from the seed.
6. **Sanitization**: all temporary files (e.g., `dump.sql`, temporary image buffers from `os.tmpdir()`) must be deleted in a `finally` block, regardless of execution success or failure.
7. **Actionable auth failures**: a missing/expired credential must never surface as a raw command error — detect it, offer the interactive login in TTYs (retrying once after success), and always include the exact fix command and link in the message. Auto-login honors `EMDASH_SYNC_AUTO_LOGIN=0`, which tests and scripts must set.

## Testing Locally
Because project files are always resolved from `process.cwd()`, you can run the CLI from any target EmDash project without copying anything:
```bash
node /path/to/emdash-sync-cli/index.js pull         # dry-run plan (production → local)
node /path/to/emdash-sync-cli/index.js push --url http://localhost:4321
```
Alternatively, push a branch and test the remote execution flow:
```bash
npx github:Sena/emdash-sync-cli#<branch> help
npx github:Sena/emdash-sync-cli#<branch> push --seed seed/schema.json
```
Note: `pull --apply` kills the dev server on port 4321, wipes the local D1/R2 and re-imports everything from production.
