# AGENTS INSTRUCTIONS

This document provides context for AI Assistants and Agents working with the `emdash-sync-cli` codebase.

## Codebase Context
- This is a standalone CLI tool published to be used via `npx`.
- The main entry point is `index.js`, which includes the `#!/usr/bin/env node` shebang.
- It is designed exclusively for Astro + EmDash projects that utilize Cloudflare D1 and R2 via Wrangler.

## Design Principles
1. **Zero-Config**: The script must NEVER require the user to pass arguments or configure URLs. It must dynamically infer configuration by parsing `wrangler.toml/json/jsonc` via regex and by directly querying the imported D1 database (`emdash:site_url` from the `options` table).
2. **Path Context**: Because it is invoked via `npx`, it runs from the global npm cache. You must **NEVER** use `__dirname` to reference project files (like `wrangler.toml` or `tabela.sql`). Always use `process.cwd()`.
3. **Immutability of Production**: All remote commands (`wrangler d1 export --remote` and `fetch(GET)`) must be strictly read-only.
4. **Sanitization**: All temporary files (e.g., `tabela.sql`, temporary image buffers from `os.tmpdir()`) must be deleted in a `finally` block, regardless of execution success or failure.

## Testing Locally
If you modify this script, you can test it by running:
```bash
node index.js
```
from within a target EmDash project directory (after temporarily copying the updated file there), or by pushing to GitHub and running `npx github:Sena/emdash-sync-cli` to test the remote execution flow.
