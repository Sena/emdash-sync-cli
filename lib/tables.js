'use strict';

const ui = require('./ui');
const { d1Query } = require('./wrangler');

// Fixed list used as a fallback when dynamic table discovery is unavailable
// (older projects/situations). New projects are covered automatically by the
// `sqlite_master` discovery.
const FALLBACK_TABLES = [
  '_emdash_migrations', 'revisions', 'media', 'options', 'audit_logs',
  '_emdash_collections', '_emdash_fields', '_plugin_storage', '_plugin_state',
  '_plugin_indexes', '_emdash_widget_areas', '_emdash_widgets', 'users',
  'credentials', 'auth_tokens', 'oauth_accounts', 'allowed_domains',
  'auth_challenges', '_emdash_sections', '_emdash_api_tokens', '_emdash_oauth_tokens',
  '_emdash_device_codes', '_emdash_authorization_codes', '_emdash_seo',
  '_emdash_oauth_clients', '_emdash_cron_tasks', '_emdash_comments',
  '_emdash_redirects', '_emdash_404_log', '_emdash_bylines', '_emdash_content_bylines',
  '_emdash_rate_limits', 'ec_posts', 'ec_pages', 'ec_portfolio', 'ec_services',
  'content_taxonomies', '_emdash_menu_items', '_emdash_menus', 'taxonomies',
  '_emdash_taxonomy_defs',
];

// Tables that never go into the dump: SQLite/Miniflare internals and the
// EmDash FTS index (includes FTS5 shadow tables, fragile to restore via SQL).
const IGNORED_TABLES = [/^sqlite_/i, /^_cf_/i, /_fts_/i];

const isIgnoredTable = (name) => IGNORED_TABLES.some((pattern) => pattern.test(name));

/** How many times discovery is attempted before giving up. */
const DISCOVERY_ATTEMPTS = 3;

/** Pause between discovery attempts (network/API hiccups are transient). */
const RETRY_DELAY_MS = 1000;

/** Synchronous sleep — discovery runs synchronously. */
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** Lists the tables that exist in the remote D1. */
function listRemoteTables(dbName) {
  return d1Query(dbName, "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name", { remote: true })
    .map((row) => row.name)
    .filter(Boolean);
}

/**
 * Tables to export: dynamic discovery (works on any EmDash version) with a
 * fallback to the fixed list when the remote query keeps failing.
 *
 * Discovery is retried before giving up: a single transient failure used to
 * silently produce an incomplete dump (e.g. media rows referencing
 * `media_folders` without its CREATE TABLE). Retrying is what makes the
 * fallback a true last resort.
 *
 * @param {string} dbName
 * @param {{
 *   query?: (dbName: string) => string[],
 *   attempts?: number,
 *   retryDelayMs?: number,
 * }} [options] Injectable for tests.
 */
function resolveTables(dbName, { query = listRemoteTables, attempts = DISCOVERY_ATTEMPTS, retryDelayMs = RETRY_DELAY_MS } = {}) {
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const all = query(dbName);
      const discovered = all.filter((name) => !isIgnoredTable(name));
      if (discovered.length === 0) throw new Error('no tables found');
      const ignored = all.length - discovered.length;
      const ignoredNote = ignored > 0 ? ` (${ignored} ignored: internal/FTS)` : '';
      const retryNote = attempt > 1 ? ` — succeeded on attempt ${attempt}` : '';
      ui.log(`🧭 ${discovered.length} tables discovered in remote D1${ignoredNote}${retryNote}.`);
      return discovered;
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        ui.warn(`⚠️  Table discovery failed (attempt ${attempt}/${attempts}): ${error.message}`);
        sleep(retryDelayMs);
      }
    }
  }

  ui.warn(`⚠️  Dynamic discovery failed after ${attempts} attempts (${lastError.message}). Using the fallback table list.`);
  return FALLBACK_TABLES;
}

module.exports = { resolveTables, FALLBACK_TABLES };
