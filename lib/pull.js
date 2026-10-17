'use strict';

const fs = require('fs');

const ui = require('./ui');
const config = require('./config');
const state = require('./state');
const tables = require('./tables');
const wrangler = require('./wrangler');
const sql = require('./sql');
const media = require('./media');

// Comando padrão do CLI: puxa a produção (D1 + R2) para o emulador local.

/**
 * Fluxo: derruba dev server → backup → wipe → export remoto (read-only) →
 * reordena dump → import local → sincroniza mídias → relatório.
 *
 * @param {{ noBackup?: boolean }} options
 */
async function run({ noBackup = false } = {}) {
  let project;
  try {
    project = config.loadProject();
  } catch (err) {
    ui.fail(`❌ Erro de configuração: ${err.message}`);
    process.exitCode = 1;
    return;
  }

  const { dbName, r2Bucket, paths } = project;
  let exitCode = 0;

  try {
    state.killDevServer(config.DEV_SERVER_PORT);

    // 1. Backup de segurança do estado local antes de qualquer destruição.
    if (noBackup) {
      ui.log('⏭️  Backup desativado (--no-backup).');
    } else {
      ui.log('💾 Fazendo backup do estado local (.wrangler/state/v3/{d1,r2})...');
      try {
        const { dest, copied } = state.createBackup(paths);
        ui.log(`   Backup salvo em ${dest} (${copied} pasta(s), mantendo os ${config.BACKUP_KEEP} últimos).`);
      } catch (err) {
        throw new Error(`Backup falhou (${err.message}). Rode com --no-backup para pular o backup.`);
      }
    }

    ui.log('🧹 Limpando banco e storage locais antigos...');
    state.wipeLocalState(paths);

    // 2. Descobre as tabelas do banco remoto e exporta todas (menos internas/FTS).
    const tableList = tables.resolveTables(dbName);

    ui.log(`🚀 Exportando as tabelas do D1 de produção [Banco: ${dbName}]...`);
    wrangler.d1ExportRemote(dbName, tableList, paths.dumpFile);

    ui.log('🏗️  Reorganizando schema do dump para resolver dependências de Foreign Key...');
    fs.writeFileSync(paths.dumpFile, sql.reorderDump(fs.readFileSync(paths.dumpFile, 'utf-8')), 'utf-8');

    ui.log('\n📥 Importando o banco para o ambiente local...');
    wrangler.d1ImportLocal(dbName, paths.dumpFile);

    ui.log('✅ Banco de dados sincronizado com sucesso!');
    ui.log('🖼️  Buscando informações do site e lista de mídias...');

    // Busca a URL de produção na tabela options (o valor vem serializado).
    const urlRows = wrangler.d1Query(dbName, "SELECT value FROM options WHERE name = 'emdash:site_url'");
    if (urlRows.length === 0) {
      throw new Error('Não foi possível determinar a URL do projeto (emdash:site_url ausente na tabela options). Verifique se o banco remoto possui a URL configurada.');
    }
    const prodUrl = JSON.parse(urlRows[0].value);
    ui.log(`🌐 URL do projeto detectada: ${prodUrl}`);

    await media.syncMedia({ dbName, r2Bucket, prodUrl });

    ui.log('\n🎉 Sincronização 100% concluída! Ambiente local idêntico à produção.');
  } catch (error) {
    ui.fail(`\n❌ Erro durante a sincronização: ${error.message}`);
    exitCode = 1;
  } finally {
    // Sanitização de segurança: deleta o dump SQL gerado pelo export.
    if (fs.existsSync(paths.dumpFile)) {
      fs.rmSync(paths.dumpFile, { force: true });
      ui.log('\n🧹 [Sanitização] Arquivo temporário de dump SQL deletado com sucesso.');
    }
    if (exitCode !== 0) process.exitCode = exitCode;
  }
}

module.exports = { run };
