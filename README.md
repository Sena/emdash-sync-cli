# EmDash Local Sync CLI

A zero-config, plug-and-play CLI tool to synchronize production databases and media buckets from Cloudflare (D1 & R2) directly to your local Wrangler emulator for EmDash CMS development.

## 🌟 Purpose

This library eliminates the need for manual database exports and fragmented local `.db` files when building with EmDash. By running a single command, you get an exact 1:1 clone of your production edge environment running locally on Miniflare.

**What it does:**
1. Dynamically reads your `wrangler.toml`, `wrangler.json`, or `wrangler.jsonc` to find your DB and Bucket names.
2. Gracefully kills any running Astro/Vite dev servers (Port 4321) to unlock SQLite files.
3. Performs a clean wipe of your local `.wrangler/state/v3` directory, deleting ghost files and old cache.
4. Executes a safe, read-only remote export of your production D1 tables.
5. Queries the local DB to dynamically discover the project's production URL (`emdash:site_url`).
6. Fetches all production images via the API in batched parallel requests and natively injects them into your local Miniflare R2 bucket.
7. Safely removes all temporary SQL dumps and buffers, leaving your local file system completely clean.

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

## ⚠️ Limitations & Requirements

- **Node.js**: Requires Node v18+ (relies on native `fetch` API).
- **Wrangler**: Requires Wrangler CLI installed locally in the project.
- **WAF/Firewalls**: The tool downloads media by querying the public `/_emdash/api/media/file/` endpoint. If your production site is blocked by strict Cloudflare Captcha rules or WAF restrictions, the media fetch requests might fail.
- **Destructive Local Sync**: Running this tool **permanently deletes** any content or images you created *only* locally. It forces the local environment to perfectly mirror production.

## 🤝 Contributing

This CLI is designed to evolve independently and help the entire EmDash community. If you notice bugs, missing features, or want to optimize the download streams, please open an Issue or a Pull Request! We highly encourage contributions.
