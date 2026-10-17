'use strict';

const ui = require('./ui');
const { d1Query } = require('./wrangler');

// Lista fixa usada como fallback quando a descoberta dinâmica de tabelas não
// está disponível (projetos/situações antigas). Projetos novos são cobertos
// automaticamente pela descoberta via `sqlite_master`.
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

// Tabelas que nunca vão para o dump: internas do SQLite/Miniflare e o índice
// FTS do EmDash (inclui as shadow tables do FTS5, frágeis de restaurar via SQL).
const IGNORED_TABLES = [/^sqlite_/i, /^_cf_/i, /_fts_/i];

const isIgnoredTable = (name) => IGNORED_TABLES.some((pattern) => pattern.test(name));

/** Lista as tabelas existentes no D1 remoto. */
function listRemoteTables(dbName) {
  return d1Query(dbName, "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name", { remote: true })
    .map((row) => row.name)
    .filter(Boolean);
}

/**
 * Tabelas a exportar: descoberta dinâmica (funciona em qualquer versão do
 * EmDash) com fallback para a lista fixa quando a consulta remota falha.
 */
function resolveTables(dbName) {
  try {
    const all = listRemoteTables(dbName);
    const discovered = all.filter((name) => !isIgnoredTable(name));
    if (discovered.length === 0) throw new Error('nenhuma tabela encontrada');
    const ignored = all.length - discovered.length;
    ui.log(
      `🧭 ${discovered.length} tabelas descobertas no D1 remoto` +
      (ignored > 0 ? ` (${ignored} ignoradas: internas/FTS).` : '.'),
    );
    return discovered;
  } catch (err) {
    ui.warn(`⚠️  Descoberta dinâmica falhou (${err.message}). Usando lista fixa de fallback.`);
    return FALLBACK_TABLES;
  }
}

module.exports = { resolveTables };
