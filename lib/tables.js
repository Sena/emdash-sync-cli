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

/** Lists the tables that exist in the remote D1. */
function listRemoteTables(dbName) {
  return d1Query(dbName, "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name", { remote: true })
    .map((row) => row.name)
    .filter(Boolean);
}

/**
 * Tables to export: dynamic discovery (works on any EmDash version) with a
 * fallback to the fixed list when the remote query fails.
 */
function resolveTables(dbName) {
  try {
    const all = listRemoteTables(dbName);
    const discovered = all.filter((name) => !isIgnoredTable(name));
    if (discovered.length === 0) throw new Error('no tables found');
    const ignored = all.length - discovered.length;
    ui.log(
      `🧭 ${discovered.length} tables discovered in remote D1` +
      (ignored > 0 ? ` (${ignored} ignored: internal/FTS).` : '.'),
    );
    return discovered;
  } catch (err) {
    ui.warn(`⚠️  Dynamic discovery failed (${err.message}). Using the fallback table list.`);
    return FALLBACK_TABLES;
  }
}

module.exports = { resolveTables };
