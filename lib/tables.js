'use strict';

const ui = require('./ui');
const { d1Query } = require('./wrangler');

// Fixed list used as a LAST RESORT when dynamic table discovery keeps failing.
// Kept in sync with the current EmDash schema (1.3.x); dynamic discovery is
// always tried first (with retries). The export skips tables that do not exist
// in a given database, so carrying a few extra names is harmless. Custom
// collection tables (`ec_*`) are per project, so only the common ones are
// listed here.
const FALLBACK_TABLES = [
  // Core: migrations, collections, fields, blocks, revisions
  '_emdash_migrations', '_emdash_migrations_lock',
  '_emdash_collections', '_emdash_fields',
  '_emdash_block_types', '_emdash_block_type_versions',
  '_emdash_sections', '_emdash_relations',
  '_emdash_content_references', '_emdash_entry_locks',
  '_emdash_revision_prune_queue', 'revisions',
  // Taxonomies and menus
  'content_taxonomies', 'taxonomies', '_emdash_taxonomy_defs',
  '_emdash_taxonomy_def_groups', '_emdash_menus', '_emdash_menu_items',
  // Media
  'media', 'media_folders', '_emdash_media_upload_attempts',
  '_emdash_media_usage', '_emdash_media_usage_activation',
  '_emdash_media_usage_cleanup', '_emdash_media_usage_cleanup_fence',
  '_emdash_media_usage_collection_deletions',
  '_emdash_media_usage_generation_writes', '_emdash_media_usage_index_status',
  '_emdash_media_usage_reconciliations', '_emdash_media_usage_sources',
  '_emdash_media_usage_work',
  // Auth, users, tokens and audit
  'users', 'credentials', 'auth_tokens', 'auth_challenges', 'allowed_domains',
  'oauth_accounts', '_emdash_api_tokens', '_emdash_oauth_tokens',
  '_emdash_oauth_clients', '_emdash_device_codes',
  '_emdash_authorization_codes', '_emdash_rate_limits', 'audit_logs',
  // Plugins
  '_plugin_storage', '_plugin_state', '_plugin_indexes',
  // Widgets, SEO, redirects, comments and bylines
  '_emdash_widget_areas', '_emdash_widgets',
  '_emdash_seo', '_emdash_redirects', '_emdash_redirect_state',
  '_emdash_redirect_artifacts', '_emdash_redirect_generation_artifacts',
  '_emdash_redirect_write_lock',
  '_emdash_comments', '_emdash_comment_reactions',
  '_emdash_bylines', '_emdash_content_bylines', '_emdash_byline_fields',
  '_emdash_byline_field_values', '_emdash_byline_field_group_values',
  '_emdash_cron_tasks', '_emdash_404_log', 'options',
  // Transfers (import/export packages)
  '_emdash_transfer_operations', '_emdash_transfer_approvals',
  '_emdash_transfer_identity_map', '_emdash_transfer_media_blobs',
  '_emdash_transfer_package_index', '_emdash_transfer_staged_files',
  // Collection data tables (per project; missing ones are skipped by the export)
  'ec_posts', 'ec_pages', 'ec_portfolio', 'ec_services',
  'ec_banners', 'ec_precos', 'ec_products',
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
