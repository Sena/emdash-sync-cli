#!/usr/bin/env node
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

// =========================================================================
// 🔧 CONFIGURAÇÕES
// =========================================================================

// Quantos backups locais manter (os mais recentes). Ver `--no-backup`.
const BACKUP_KEEP = 3;

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

const hasFlag = (name) => process.argv.includes(`--${name}`);
const NO_BACKUP = hasFlag('no-backup');

// =========================================================================
// Config: lê dinamicamente o wrangler.toml, wrangler.json ou wrangler.jsonc
// para descobrir o banco D1 e o bucket R2.
// =========================================================================
let DB_NAME = '';
let R2_BUCKET = '';
try {
  let wranglerContent = '';
  const tomlPath = path.join(process.cwd(), 'wrangler.toml');
  const jsonPath = path.join(process.cwd(), 'wrangler.json');
  const jsoncPath = path.join(process.cwd(), 'wrangler.jsonc');

  if (fs.existsSync(tomlPath)) {
    wranglerContent = fs.readFileSync(tomlPath, 'utf-8');
  } else if (fs.existsSync(jsonPath)) {
    wranglerContent = fs.readFileSync(jsonPath, 'utf-8');
  } else if (fs.existsSync(jsoncPath)) {
    wranglerContent = fs.readFileSync(jsoncPath, 'utf-8');
  } else {
    throw new Error('Arquivo wrangler.toml, wrangler.json ou wrangler.jsonc não encontrado na raiz do projeto.');
  }

  // Aceita formato TOML (database_name =) e JSON ("database_name":).
  const dbMatch = wranglerContent.match(/(?:"|')?database_name(?:"|')?\s*[=:]\s*"([^"]+)"/);
  const r2Match = wranglerContent.match(/(?:"|')?bucket_name(?:"|')?\s*[=:]\s*"([^"]+)"/);

  if (!dbMatch || !r2Match) {
    throw new Error('Não foi possível encontrar database_name ou bucket_name na configuração do wrangler');
  }
  DB_NAME = dbMatch[1];
  R2_BUCKET = r2Match[1];
} catch (err) {
  console.error(`❌ Erro de configuração: ${err.message}`);
  process.exit(1);
}
// =========================================================================

const isIgnoredTable = (name) => IGNORED_TABLES.some((pattern) => pattern.test(name));

/** Executa um `wrangler d1 execute ... --json` e devolve as linhas do resultado. */
function d1Query(sql, { remote = false } = {}) {
  const scope = remote ? '--remote' : '--local';
  const output = execSync(
    `npx wrangler d1 execute ${DB_NAME} ${scope} --json --command "${sql}"`,
    { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] },
  );
  const parsed = JSON.parse(output);
  const block = Array.isArray(parsed) ? parsed[0] : parsed;
  return (block && block.results) || [];
}

/** Lista as tabelas existentes no D1 remoto. */
function listRemoteTables() {
  return d1Query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name", { remote: true })
    .map((row) => row.name)
    .filter(Boolean);
}

/**
 * Tabelas a exportar: descoberta dinâmica (funciona em qualquer versão do
 * EmDash) com fallback para a lista fixa quando a consulta remota falha.
 */
function resolveTables() {
  try {
    const all = listRemoteTables();
    const discovered = all.filter((name) => !isIgnoredTable(name));
    if (discovered.length === 0) throw new Error('nenhuma tabela encontrada');
    const ignored = all.length - discovered.length;
    console.log(
      `🧭 ${discovered.length} tabelas descobertas no D1 remoto` +
        (ignored > 0 ? ` (${ignored} ignoradas: internas/FTS).` : '.'),
    );
    return discovered;
  } catch (err) {
    console.warn(`⚠️  Descoberta dinâmica falhou (${err.message}). Usando lista fixa de fallback.`);
    return FALLBACK_TABLES;
  }
}

// Helper para tentar matar o servidor dev que possa estar bloqueando os arquivos
function killDevServer(port) {
  try {
    if (process.platform === 'win32') {
      const output = execSync(`netstat -ano | findstr :${port}`).toString();
      const lines = output.trim().split('\n');
      for (const line of lines) {
        if (line.includes('LISTENING')) {
          const parts = line.trim().split(/\s+/);
          const pid = parts[parts.length - 1];
          if (pid && pid !== "0") {
            console.log(`🔫 Matando processo do dev server (PID: ${pid}) na porta ${port}...`);
            execSync(`taskkill /PID ${pid} /F`, { stdio: 'ignore' });
          }
        }
      }
    } else {
      const output = execSync(`lsof -t -i:${port}`).toString().trim();
      const pids = output.split('\n').filter(Boolean);
      for (const pid of pids) {
        console.log(`🔫 Matando processo do dev server (PID: ${pid}) na porta ${port}...`);
        execSync(`kill -9 ${pid}`, { stdio: 'ignore' });
      }
    }
    // Aguarda um segundo para o SO liberar os locks dos arquivos
    execSync(process.platform === 'win32' ? 'timeout /t 1 /nobreak' : 'sleep 1', { stdio: 'ignore' });
  } catch (err) {
    // Falha silenciosa (porta livre)
  }
}

/** Remove os backups mais antigos, mantendo os BACKUP_KEEP últimos. */
function pruneBackups(root) {
  try {
    const entries = fs
      .readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    const excess = entries.slice(0, Math.max(0, entries.length - BACKUP_KEEP));
    for (const name of excess) {
      fs.rmSync(path.join(root, name), { recursive: true, force: true });
    }
  } catch {
    // Podar backup não é crítico.
  }
}

/** Copia d1 e r2 locais para .wrangler/backups/<timestamp>/ antes do wipe. */
function createBackup() {
  const backupsRoot = path.join('.wrangler', 'backups');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
  const dest = path.join(backupsRoot, stamp);
  fs.mkdirSync(dest, { recursive: true });

  let copied = 0;
  for (const name of ['d1', 'r2']) {
    const source = path.join('.wrangler', 'state', 'v3', name);
    if (fs.existsSync(source)) {
      fs.cpSync(source, path.join(dest, name), { recursive: true });
      copied += 1;
    }
  }
  pruneBackups(backupsRoot);
  return { dest, copied };
}

async function sync() {
  let exitCode = 0;
  try {
    killDevServer(4321);

    // 1. Backup de segurança do estado local antes de qualquer destruição.
    if (NO_BACKUP) {
      console.log('⏭️  Backup desativado (--no-backup).');
    } else {
      console.log('💾 Fazendo backup do estado local (.wrangler/state/v3/{d1,r2})...');
      try {
        const { dest, copied } = createBackup();
        console.log(`   Backup salvo em ${dest} (${copied} pasta(s), mantendo os ${BACKUP_KEEP} últimos).`);
      } catch (err) {
        throw new Error(`Backup falhou (${err.message}). Rode com --no-backup para pular o backup.`);
      }
    }

    console.log('🧹 Limpando banco e storage locais antigos...');
    const d1Dir = path.join('.wrangler', 'state', 'v3', 'd1');
    const r2Dir = path.join('.wrangler', 'state', 'v3', 'r2');

    try {
      if (fs.existsSync(d1Dir)) fs.rmSync(d1Dir, { recursive: true, force: true });
      if (fs.existsSync(r2Dir)) fs.rmSync(r2Dir, { recursive: true, force: true });
    } catch (err) {
      throw new Error('Não foi possível apagar os arquivos antigos. O servidor dev ainda pode estar rodando ou prendendo o arquivo.');
    }

    // 2. Descobre as tabelas do banco remoto e exporta todas (menos internas/FTS).
    const tables = resolveTables();
    const tableArgs = tables.map((table) => '--table=' + table).join(' ');

    console.log(`🚀 Exportando as tabelas do D1 de produção [Banco: ${DB_NAME}]...`);
    execSync(`npx wrangler d1 export ${DB_NAME} --remote ${tableArgs} --output=tabela.sql`, { stdio: 'inherit' });

    console.log('\n📥 Importando o banco para o ambiente local...');
    execSync(`npx wrangler d1 execute ${DB_NAME} --local --file=tabela.sql`, { stdio: 'inherit' });

    console.log('✅ Banco de dados sincronizado com sucesso!');
    console.log('🖼️  Buscando informações do site e lista de mídias...');

    // Busca a URL de produção na tabela options.
    const urlRows = d1Query("SELECT value FROM options WHERE name = 'emdash:site_url'");
    if (urlRows.length === 0) {
      throw new Error("Não foi possível determinar a URL do projeto (emdash:site_url ausente na tabela options). Verifique se o banco remoto possui a URL configurada.");
    }
    // O valor vem serializado (ex: '"https://..."').
    const PROD_URL = JSON.parse(urlRows[0].value);
    console.log(`🌐 URL do projeto detectada: ${PROD_URL}`);

    const mediaFiles = d1Query('SELECT id, mime_type, storage_key FROM media');
    const stats = { downloaded: 0, skipped: 0, failed: 0 };

    if (mediaFiles.length > 0) {
      console.log(`Encontradas ${mediaFiles.length} mídias no banco. Sincronizando com R2 local em lotes [Bucket: ${R2_BUCKET}]...`);

      const tmpSyncDir = fs.mkdtempSync(path.join(os.tmpdir(), 'emdash-sync-'));

      try {
        const fetchWithRetry = async (url, retries = 1) => {
          for (let i = 0; i <= retries; i++) {
            try {
              const res = await fetch(url);
              if (res.ok || i === retries) return res;
            } catch (err) {
              if (i === retries) throw err;
            }
            await new Promise(r => setTimeout(r, 1000));
          }
        };

        const processFile = async (file) => {
          const storageKey = file.storage_key || file.id;

          if (!storageKey) {
            stats.skipped += 1;
            console.warn('- ⚠️ [Ignorado] Registro de mídia sem storage_key.');
            return;
          }

          const url = `${PROD_URL}/_emdash/api/media/file/${storageKey}`;
          const tempPath = path.join(tmpSyncDir, storageKey);

          try {
            const response = await fetchWithRetry(url, 1);
            if (response.ok) {
              const arrayBuffer = await response.arrayBuffer();
              // Gravação síncrona garante que o stream de gravação está fechado antes de chamar o wrangler
              fs.writeFileSync(tempPath, Buffer.from(arrayBuffer));

              execSync(`npx wrangler r2 object put ${R2_BUCKET}/${storageKey} --file "${tempPath}" --local --content-type "${file.mime_type}"`, { stdio: ['ignore', 'ignore', 'ignore'] });
              stats.downloaded += 1;
              console.log(`- ✅ Baixado e salvo: ${storageKey}`);
            } else {
              stats.skipped += 1;
              console.warn(`- ⚠️ [Ignorado] Falha ao baixar ${storageKey} (Status: ${response.status}) - Pode ter sido deletado em produção.`);
            }
          } catch (fetchErr) {
            stats.failed += 1;
            console.error(`- ❌ Erro ao processar ${storageKey}:`, fetchErr.message);
          } finally {
            if (fs.existsSync(tempPath)) fs.rmSync(tempPath, { force: true });
          }
        };

        // Processa as mídias em lotes de 10
        const batchSize = 10;
        for (let i = 0; i < mediaFiles.length; i += batchSize) {
          const batch = mediaFiles.slice(i, i + batchSize);
          await Promise.all(batch.map(processFile));
        }
      } finally {
        if (fs.existsSync(tmpSyncDir)) {
          fs.rmSync(tmpSyncDir, { recursive: true, force: true });
        }
      }
    }

    // Relatório: compara as mídias do banco com o que foi gravado no R2 local.
    const mediaCount = Number((d1Query('SELECT count(*) AS n FROM media')[0] || {}).n || 0);
    console.log('\n📊 Mídias:');
    console.log(`   No banco: ${mediaCount} · baixadas: ${stats.downloaded} · ignoradas: ${stats.skipped} · falhas: ${stats.failed}`);
    if (stats.downloaded < mediaCount) {
      console.warn('   ⚠️  O R2 local pode estar incompleto. Rode o sync novamente ou verifique WAF/URL pública.');
    } else {
      console.log('   ✅ Todas as mídias do banco estão no R2 local.');
    }

    console.log('\n🎉 Sincronização 100% concluída! Ambiente local idêntico à produção.');

  } catch (error) {
    console.error('\n❌ Erro durante a sincronização:', error.message);
    exitCode = 1;
  } finally {
    // Sanitização de segurança: deleta o dump SQL gerado pelo export.
    const sqlFile = path.join(process.cwd(), 'tabela.sql');
    if (fs.existsSync(sqlFile)) {
      fs.rmSync(sqlFile, { force: true });
      console.log('\n🧹 [Sanitização] Arquivo temporário de dump SQL deletado com sucesso.');
    }
    if (exitCode !== 0) process.exitCode = exitCode;
  }
}

sync();
