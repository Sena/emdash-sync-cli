# EmDash Local Sync CLI

A zero-config, plug-and-play CLI tool to synchronize production databases and media buckets from Cloudflare (D1 & R2) directly to your local Wrangler emulator for EmDash CMS development.

## 🌟 Purpose

This library eliminates the need for manual database exports and fragmented local `.db` files when building with EmDash. By running a single command, you get an exact 1:1 clone of your production edge environment running locally on Miniflare.

**What it does:**
1. Dynamically reads your `wrangler.toml`, `wrangler.json`, or `wrangler.jsonc` to find your DB and Bucket names.
2. Gracefully kills any running Astro/Vite dev servers (Port 4321) to unlock SQLite files.
3. Copies the current local `.wrangler/state/v3/{d1,r2}` to `.wrangler/backups/<timestamp>/`, keeping the last 3 (disable with `--no-backup`). This copy exists **only as a rollback point** — there is no restore command; to roll back, stop the dev server and copy `.wrangler/backups/<timestamp>/{d1,r2}` back over `.wrangler/state/v3/`.
4. Performs a clean wipe of the local D1 and R2 emulator state (`.wrangler/state/v3/d1` and `.wrangler/state/v3/r2`).
5. Discovers the production D1 tables dynamically (`sqlite_master`), skipping internal SQLite/Miniflare tables and the EmDash FTS index, then executes a safe, read-only remote export.
6. Imports the dump into your local D1 database.
7. Queries the local DB to dynamically discover the project's production URL (`emdash:site_url`).
8. Fetches all production media via the API in batched parallel requests and natively injects them into your local Miniflare R2 bucket.
9. Prints a media summary (rows in the DB vs. downloaded/skipped/failed) so an incomplete clone is visible.
10. Safely removes all temporary SQL dumps and buffers, leaving your local file system completely clean.

## 🚀 How to Use

You do not need to install this package locally! You can run it on demand in any EmDash project using `npx`:

```bash
npx github:Sena/emdash-sync-cli
```

### Recommendation
Add it to your `package.json` scripts:
```json
"scripts": {
  "sync": "npx github:Sena/emdash-sync-cli"
}
```
Then simply run `npm run sync` whenever you want to refresh your local environment with the latest production data.

### Options

- `--no-backup` — skip the automatic backup of the local emulator state before the wipe. Useful when you know there is nothing local worth rolling back to.

```bash
npx github:Sena/emdash-sync-cli --no-backup
```

## ⚠️ Limitations & Requirements

- **Node.js**: Requires Node v18+ (relies on native `fetch` API).
- **Wrangler**: Requires Wrangler CLI installed locally in the project.
- **WAF/Firewalls**: The tool downloads media by querying the public `/_emdash/api/media/file/` endpoint. If your production site is blocked by strict Cloudflare Captcha rules or WAF restrictions, the media fetch requests might fail.
- **Destructive Local Sync**: Running this tool **permanently deletes** any content or images you created *only* locally. It forces the local environment to perfectly mirror production. The previous local state is copied to `.wrangler/backups/` (unless `--no-backup`) **only as a rollback point** — nothing else consumes it: to undo a sync, stop the dev server and copy the folders from `.wrangler/backups/<timestamp>/{d1,r2}` back into `.wrangler/state/v3/`.
- **Search index**: FTS tables are intentionally **not** exported (restoring FTS5 shadow tables from a SQL dump is fragile). EmDash rebuilds the index automatically on the first search request locally, so search matches production once it is used.
- **Large media**: videos and large files are still downloaded into memory in batches; streaming downloads are a planned improvement.

## 🤝 Contributing

This CLI is designed to evolve independently and help the entire EmDash community. If you notice bugs, missing features, or want to optimize the download streams, please open an Issue or a Pull Request! We highly encourage contributions.
