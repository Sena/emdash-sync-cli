# EmDash Local Sync CLI

A zero-config, plug-and-play CLI tool for EmDash CMS development on Cloudflare: **pull** an exact 1:1 clone of the production D1 database and R2 media bucket into your local Wrangler emulator, and **push** your local schema (collections, fields, block types, taxonomies) to production — never data.

Both directions are **dry-run by default**: a command prints its plan and changes nothing until you add `--apply`. Commands are explicit — running the CLI without a command prints the help.

## 🚀 How to Use

You do not need to install this package! Run it on demand in any EmDash project using `npx`:

```bash
npx github:Sena/emdash-sync-cli pull            # dry-run: shows what would be pulled
npx github:Sena/emdash-sync-cli pull --apply    # production → local (D1 + R2)
npx github:Sena/emdash-sync-cli push            # dry-run: shows the schema plan
npx github:Sena/emdash-sync-cli push --apply    # local schema → production
npx github:Sena/emdash-sync-cli help
```

### Recommendation
Add it to your `package.json` scripts:
```json
"scripts": {
  "sync": "npx github:Sena/emdash-sync-cli"
}
```
Then `npm run sync -- pull --apply` refreshes your local environment with the latest production data (the `--` forwards the command and its flags), and `npm run sync -- push` shows the schema plan.

## ⬇️ `pull` — production → local

1. Dynamically reads your `wrangler.toml`, `wrangler.json`, or `wrangler.jsonc` to find your DB and bucket names.
2. Reads production **read-only** first: discovers the D1 tables (`sqlite_master`, skipping internal SQLite/Miniflare tables and the EmDash FTS index; retried before falling back to a built-in list) and the public project URL (`emdash:site_url` in the `options` table). In dry-run, the plan is printed here and nothing else happens.
3. (`--apply`) Gracefully kills any running Astro/Vite dev server (port 4321) to unlock the SQLite files.
4. (`--apply`) Copies the current local `.wrangler/state/v3/{d1,r2}` to `.wrangler/backups/<timestamp>/`, keeping the last 3 (disable with `--no-backup`). This copy exists **only as a rollback point** — there is no restore command; to roll back, stop the dev server and copy `.wrangler/backups/<timestamp>/{d1,r2}` back over `.wrangler/state/v3/`.
5. (`--apply`) Performs a clean wipe of the local D1 and R2 emulator state.
6. (`--apply`) Runs a safe, read-only remote export of every production table and imports the dump into your local D1.
7. (`--apply`) Fetches all production media via the public API in batched parallel requests and natively injects them into your local Miniflare R2 bucket.
8. (`--apply`) Prints a media summary (rows in the DB vs. downloaded/skipped/failed), so an incomplete clone is visible, and safely removes all temporary files.

## ⬆️ `push` — local → production (schema only)

1. Resolves the target instance, in order: `--url` → `EMDASH_URL` → `SITE_URL` (environment or `.env`/`.env.local`) → the Worker's custom domain on Cloudflare (via the wrangler credential) → a single EmDash CLI session.
2. Loads the desired schema: **by default it is generated from your local database** (`npx emdash export-seed` reads the local D1 SQLite directly — the local database is the source of truth). Use `--seed=<file>` to push a specific seed file instead (e.g. a frozen snapshot).
3. Authenticates against the admin API (Bearer token from `EMDASH_TOKEN` or `npx emdash login`; a dev-bypass cookie on localhost).
4. Diffs the seed against the remote schema and prints the steps (`create collection`, `create field`, `update field`, `create taxonomy`, ...). With `--apply`, each step is executed in order; with no differences it prints "nothing to do".
5. **Never sends data**: content, terms, menus, widgets, settings and users are ignored, and any `content` payload present in the seed is stripped in code. A change to the fields of an existing block type is refused with instructions — that is a breaking change requiring a new version and a renderer swap.

## ⚙️ Options

Both commands accept:

- `--apply` — actually execute. Without it every command is a dry-run plan.
- `-h`, `--help` — print the help.

`pull` only:

- `--no-backup` — skip the automatic backup of the local emulator state before the wipe. Useful when you know there is nothing local worth rolling back to.

`push` only:

- `--seed=<file>` — send a specific seed JSON instead of generating one from the local database.
- `--url=<url>` — target instance (defaults to the resolution order above).

## 🔐 Authentication & Troubleshooting

Two credentials are involved, and the failure messages tell you exactly how to fix them:

