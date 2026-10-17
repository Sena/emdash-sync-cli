'use strict';

const fs = require('fs');
const path = require('path');

// =========================================================================
// 🔧 CONFIGURAÇÕES E DESCOBERTA DO PROJETO
// =========================================================================

/** Quantos backups locais manter (os mais recentes). Ver `--no-backup`. */
const BACKUP_KEEP = 3;

/** Porta padrão do dev server Astro/Vite, que precisa ser liberada. */
const DEV_SERVER_PORT = 4321;

/** Arquivos de configuração do Wrangler aceitos, em ordem de preferência. */
const WRANGLER_FILES = ['wrangler.toml', 'wrangler.json', 'wrangler.jsonc'];

/**
 * Descobre o banco D1 e o bucket R2 lendo dinamicamente o wrangler.toml,
 * wrangler.json ou wrangler.jsonc na raiz do projeto. Aceita formato TOML
 * (`database_name =`) e JSON (`"database_name":`).
 *
 * O CLI roda a partir do cache do npx, então os arquivos do projeto são sempre
 * resolvidos contra `process.cwd()` — nunca contra `__dirname`.
 *
 * @returns {{ dbName: string, r2Bucket: string, paths: Record<string, string> }}
 * @throws quando o arquivo não existe ou não define database_name/bucket_name.
 */
function loadProject() {
  const wranglerFile = WRANGLER_FILES
    .map((name) => path.join(process.cwd(), name))
    .find((file) => fs.existsSync(file));

  if (!wranglerFile) {
    throw new Error('Arquivo wrangler.toml, wrangler.json ou wrangler.jsonc não encontrado na raiz do projeto.');
  }

  const content = fs.readFileSync(wranglerFile, 'utf-8');
  const dbMatch = content.match(/(?:"|')?database_name(?:"|')?\s*[=:]\s*"([^"]+)"/);
  const r2Match = content.match(/(?:"|')?bucket_name(?:"|')?\s*[=:]\s*"([^"]+)"/);
  if (!dbMatch || !r2Match) {
    throw new Error('Não foi possível encontrar database_name ou bucket_name na configuração do wrangler');
  }

  return {
    dbName: dbMatch[1],
    r2Bucket: r2Match[1],
    paths: {
      // Caminhos relativos ao cwd do processo; o wrangler recebe os mesmos
      // valores nos comandos.
      dumpFile: 'tabela.sql',
      d1Dir: path.join('.wrangler', 'state', 'v3', 'd1'),
      r2Dir: path.join('.wrangler', 'state', 'v3', 'r2'),
      backupsDir: path.join('.wrangler', 'backups'),
    },
  };
}

module.exports = { BACKUP_KEEP, DEV_SERVER_PORT, loadProject };
