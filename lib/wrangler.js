'use strict';

const { execSync } = require('child_process');

// Envoltórios finos sobre o CLI do Wrangler. Ponto único de acesso a
// `wrangler` — os comandos remotos são estritamente read-only.

/** Executa um `wrangler d1 execute ... --json` e devolve as linhas do resultado. */
function d1Query(dbName, sql, { remote = false } = {}) {
  const scope = remote ? '--remote' : '--local';
  const output = execSync(
    `npx wrangler d1 execute ${dbName} ${scope} --json --command "${sql}"`,
    { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] },
  );
  const parsed = JSON.parse(output);
  const block = Array.isArray(parsed) ? parsed[0] : parsed;
  return (block && block.results) || [];
}

/** Exporta as tabelas do D1 remoto para um arquivo SQL (read-only). */
function d1ExportRemote(dbName, tables, outputFile) {
  const tableArgs = tables.map((table) => '--table=' + table).join(' ');
  execSync(`npx wrangler d1 export ${dbName} --remote ${tableArgs} --output=${outputFile}`, { stdio: 'inherit' });
}

/** Importa um arquivo SQL para o D1 local. */
function d1ImportLocal(dbName, file) {
  execSync(`npx wrangler d1 execute ${dbName} --local --file=${file}`, { stdio: 'inherit' });
}

/** Grava um objeto no bucket R2 local (emulador). */
function r2PutObject(bucket, key, file, contentType) {
  execSync(`npx wrangler r2 object put ${bucket}/${key} --file "${file}" --local --content-type "${contentType}"`, { stdio: ['ignore', 'ignore', 'ignore'] });
}

module.exports = { d1Query, d1ExportRemote, d1ImportLocal, r2PutObject };