- **Cloudflare / wrangler** — used by `pull` (remote reads) and by `push` target discovery. When the sign-in is missing or expired, the CLI opens the login flow in your browser (interactive terminals) and retries the command by itself. To fix manually: `npx wrangler login` (it opens the browser — click "Allow"). Wrong account? `npx wrangler logout`, then login again. Manual API tokens: https://dash.cloudflare.com/profile/api-tokens.
- **EmDash admin session** — used by `push` to talk to the target instance. On localhost the dev-bypass grants a session automatically (the dev server must be running: `npm run dev`). For remote targets, fix with `npx emdash login --url <url>` (the CLI can open the login flow for you when interactive) or set `EMDASH_TOKEN`.

Auto-opening the login flow can be disabled with `EMDASH_SYNC_AUTO_LOGIN=0` (useful in scripts and CI) — the errors still carry the exact fix instructions.

Authentication failures happen before anything is touched, so a failed command never leaves a partial state — fix the login and run it again.

## 📁 Project Structure

A zero-dependency CommonJS package: `index.js` is a thin bootstrap and every module under `lib/` owns a single concern.

| Path | Responsibility |
| --- | --- |
| `index.js` | Entry point (shebang); hands control to `lib/cli.js`. |
| `lib/cli.js` | Flag parsing and dispatch of the explicit commands (`pull`, `push`, `help`). |
| `lib/pull.js` | Orchestrates production → local: dry-run plan and the full sync. |
| `lib/push.js` | Orchestrates local → production: schema plan and apply. |
| `lib/schema.js` | Diff between the desired seed and the remote schema (pure planner). |
| `lib/seed.js` | Seed loading: generated from the local DB, or from `--seed`. |
| `lib/api.js` | EmDash admin API client (auth, dev bypass, token refresh). |
| `lib/site-url.js` | Production URL resolution (env → .env → Cloudflare → EmDash session). |
| `lib/auth.js` | Credential failure detection and one-step login recovery. |
| `lib/config.js` | Reads `wrangler.*` and resolves the DB, bucket and project paths. |
| `lib/wrangler.js` | Every `wrangler` invocation (D1 queries/export/import, R2 writes). |
| `lib/tables.js` | Remote D1 table discovery and fallback policy. |
| `lib/state.js` | Local emulator state: dev server, backups, wipe. |
| `lib/sql.js` | SQL dump reordering (pure function). |
| `lib/media.js` | Media download and injection into local R2. |
| `lib/ui.js` | Console output helpers. |
| `test/` | Hermetic test suite (`npm test`): fake EmDash API + CLI process helpers. |

## 🧪 Testing

```bash
npm test
```

The suite is hermetic by design — it never touches wrangler, Cloudflare, or the real network:

- `test/helpers/fake-emdash.js` is an in-memory stand-in for the EmDash admin API (ephemeral HTTP server) that records every request, so tests can assert what was — and was not — written.
- `test/helpers/run-cli.js` spawns the real CLI in a clean environment: no credentials, no URL settings, no auto-login.

Covered: SQL dump reordering, local database discovery, seed loading (content always stripped), table discovery (retry + fallback list), auth-failure detection and messages, the API client (dev-bypass, token fallback, error shapes), the schema planner (create/update steps, idempotence, breaking block-type changes), argument parsing and CLI flows, and `push` end-to-end against the fake API (dry-run writes nothing, `--apply` is idempotent). The wrangler-facing side (`pull`) is exercised manually.

## ⚠️ Limitations & Requirements

- **Node.js**: Requires Node v18+ (relies on native `fetch` API).
- **Wrangler**: Requires Wrangler CLI installed locally in the project.
- **WAF/Firewalls**: `pull` downloads media by querying the public `/_emdash/api/media/file/` endpoint. If your production site is blocked by strict Cloudflare Captcha rules or WAF restrictions, the media fetch requests might fail.
- **Destructive local sync**: `pull --apply` **permanently deletes** any content or images you created *only* locally. It forces the local environment to perfectly mirror production. The previous local state is copied to `.wrangler/backups/` (unless `--no-backup`) **only as a rollback point** — nothing else consumes it.
- **Search index**: FTS tables are intentionally **not** exported (restoring FTS5 shadow tables from a SQL dump is fragile). EmDash rebuilds the index automatically on the first search request locally, so search matches production once it is used.
- **Large media**: videos and large files are still downloaded into memory in batches; streaming downloads are a planned improvement.

## 🤝 Contributing

This CLI is designed to evolve independently and help the entire EmDash community. If you notice bugs, missing features, or want to optimize the download streams, please open an Issue or a Pull Request! We highly encourage contributions.
