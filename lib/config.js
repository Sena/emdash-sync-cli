'use strict';

const fs = require('fs');
const path = require('path');

// =========================================================================
// 🔧 PROJECT CONFIGURATION AND DISCOVERY
// =========================================================================

/** How many local backups to keep (the most recent ones). See `--no-backup`. */
const BACKUP_KEEP = 3;

/** Default Astro/Vite dev server port, which must be released. */
const DEV_SERVER_PORT = 4321;

/** Accepted wrangler config files, in order of preference. */
const WRANGLER_FILES = ['wrangler.toml', 'wrangler.json', 'wrangler.jsonc'];

/**
 * Discovers the D1 database and the R2 bucket by reading wrangler.toml,
 * wrangler.json or wrangler.jsonc from the project root. Accepts TOML
 * (`database_name =`) and JSON (`"database_name":`) formats.
 *
 * The CLI runs from the npx cache, so project files are always resolved
 * against `process.cwd()` — never against `__dirname`.
 *
 * @returns {{ dbName: string, r2Bucket: string, paths: Record<string, string> }}
 * @throws when the file is missing or does not define database_name/bucket_name.
 */
function loadProject() {
  const wranglerFile = WRANGLER_FILES
    .map((name) => path.join(process.cwd(), name))
    .find((file) => fs.existsSync(file));

  if (!wranglerFile) {
    throw new Error('wrangler.toml, wrangler.json or wrangler.jsonc not found in the project root.');
  }

  const content = fs.readFileSync(wranglerFile, 'utf-8');
  const dbMatch = content.match(/(?:"|')?database_name(?:"|')?\s*[=:]\s*"([^"]+)"/);
  const r2Match = content.match(/(?:"|')?bucket_name(?:"|')?\s*[=:]\s*"([^"]+)"/);
  if (!dbMatch || !r2Match) {
    throw new Error('Could not find database_name or bucket_name in the wrangler configuration');
  }

  return {
    dbName: dbMatch[1],
    r2Bucket: r2Match[1],
    paths: {
      // Paths relative to the process cwd; the wrangler commands receive the
      // same values.
      dumpFile: 'dump.sql',
      d1Dir: path.join('.wrangler', 'state', 'v3', 'd1'),
      r2Dir: path.join('.wrangler', 'state', 'v3', 'r2'),
      backupsDir: path.join('.wrangler', 'backups'),
    },
  };
}

module.exports = { BACKUP_KEEP, DEV_SERVER_PORT, loadProject };
